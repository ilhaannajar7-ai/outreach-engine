/**
 * Background worker.
 *
 * Runs as a second container from the same image (`npm run worker`). Polls the
 * Postgres queue, executes handlers with bounded concurrency, and schedules the
 * recurring maintenance jobs.
 *
 * Shutdown is graceful: on SIGTERM it stops claiming new work and waits for
 * in-flight jobs, so a deploy never kills a half-sent email.
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { db, sql } from '@/db';
import { organizations } from '@/db/schema';
import { getJobQueue, type QueuedJob } from '@/lib/providers/queue';
import { env } from '@/lib/env';
import { isRetryable, retryDelayMs, type JobHandler } from './types';

import { researchHandler } from './handlers/research';
import { generateEmailHandler, generateFollowUpHandler } from './handlers/generate-email';
import { sendEmailHandler } from './handlers/send-email';
import { classifyReplyHandler } from './handlers/classify-reply';
import { findContactsHandler, verifyContactEmailHandler } from './handlers/enrich';
import { sourceLeadsHandler } from './handlers/source-leads';
import {
  checkFollowUpsDueHandler,
  healthCheckHandler,
  dailyDigestHandler,
  syncEmailEventsHandler,
} from './handlers/maintenance';

const WORKER_ID = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

const handlers: Partial<Record<string, JobHandler<never>>> = {
  research_company: researchHandler as JobHandler<never>,
  generate_email: generateEmailHandler as JobHandler<never>,
  generate_follow_up: generateFollowUpHandler as JobHandler<never>,
  send_email: sendEmailHandler as JobHandler<never>,
  classify_reply: classifyReplyHandler as JobHandler<never>,
  find_contacts: findContactsHandler as JobHandler<never>,
  verify_contact_email: verifyContactEmailHandler as JobHandler<never>,
  source_leads: sourceLeadsHandler as JobHandler<never>,
  check_follow_ups_due: checkFollowUpsDueHandler as JobHandler<never>,
  health_check: healthCheckHandler as JobHandler<never>,
  daily_digest: dailyDigestHandler as JobHandler<never>,
  sync_email_events: syncEmailEventsHandler as JobHandler<never>,
};

let shuttingDown = false;
let inFlight = 0;

function log(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const line = `[${new Date().toISOString()}] [${WORKER_ID}] ${message}`;
  if (level === 'error') console.error(line, meta ?? '');
  else if (level === 'warn') console.warn(line, meta ?? '');
  else console.log(line, meta ?? '');
}

async function runJob(job: QueuedJob): Promise<void> {
  const queue = getJobQueue();
  const handler = handlers[job.type];

  if (!handler) {
    log('error', `No handler registered for job type "${job.type}"`);
    await queue.fail(job.id, `No handler registered for job type "${job.type}"`);
    return;
  }

  const started = Date.now();
  log('info', `▶ ${job.type} (${job.id.slice(0, 8)}) attempt ${job.attempts}/${job.maxAttempts}`);

  try {
    const result = await (handler as JobHandler)(job);
    await queue.complete(job.id, result);
    log('info', `✔ ${job.type} (${job.id.slice(0, 8)}) in ${Date.now() - started}ms`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isRetryable(error)) {
      await queue.fail(job.id, message, retryDelayMs(error));
      log('warn', `↻ ${job.type} (${job.id.slice(0, 8)}) retryable: ${message}`);
      return;
    }

    // Non-retryable: burn the remaining attempts so it goes straight to dead
    // rather than repeating a failure that cannot succeed.
    await sql`
      UPDATE background_jobs
      SET attempts = max_attempts
      WHERE id = ${job.id}
    `;
    await queue.fail(job.id, message);
    log('error', `✘ ${job.type} (${job.id.slice(0, 8)}) failed: ${message}`);
  }
}

async function tick(): Promise<void> {
  if (shuttingDown) return;

  const queue = getJobQueue();
  const capacity = env.WORKER_CONCURRENCY - inFlight;
  if (capacity <= 0) return;

  const jobs = await queue.claim(WORKER_ID, capacity);
  if (jobs.length === 0) return;

  for (const job of jobs) {
    inFlight++;
    void runJob(job).finally(() => {
      inFlight--;
    });
  }
}

/**
 * Recurring jobs. Each uses a time-bucketed idempotency key, so the schedule is
 * enforced by the unique index rather than by an in-memory timer — two workers
 * cannot double-schedule, and a restart cannot skip a slot.
 */
