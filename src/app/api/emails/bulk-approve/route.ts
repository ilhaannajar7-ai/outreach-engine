import { z } from 'zod';
import { db } from '@/db';
import { emails, leads, contacts } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { getJobQueue } from '@/lib/providers/queue';
import { getRemainingCapacityToday } from '@/lib/sending/inbox-rotation';
import { isVerificationRequired } from '@/lib/sending/verification';
import { requireWriteAccess, handleRoute, parseBody, audit } from '@/lib/api-helpers';

const bodySchema = z.object({
  emailIds: z.array(z.string().uuid()).min(1).max(200),
});

/**
 * Batch approval — the mechanism that keeps daily review to ~10 minutes.
 *
 * Each email is still checked individually: suppressed contacts and
 * already-processed drafts are skipped and reported rather than silently sent.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { emailIds } = await parseBody(request, bodySchema);

    const rows = await db
      .select({ email: emails, contact: contacts })
      .from(emails)
      .innerJoin(leads, eq(emails.leadId, leads.id))
      .innerJoin(contacts, eq(leads.contactId, contacts.id))
      .where(and(eq(emails.organizationId, ctx.organizationId), inArray(emails.id, emailIds)));

    const queue = getJobQueue();
    const now = new Date();

    const approved: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const verificationRequired = await isVerificationRequired(ctx.organizationId);

    for (const { email, contact } of rows) {
      // Left in the queue rather than rejected: once verification completes it
      // can be approved normally.
      if (verificationRequired && !contact.emailVerified) {
        skipped.push({ id: email.id, reason: 'Address not verified yet' });
        continue;
      }

      if (email.status !== 'pending_approval' && email.status !== 'draft') {
        skipped.push({ id: email.id, reason: `Status is "${email.status}"` });
        continue;
      }
      if (contact.isUnsubscribed || contact.isSuppressed) {
        skipped.push({ id: email.id, reason: 'Contact unsubscribed or suppressed' });
        // Reject rather than leave it sitting in the queue forever.
        await db
          .update(emails)
          .set({
            status: 'rejected',
            rejectionReason: 'Contact unsubscribed or suppressed',
            updatedAt: now,
          })
          .where(eq(emails.id, email.id));
        continue;
      }

      await db
        .update(emails)
        .set({ status: 'approved', approvedBy: ctx.userId, approvedAt: now, updatedAt: now })
        .where(eq(emails.id, email.id));

      await queue.enqueue(
        'send_email',
        { emailId: email.id },
        { organizationId: ctx.organizationId, priority: 20, idempotencyKey: `send:${email.id}` },
      );

      approved.push(email.id);
    }

    const missing = emailIds.filter((id) => !rows.some((r) => r.email.id === id));
    for (const id of missing) skipped.push({ id, reason: 'Not found' });

    if (approved.length > 0) {
      await db
        .update(leads)
        .set({ requiresAttention: false, attentionReason: null, updatedAt: now })
        .where(
          inArray(
            leads.id,
            rows.filter((r) => approved.includes(r.email.id)).map((r) => r.email.leadId),
          ),
        );
    }

    // Approving more than today's capacity is fine — the surplus is queued and
    // sent tomorrow — but the user should know that is what will happen.
    const capacity = await getRemainingCapacityToday(ctx.organizationId);

    await audit({
      ctx,
      action: 'email.bulk_approve',
      entityType: 'email',
      metadata: { approvedCount: approved.length, skippedCount: skipped.length },
      request,
    });

    return {
      approved: approved.length,
      skipped,
      capacityToday: capacity.remaining,
      willSendToday: Math.min(approved.length, capacity.remaining),
      willSendLater: Math.max(0, approved.length - capacity.remaining),
    };
  });
}
