/**
 * Scheduled maintenance jobs.
 *
 * These implement the "self-healing" behaviour: routine drift is corrected
 * automatically and silently (Tier 1), anything that changes what gets sent is
 * reported (Tier 2), and anything that needs a decision stops and waits (Tier 3).
 *
 * The system never tries to evade a block. If a provider or inbox pushes back,
 * it pauses and asks — it does not route around the obstacle.
 */

import { db, sql, checkDatabaseConnection } from '@/db';
import {
  leads,
  emails,
  contacts,
  sendingInboxes,
  sendingDomains,
  systemHealth,
  organizations,
  aiUsage,
} from '@/db/schema';
import { and, eq, lte, isNotNull, sql as dsql } from 'drizzle-orm';
import { getJobQueue } from '@/lib/providers/queue';
import { getAiService } from '@/lib/providers/ai';
import { getEmailService } from '@/lib/providers/email';
import { getEnrichmentService } from '@/lib/providers/enrichment';
import { notifyHandled, notifyStopped, notifyAutoFixed } from '@/lib/notifications';
import { getBudgetStatus } from '@/lib/ai/budget';
import { warmupDailyLimit, WARMUP_FULL_DAYS } from '@/lib/sending/inbox-rotation';
import { syncSmartleadCampaign, refreshInboxCountersFromEmails } from '@/lib/smartlead/sync';
import { generateWeeklyInsights } from '@/lib/insights/weekly';
import { dripNewLeads } from '@/lib/sending/lead-drip';
import type { JobHandler } from '../types';

/**
 * check_follow_ups_due — enqueues follow-up DRAFTS for leads whose wait elapsed.
 * Drafts only; a human still approves each one.
 */
export const checkFollowUpsDueHandler: JobHandler = async (job) => {
  const queue = getJobQueue();

  const due = await db
    .select({ id: leads.id, organizationId: leads.organizationId })
    .from(leads)
    .where(
      and(
        isNotNull(leads.nextFollowUpAt),
        lte(leads.nextFollowUpAt, new Date()),
        dsql`${leads.status} IN ('contacted', 'follow_up_1_sent')`,
        eq(leads.requiresAttention, false),
      ),
    )
    .limit(100);

  let enqueued = 0;
  for (const lead of due) {
    const id = await queue.enqueue(
      'generate_follow_up',
      { leadId: lead.id },
      {
        organizationId: lead.organizationId,
        // One pending follow-up job per lead, ever — the key makes a duplicate
        // enqueue a no-op rather than a second AI charge.
        idempotencyKey: `follow_up:${lead.id}:${new Date().toISOString().slice(0, 10)}`,
      },
    );
    if (id) enqueued++;
  }

  return { checked: due.length, enqueued };
};

/**
 * health_check — probes every dependency, records status, and self-heals what
 * it safely can.
 */
export const healthCheckHandler: JobHandler = async (job) => {
  const results: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};

  results.database = await checkDatabaseConnection();

  try {
    results.ai = await getAiService().healthCheck();
  } catch (error) {
    results.ai = { ok: false, latencyMs: 0, error: String(error) };
  }

  try {
    results.email = await getEmailService().healthCheck();
  } catch (error) {
    results.email = { ok: false, latencyMs: 0, error: String(error) };
  }

  try {
    results.enrichment = await getEnrichmentService().healthCheck();
  } catch (error) {
    results.enrichment = { ok: false, latencyMs: 0, error: String(error) };
  }

  for (const [component, result] of Object.entries(results)) {
    await upsertHealth(component, result);
  }

  // Tier 1 self-heal: jobs whose worker died mid-run are released back to pending.
  const reclaimed = await getJobQueue().reclaimStalled(10 * 60 * 1000);
  if (reclaimed > 0 && job.organizationId) {
    await notifyAutoFixed(
      job.organizationId,
      'Stalled jobs recovered',
      `${reclaimed} job(s) were stuck on a worker that stopped responding. They have been returned to the queue and will run again automatically.`,
      { reclaimed },
    );
  }

  // Tier 3: a dependency that is genuinely down stops the relevant work.
  const failed = Object.entries(results).filter(([, r]) => !r.ok);
  if (failed.length > 0 && job.organizationId) {
    const [component, result] = failed[0]!;
    const [existing] = await db
      .select({ consecutiveFailures: systemHealth.consecutiveFailures })
      .from(systemHealth)
      .where(eq(systemHealth.component, component))
      .limit(1);

    // Alert on the second consecutive failure — one blip is not an incident.
    if ((existing?.consecutiveFailures ?? 0) >= 2) {
      await notifyStopped(
        job.organizationId,
        `${component} is not responding`,
        `Health checks for "${component}" have failed repeatedly.\n\nLast error: ${result.error ?? 'unknown'}\n\nWork that depends on it is paused until it recovers.`,
        {
          actionUrl: '/monitoring/health',
          actionLabel: 'Open system health',
          // The check runs every ten minutes; an outage should raise one alert a
          // day, not 144. A nine-day Smartlead outage produced 1,598 of these.
          dedupeKey: `health-down:${component}`,
          dedupeWindowHours: 24,
        },
      );
    }
  }

  return results;
};