async function scheduleRecurringJobs(): Promise<void> {
  const queue = getJobQueue();
  const now = new Date();
  const hourBucket = now.toISOString().slice(0, 13);
  const dayBucket = now.toISOString().slice(0, 10);
  const tenMinBucket = `${hourBucket}:${Math.floor(now.getMinutes() / 10)}`;

  const orgs = await db.select({ id: organizations.id }).from(organizations);

  for (const org of orgs) {
    await queue.enqueue(
      'health_check',
      {},
      { organizationId: org.id, idempotencyKey: `health:${org.id}:${tenMinBucket}` },
    );

    await queue.enqueue(
      'check_follow_ups_due',
      {},
      { organizationId: org.id, idempotencyKey: `followups:${org.id}:${hourBucket}` },
    );

    await queue.enqueue(
      'sync_email_events',
      {},
      { organizationId: org.id, idempotencyKey: `sync:${org.id}:${hourBucket}` },
    );

    // Source new leads once a day at 07:00, ahead of the send window, so
    // discovery/research/drafting has finished before anyone opens the queue.
    // The handler is a no-op unless the org has enabled auto-sourcing.
    if (now.getHours() === 7) {
      await queue.enqueue(
        'source_leads',
        {},
        { organizationId: org.id, idempotencyKey: `source:${org.id}:${dayBucket}` },
      );
    }

    // Daily digest at 08:00 local.
    if (now.getHours() === 8) {
      await queue.enqueue(
        'daily_digest',
        {},
        { organizationId: org.id, idempotencyKey: `digest:${org.id}:${dayBucket}` },
      );
    }
  }
}

/** Keep completed/dead job rows from growing without bound. */
async function pruneOldJobs(): Promise<void> {
  await sql`
    DELETE FROM background_jobs
    WHERE status IN ('completed', 'cancelled')
      AND completed_at < NOW() - INTERVAL '7 days'
  `;
  await sql`
    DELETE FROM background_jobs
    WHERE status = 'dead'
      AND completed_at < NOW() - INTERVAL '30 days'
  `;
}

async function main(): Promise<void> {
  log('info', `Worker starting · concurrency=${env.WORKER_CONCURRENCY} · poll=${env.WORKER_POLL_INTERVAL_MS}ms`);

  // Anything left 'running' by a previous crash is ours to release.
  const reclaimed = await getJobQueue().reclaimStalled(10 * 60 * 1000);
  if (reclaimed > 0) log('warn', `Reclaimed ${reclaimed} stalled job(s) from a previous run`);

  const pollTimer = setInterval(() => {
    void tick().catch((error) => log('error', 'Poll tick failed', error));
  }, env.WORKER_POLL_INTERVAL_MS);

  const scheduleTimer = setInterval(
    () => {
      void scheduleRecurringJobs().catch((error) =>
        log('error', 'Failed to schedule recurring jobs', error),
      );
    },
    5 * 60 * 1000,
  );

  const pruneTimer = setInterval(
    () => {
      void pruneOldJobs().catch((error) => log('error', 'Failed to prune old jobs', error));
    },
    60 * 60 * 1000,
  );

  await scheduleRecurringJobs().catch((error) =>
    log('error', 'Initial recurring-job schedule failed', error),
  );

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `${signal} received — finishing ${inFlight} in-flight job(s)…`);

    clearInterval(pollTimer);
    clearInterval(scheduleTimer);
    clearInterval(pruneTimer);

    const deadline = Date.now() + 30_000;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }

    if (inFlight > 0) {
      log('warn', `${inFlight} job(s) still running at shutdown — they will be reclaimed`);
    }

    await sql.end({ timeout: 5 });
    log('info', 'Worker stopped.');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log('error', 'Unhandled promise rejection', reason);
  });

  log('info', 'Worker ready.');
}

main().catch((error) => {
  log('error', 'Worker failed to start', error);
  process.exit(1);
});
