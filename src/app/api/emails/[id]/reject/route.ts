import { z } from 'zod';
import { db } from '@/db';
import { emails, leads } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireWriteAccess, handleRoute, parseBody, audit, ApiError } from '@/lib/api-helpers';

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  reason: z.string().max(1000).optional(),
  /** Also stop all future outreach to this lead. */
  closeLead: z.boolean().default(false),
});

export async function POST(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { id } = await params;
    const body = await parseBody(request, bodySchema);

    const [email] = await db
      .select()
      .from(emails)
      .where(and(eq(emails.id, id), eq(emails.organizationId, ctx.organizationId)))
      .limit(1);

    if (!email) throw new ApiError(404, 'Email not found', 'NOT_FOUND');

    if (email.status === 'sent' || email.status === 'delivered') {
      throw new ApiError(409, 'This email has already been sent.', 'ALREADY_SENT');
    }

    const now = new Date();

    const [updated] = await db
      .update(emails)
      .set({
        status: 'rejected',
        rejectedBy: ctx.userId,
        rejectedAt: now,
        rejectionReason: body.reason ?? null,
        updatedAt: now,
      })
      .where(eq(emails.id, id))
      .returning();

    // A rejected draft returns the lead to its pre-generation state so a new
    // draft can be generated, unless the user chose to close the lead outright.
    await db
      .update(leads)
      .set({
        status: body.closeLead ? 'closed' : 'researched',
        requiresAttention: false,
        attentionReason: null,
        ...(body.closeLead ? { nextFollowUpAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(leads.id, email.leadId));

    await audit({
      ctx,
      action: 'email.reject',
      entityType: 'email',
      entityId: id,
      metadata: { reason: body.reason, closeLead: body.closeLead },
      request,
    });

    return { email: updated };
  });
}
