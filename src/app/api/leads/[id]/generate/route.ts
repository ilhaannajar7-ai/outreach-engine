import { db } from '@/db';
import { leads, contacts } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getJobQueue } from '@/lib/providers/queue';
import { getBudgetStatus } from '@/lib/ai/budget';
import { requireWriteAccess, handleRoute, audit, ApiError } from '@/lib/api-helpers';

type Params = { params: Promise<{ id: string }> };

/** Queue email generation. Produces a draft for approval — never sends. */
export async function POST(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { id } = await params;

    const [row] = await db
      .select({ lead: leads, contact: contacts })
      .from(leads)
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .where(and(eq(leads.id, id), eq(leads.organizationId, ctx.organizationId)))
      .limit(1);

    if (!row) throw new ApiError(404, 'Lead not found', 'NOT_FOUND');

    if (!row.lead.researchId) {
      throw new ApiError(
        400,
        'This lead has no research brief yet. Run research first — the email quality depends on it.',
        'NO_RESEARCH',
      );
    }

    if (row.contact.isUnsubscribed || row.contact.isSuppressed) {
      throw new ApiError(
        409,
        'This contact has unsubscribed or is suppressed. No further email can be generated.',
        'CONTACT_SUPPRESSED',
      );
    }

    const budget = await getBudgetStatus(ctx.organizationId);
    if (budget.isExceeded) {
      throw new ApiError(
        409,
        `Monthly AI budget reached ($${budget.spent.toFixed(2)} of $${budget.stopAt.toFixed(2)}).`,
        'BudgetExceededError',
      );
    }

    const jobId = await getJobQueue().enqueue(
      'generate_email',
      { leadId: id },
      {
        organizationId: ctx.organizationId,
        priority: 10,
        idempotencyKey: `generate:${id}:${new Date().toISOString().slice(0, 10)}`,
      },
    );

    await audit({
      ctx,
      action: 'lead.generate_email',
      entityType: 'lead',
      entityId: id,
      metadata: { jobId },
      request,
    });

    return {
      queued: jobId !== null,
      jobId,
      message: jobId
        ? 'Email generation queued. The draft appears in the approval queue shortly.'
        : 'An email has already been generated for this lead today.',
    };
  });
}
