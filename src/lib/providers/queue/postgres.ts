/**
 * Postgres-backed job queue.
 *
 * Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED`, which is the standard way
 * to build a safe multi-consumer queue on Postgres: two workers polling at the
 * same instant get disjoint sets of rows, and nothing is processed twice.
 */

import { sql, db } from '@/db';
import { backgroundJobs, type JobType } from '@/db/schema';
import { and, eq, gte, sql as dsql } from 'drizzle-orm';
import type { JobQueue, EnqueueOptions, QueuedJob } from './types';

/** Exponential backoff with a 1h ceiling: 30s, 2m, 7.5m, 30m, 1h… */
function backoffMs(attempts: number): number {
  return Math.min(30_000 * Math.pow(2.5, attempts - 1), 3_600_000);
}

export class PostgresJobQueue implements JobQueue {
  readonly name = 'postgres';

  async enqueue<T extends Record<string, unknown>>(
    type: JobType,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    const rows = await db
      .insert(backgroundJobs)
      .values({
        type,
        payload,
        organizationId: options.organizationId ?? null,
        priority: options.priority ?? 0,
        runAt: options.runAt ?? new Date(),
        maxAttempts: options.maxAttempts ?? 3,
        idempotencyKey: options.idempotencyKey ?? null,
      })
      // Idempotency is enforced by a unique index, so a duplicate enqueue is a
      // no-op rather than an error the caller has to handle.
      .onConflictDoNothing({ target: backgroundJobs.idempotencyKey })
      .returning({ id: backgroundJobs.id });

    return rows[0]?.id ?? null;
  }

  async claim(workerId: string, limit: number): Promise<QueuedJob[]> {
    const rows = await sql<
      {
        id: string;
        organization_id: string | null;
        type: JobType;
        payload: Record<string, unknown>;
        attempts: number;
        max_attempts: number;
        created_at: Date;
      }[]
    >`
      UPDATE background_jobs
      SET status     = 'running',
          locked_at  = NOW(),
          locked_by  = ${workerId},
          started_at = NOW(),
          attempts   = attempts + 1,
          updated_at = NOW()
      WHERE id IN (
        SELECT id FROM background_jobs
        WHERE status = 'pending'
          AND run_at <= NOW()
        ORDER BY priority DESC, run_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, organization_id, type, payload, attempts, max_attempts, created_at
    `;

    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      type: r.type,
      payload: r.payload,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      createdAt: r.created_at,
    }));
  }

  async complete(jobId: string, result?: unknown): Promise<void> {
    await sql`
      UPDATE background_jobs
      SET status       = 'completed',
          completed_at = NOW(),
          duration_ms  = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000,
          result       = ${result === undefined ? null : JSON.stringify(result)}::jsonb,
          locked_at    = NULL,
          locked_by    = NULL,
          last_error   = NULL,
          updated_at   = NOW()
      WHERE id = ${jobId}
    `;
  }

  async fail(jobId: string, error: string, retryAfterMs?: number): Promise<void> {
    // A single statement decides retry-vs-dead so two workers can never race
    // into inconsistent states.
    await sql`
      UPDATE background_jobs
      SET status     = CASE WHEN attempts >= max_attempts THEN 'dead'::job_status
                            ELSE 'pending'::job_status END,
          run_at     = CASE WHEN attempts >= max_attempts THEN run_at
                            ELSE NOW() + (${
                              retryAfterMs ?? null
                            }::int * INTERVAL '1 millisecond') END,
          last_error   = ${error.slice(0, 2000)},
          locked_at    = NULL,
          locked_by    = NULL,
          completed_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE NULL END,
          updated_at   = NOW()
      WHERE id = ${jobId}
    `;

    // When the caller gave no explicit delay, apply the standard backoff curve.
    if (retryAfterMs === undefined) {
      const rows = await sql<{ attempts: number; status: string }[]>`
        SELECT attempts, status FROM background_jobs WHERE id = ${jobId}
      `;
      const row = rows[0];
      if (row && row.status === 'pending') {
        const delay = backoffMs(row.attempts);
        await sql`
          UPDATE background_jobs
          SET run_at = NOW() + (${delay}::int * INTERVAL '1 millisecond')
          WHERE id = ${jobId}
        `;
      }
    }
  }

  async reclaimStalled(olderThanMs: number): Promise<number> {
    const rows = await sql<{ id: string }[]>`
      UPDATE background_jobs
      SET status     = 'pending',
          locked_at  = NULL,
          locked_by  = NULL,
          last_error = COALESCE(last_error, 'Reclaimed after worker stalled'),
          updated_at = NOW()
      WHERE status = 'running'
        AND locked_at < NOW() - (${olderThanMs}::int * INTERVAL '1 millisecond')
      RETURNING id
    `;
    return rows.length;
  }

  async getStats(organizationId?: string) {
    const scope = organizationId ? eq(backgroundJobs.organizationId, organizationId) : undefined;
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [counts] = await db
      .select({
        pending: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'pending')::int`,
        running: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'running')::int`,
        failed: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'failed')::int`,
        dead: dsql<number>`COUNT(*) FILTER (WHERE ${backgroundJobs.status} = 'dead')::int`,
      })
      .from(backgroundJobs)
      .where(scope);

    const [completed] = await db
      .select({ count: dsql<number>`COUNT(*)::int` })
      .from(backgroundJobs)
      .where(
        scope
          ? and(scope, eq(backgroundJobs.status, 'completed'), gte(backgroundJobs.completedAt, dayAgo))
          : and(eq(backgroundJobs.status, 'completed'), gte(backgroundJobs.completedAt, dayAgo)),
      );

    return {
      pending: counts?.pending ?? 0,
      running: counts?.running ?? 0,
      failed: counts?.failed ?? 0,
      dead: counts?.dead ?? 0,
      completedLast24h: completed?.count ?? 0,
    };
  }
}