async function upsertHealth(
  component: string,
  result: { ok: boolean; latencyMs: number; error?: string },
): Promise<void> {
  // Timestamps come from NOW() rather than a JS Date: the database clock is the
  // right authority for "when was this checked", and it keeps Date objects out
  // of the parameter list entirely.
  await sql`
    INSERT INTO system_health (component, status, last_checked_at, last_success_at,
                               last_failure_at, consecutive_failures, response_time_ms,
                               message, is_auto_fixable, updated_at)
    VALUES (
      ${component},
      ${result.ok ? 'operational' : 'down'}::health_status,
      NOW(),
      CASE WHEN ${result.ok} THEN NOW() ELSE NULL END,
      CASE WHEN ${result.ok} THEN NULL ELSE NOW() END,
      ${result.ok ? 0 : 1}, ${result.latencyMs}, ${result.error ?? null}, false, NOW()
    )
    ON CONFLICT (component) DO UPDATE SET
      status               = EXCLUDED.status,
      last_checked_at      = EXCLUDED.last_checked_at,
      last_success_at      = COALESCE(EXCLUDED.last_success_at, system_health.last_success_at),
      last_failure_at      = COALESCE(EXCLUDED.last_failure_at, system_health.last_failure_at),
      consecutive_failures = CASE WHEN ${result.ok} THEN 0
                                  ELSE system_health.consecutive_failures + 1 END,
      response_time_ms     = EXCLUDED.response_time_ms,
      message              = EXCLUDED.message,
      updated_at           = EXCLUDED.updated_at
  `;
}

/**
 * daily_digest — ramps warm-up limits, updates reputation, checks the budget,
 * and reports the day.
 */
export const dailyDigestHandler: JobHandler = async (job) => {
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('daily_digest requires an organizationId');

  const rampedInboxes = await rampWarmupLimits(organizationId);
  const reputationChanges = await updateReputationScores(organizationId);

  // Promote only as many new leads as today's sending capacity justifies, so a
  // large import is researched and drafted at the rate it can actually be sent
  // rather than all at once.
  let drip: Awaited<ReturnType<typeof dripNewLeads>> | null = null;
  try {
    drip = await dripNewLeads(organizationId);
  } catch (error) {
    console.error('[daily_digest] lead drip failed:', error);
  }

  // Weekly performance analysis rides on Monday's digest rather than owning a
  // job type of its own — same schedule guarantees, no enum migration.
  let weeklyInsights: string | null = null;
  if (new Date().getDay() === 1) {
    try {
      const report = await generateWeeklyInsights(organizationId, 7);
      weeklyInsights = report.analysis?.headline ?? 'Weekly report generated.';
      await notifyHandled(
        organizationId,
        'Weekly performance report ready',
        `${report.totals.sent} sent · ${report.totals.replied} replies (${report.totals.replyRate.toFixed(1)}%) in the last 7 days.\n\n` +
          `${report.analysis?.headline ?? ''}`,
        { actionUrl: '/insights', actionLabel: 'Open insights' },
      );
    } catch (error) {
      console.error('[daily_digest] weekly insights failed:', error);
    }
  }

  const budget = await getBudgetStatus(organizationId);
  if (budget.isExceeded) {
    await notifyStopped(
      organizationId,
      'AI budget exhausted',
      `$${budget.spent.toFixed(2)} of the $${budget.stopAt.toFixed(2)} monthly cap is used. ` +
        `AI operations are paused until the next billing period or until you raise the cap.`,
      { actionUrl: '/settings/ai', actionLabel: 'Adjust budget' },
    );
  } else if (budget.isWarning) {
    await notifyHandled(
      organizationId,
      `AI budget at ${budget.percentUsed.toFixed(0)}%`,
      `$${budget.spent.toFixed(2)} of $${budget.stopAt.toFixed(2)} used this month. ` +
        `$${budget.remaining.toFixed(2)} remaining before AI operations stop.`,
      { actionUrl: '/settings/ai', actionLabel: 'Review AI spend' },
    );
  }

  if (rampedInboxes.length > 0) {
    await notifyAutoFixed(
      organizationId,
      'Warm-up limits increased',
      rampedInboxes.map((i) => `${i.email}: ${i.from} → ${i.to}/day`).join('\n'),
      { inboxes: rampedInboxes },
    );
  }

  for (const change of reputationChanges) {
    if (change.paused) {
      await notifyStopped(
        organizationId,
        `Inbox paused: ${change.email}`,
        `Reputation dropped to ${change.score}/100 (bounce rate ${change.bounceRate.toFixed(1)}%). ` +
          `The inbox is paused to protect the sending domain. Review the bounces before resuming.`,
        { actionUrl: '/sending', actionLabel: 'Review inbox' },
      );
    }
  }

  return { rampedInboxes, reputationChanges, budget, weeklyInsights, drip };
};

