import { z } from 'zod';
import { db } from '@/db';
import { emails, leads, contacts } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getJobQueue } from '@/lib/providers/queue';
import { isVerificationRequired, UNVERIFIED_MESSAGE } from '@/lib/sending/verification';
import {
  requireWriteAccess,
  handleRoute,
  parseOptionalBody,
  audit,
  ApiError,
} from '@/lib/api-helpers';

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  // Edits made in the review pane are saved as part of the approval.
  subject: z.string().min(1).max(200).optional(),
  bodyText: z.string().min(1).optional(),
  scheduledFor: z.string().datetime().optional(),
});

/**
 * Approve a draft and queue it for sending.
 *
 * This is the human gate. `approvedBy` is written here and nowhere else, and the
 * send handler refuses any email that lacks it.
 */
export async function POST(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { id } = await params;
    const body = await parseOptionalBody(request, bodySchema);

    const [row] = await db
      .select({ email: emails, lead: leads, contact: contacts })
      .from(emails)
      .innerJoin(leads, eq(emails.leadId, leads.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .where(and(eq(emails.id, id), eq(emails.organizationId, ctx.organizationId)))
      .limit(1);

    if (!row) throw new ApiError(404, 'Email not found', 'NOT_FOUND');

    if (row.email.status !== 'pending_approval' && row.email.status !== 'draft') {
      throw new ApiError(
        409,
        `This email is "${row.email.status}" and can no longer be approved.`,
        'INVALID_STATUS',
      );
    }

    if (row.contact.isUnsubscribed || row.contact.isSuppressed) {
      throw new ApiError(
        409,
        'That contact has unsubscribed or is suppressed. This draft cannot be sent.',
        'CONTACT_SUPPRESSED',
      );
    }

    if (!row.contact.emailVerified && (await isVerificationRequired(ctx.organizationId))) {
      throw new ApiError(409, UNVERIFIED_MESSAGE, 'EMAIL_NOT_VERIFIED');
    }

    const edited =
      (body.subject !== undefined && body.subject !== row.email.subject) ||
      (body.bodyText !== undefined && body.bodyText !== row.email.bodyText);

    const now = new Date();

    const [updated] = await db
      .update(emails)
      .set({
        subject: body.subject ?? row.email.subject,
        bodyText: body.bodyText ?? row.email.bodyText,
        wasEditedByHuman: row.email.wasEditedByHuman || edited,
        status: 'approved',
        approvedBy: ctx.userId,
        approvedAt: now,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: null,
        scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
        updatedAt: now,
      })
      .where(eq(emails.id, id))
      .returning();

    const jobId = await getJobQueue().enqueue(
      'send_email',
      { emailId: id },
      {
        organizationId: ctx.organizationId,
        priority: 20,
        ...(body.scheduledFor ? { runAt: new Date(body.scheduledFor) } : {}),
        idempotencyKey: `send:${id}`,
      },
    );

    await db
      .update(leads)
      .set({ requiresAttention: false, attentionReason: null, updatedAt: now })
      .where(eq(leads.id, row.email.leadId));

    await audit({
      ctx,
      action: 'email.approve',
      entityType: 'email',
      entityId: id,
      metadata: { edited, jobId, to: row.email.toAddress },
      request,
    });

    return { email: updated, jobId, edited };
  });
}
