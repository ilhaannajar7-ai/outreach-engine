import { db, sql } from '@/db';
import { backgroundJobs } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireWriteAccess, handleRoute, audit, ApiError } from '@/lib/api-helpers';

type Params = { params: Promise<{ id: string }> };

/**
 * Re-queue a dead job.
 *
 * Attempts reset to zero so the job gets a full set of retries again — a job
 * usually dies because of a condition the operator has since fixed (a key, a
 * budget, a provider outage), not because it can never succeed.
 */
export async function POST(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { id } = await params;

    const [job] = await db
      .select()
      .from(backgroundJobs)
      .where(
        and(eq(backgroundJobs.id, id), eq(backgroundJobs.organizationId, ctx.organizationId)),
      )
      .limit(1);

    if (!job) throw new ApiError(404, 'Job not found', 'NOT_FOUND');

    if (job.status !== 'dead' && job.status !== 'failed') {
      throw new ApiError(
        409,
        `This job is "${job.status}" — only dead or failed jobs can be retried.`,
        'INVALID_STATUS',
      );
    }

    await sql`
      UPDATE background_jobs
      SET status       = 'pending',
          attempts     = 0,
          run_at       = NOW(),
          locked_at    = NULL,
          locked_by    = NULL,
          started_at   = NULL,
          completed_at = NULL,
          last_error   = NULL,
          updated_at   = NOW()
      WHERE id = ${id}
    `;

    await audit({
      ctx,
      action: 'job.retry',
      entityType: 'background_job',
      entityId: id,
      metadata: { type: job.type, previousError: job.lastError },
      request,
    });

    return { requeued: true, message: 'Job re-queued. The worker picks it up within a few seconds.' };
  });
}