/** Move each warming inbox onto its scheduled daily limit for today. */
async function rampWarmupLimits(
  organizationId: string,
): Promise<{ email: string; from: number; to: number }[]> {
  const inboxes = await db
    .select()
    .from(sendingInboxes)
    .where(
      and(
        eq(sendingInboxes.organizationId, organizationId),
        eq(sendingInboxes.warmupCompleted, false),
        isNotNull(sendingInboxes.warmupStartedAt),
      ),
    );

  const changes: { email: string; from: number; to: number }[] = [];

  for (const inbox of inboxes) {
    const target = warmupDailyLimit(inbox.warmupStartedAt, inbox.maxDailySendLimit, false);
    const daysElapsed = Math.floor(
      (Date.now() - inbox.warmupStartedAt!.getTime()) / (24 * 60 * 60 * 1000),
    );

    // Complete only once the full warm-up period has been served AND the ramp
    // has reached the maximum. Reaching the maximum alone happens by week three.
    const completed = target >= inbox.maxDailySendLimit && daysElapsed >= WARMUP_FULL_DAYS;

    // Nothing to raise and not newly complete: leave it. (Checking completion
    // before skipping matters — once the limit sits at the maximum, a skip-first
    // check would never mark the inbox complete at all.)
    if (target <= inbox.dailySendLimit && !completed) continue;

    await db
      .update(sendingInboxes)
      .set({
        dailySendLimit: Math.max(target, inbox.dailySendLimit),
        warmupCompleted: completed,
        status: completed ? 'active' : inbox.status,
        updatedAt: new Date(),
      })
      .where(eq(sendingInboxes.id, inbox.id));

    if (target > inbox.dailySendLimit) {
      changes.push({ email: inbox.emailAddress, from: inbox.dailySendLimit, to: target });
    }
  }

  // A domain becomes fully active once all of its inboxes finish warming.
  await sql`
    UPDATE sending_domains d
    SET status = 'active', warmup_completed = true, updated_at = NOW()
    WHERE d.organization_id = ${organizationId}
      AND d.status = 'warming'
      AND NOT EXISTS (
        SELECT 1 FROM sending_inboxes i
        WHERE i.domain_id = d.id AND i.warmup_completed = false
      )
  `;

  return changes;
}

/**
 * Recompute reputation from bounce and complaint rates, and pause any inbox
 * that has gone bad. Pausing is the correct response — continuing to send from
 * a damaged inbox harms every other inbox on the domain.
 */
async function updateReputationScores(organizationId: string): Promise<
  { email: string; score: number; bounceRate: number; paused: boolean }[]
