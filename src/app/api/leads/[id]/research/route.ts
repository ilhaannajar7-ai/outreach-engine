import { z } from 'zod';
import { db } from '@/db';
import { leads } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getJobQueue } from '@/lib/providers/queue';
import { getBudgetStatus } from '@/lib/ai/budget';
import {
  requireWriteAccess,
  handleRoute,
  parseOptionalBody,
  audit,
  ApiError,
} from '@/lib/api-helpers';

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ force: z.boolean().default(false) });

/** Queue a research job for this lead's company. */
export async function POST(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { id } = await params;
    const body = await parseOptionalBody(request, bodySchema);

    const [lead] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, id), eq(leads.organizationId, ctx.organizationId)))
      .limit(1);

    if (!lead) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');

    // Refuse before queuing rather than letting the job fail — the user gets an
    // immediate, actionable answer instead of a silent dead job.
    const budget = await getBudgetStatus(ctx.organizationId);
    if (budget.isExceeded) {
      throw new ApiError(
        409,
        `Monthly AI budget reached ($${budget.spent.toFixed(2)} of $${budget.stopAt.toFixed(2)}). ` +
          `Raise the limit in Settings → AI Configuration to continue.`,
        'BudgetExceededError',
      );
    }

    const jobId = await getJobQueue().enqueue(
      'research_company',
      { companyId: lead.companyId, leadId: lead.id, force: body.force },
      {
        organizationId: ctx.organizationId,
        priority: 10,
        // One research job per company per day unless forced.
        idempotencyKey: body.force
          ? undefined
          : `research:${lead.companyId}:${new Date().toISOString().slice(0, 10)}`,
      },
    );

    await audit({
      ctx,
      action: 'lead.research',
      entityType: 'lead',
      entityId: id,
      metadata: { jobId, force: body.force },
      request,
    });

    return {
      queued: jobId !== null,
      jobId,
      message: jobId
        ? 'Research queued. The brief appears here in under a minute.'
        : 'Research is already queued for this company today.',
    };
  });
}