> {
  const inboxes = await db
    .select()
    .from(sendingInboxes)
    .where(eq(sendingInboxes.organizationId, organizationId));

  const changes: { email: string; score: number; bounceRate: number; paused: boolean }[] = [];

  for (const inbox of inboxes) {
    if (inbox.totalSent < 20) continue; // too little data to judge

    const bounceRate = (inbox.totalBounced / inbox.totalSent) * 100;
    const complaintRate = (inbox.totalComplaints / inbox.totalSent) * 100;

    // Industry thresholds: >5% bounces or >0.3% complaints is trouble.
    let score = 100;
    score -= Math.min(60, bounceRate * 8);
    score -= Math.min(40, complaintRate * 100);
    score = Math.max(0, Math.round(score));

    const shouldPause = score < 40 || bounceRate > 8 || complaintRate > 0.5;
    const wasActive = inbox.status === 'active' || inbox.status === 'warming';

    await db
      .update(sendingInboxes)
      .set({
        reputationScore: score,
        ...(shouldPause && wasActive
          ? {
              status: 'paused' as const,
              pausedReason: `Reputation ${score}/100 · bounces ${bounceRate.toFixed(1)}% · complaints ${complaintRate.toFixed(2)}%`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(sendingInboxes.id, inbox.id));

    if (score !== inbox.reputationScore || (shouldPause && wasActive)) {
      changes.push({
        email: inbox.emailAddress,
        score,
        bounceRate,
        paused: shouldPause && wasActive,
      });
    }
  }

  return changes;
}

/**
 * sync_email_events — reconciles emails stuck in 'sending'.
 *
 * A send that never resolved is almost always a crash between the provider call
 * and the status write. Returning it to 'approved' lets it retry safely; the
 * provider deduplicates on its side.
 */
export const syncEmailEventsHandler: JobHandler = async (job) => {
  const organizationId = job.organizationId;
  if (!organizationId) return { recovered: 0 };

  const queue = getJobQueue();

  const stuck = await sql<{ id: string }[]>`
    UPDATE emails
    SET status = 'approved',
        failure_reason = 'Recovered: send did not complete, will retry',
        updated_at = NOW()
    WHERE organization_id = ${organizationId}
      AND status = 'sending'
      AND updated_at < NOW() - INTERVAL '15 minutes'
    RETURNING id
  `;

  if (stuck.length > 0) {
    for (const row of stuck) {
      await queue.enqueue('send_email', { emailId: row.id }, { organizationId, priority: 5 });
    }

    await notifyAutoFixed(
      organizationId,
      'Interrupted sends recovered',
      `${stuck.length} email(s) were interrupted mid-send and have been re-queued.`,
      { count: stuck.length },
    );
  }

  // Emails approved outside the send window are parked as 'queued' with a future
  // scheduledFor. Nothing else re-attempts them, so re-enqueue a send job once
  // their window has arrived — otherwise a deferred email would never send.
  const due = await sql<{ id: string }[]>`
    SELECT id FROM emails
    WHERE organization_id = ${organizationId}
      AND status = 'queued'
      AND approved_by IS NOT NULL
      AND (scheduled_for IS NULL OR scheduled_for <= NOW())
  `;

  if (due.length > 0) {
    const hourBucket = new Date().toISOString().slice(0, 13);
    for (const row of due) {
      // Per-hour key: a send job that re-defers (window still closed) won't pile
      // up duplicates, but each new hour gets a fresh attempt.
      await queue.enqueue(
        'send_email',
        { emailId: row.id },
        { organizationId, priority: 5, idempotencyKey: `send-due:${row.id}:${hourBucket}` },
      );
    }
  }

  // Pull Smartlead's own send/engagement data back in. This is what keeps the
  // dashboard current without depending on webhooks firing for relay sends, and
  // it backfills the real Message-IDs that reply threading needs.
  let smartlead: Awaited<ReturnType<typeof syncSmartleadCampaign>> | null = null;
  try {
    smartlead = await syncSmartleadCampaign(organizationId);
    await refreshInboxCountersFromEmails(organizationId);
  } catch (error) {
    // Never fail the whole maintenance pass because a third party was slow.
    console.error('[sync_email_events] Smartlead sync failed:', error);
  }

  return { recovered: stuck.length, requeuedDue: due.length, smartlead };
};
