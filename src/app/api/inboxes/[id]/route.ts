import { z } from 'zod';
import { db } from '@/db';
import { sendingInboxes } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireAdmin, handleRoute, parseBody, audit, ApiError } from '@/lib/api-helpers';

type Params = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  status: z.enum(['pending_setup', 'warming', 'active', 'paused', 'blocked']).optional(),
  displayName: z.string().min(1).max(255).optional(),
  replyToAddress: z.string().email().max(320).nullable().optional(),
  dailySendLimit: z.number().int().min(0).max(500).optional(),
  maxDailySendLimit: z.number().int().min(1).max(500).optional(),
  provider: z.enum(['resend', 'smartlead', 'smtp', 'console']).optional(),
  providerInboxId: z.string().max(255).nullable().optional(),
  /** Skip the remaining ramp. Only sensible for an already-established mailbox. */
  completeWarmup: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const { id } = await params;
    const body = await parseBody(request, updateSchema);

    const [inbox] = await db
      .select()
      .from(sendingInboxes)
      .where(and(eq(sendingInboxes.id, id), eq(sendingInboxes.organizationId, ctx.organizationId)))
      .limit(1);

    if (!inbox) throw new ApiError(404, 'Inbox not found', 'NOT_FOUND');

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.displayName !== undefined) updates.displayName = body.displayName;
    if (body.replyToAddress !== undefined) updates.replyToAddress = body.replyToAddress;
    if (body.maxDailySendLimit !== undefined) updates.maxDailySendLimit = body.maxDailySendLimit;
    if (body.provider !== undefined) updates.provider = body.provider;
    if (body.providerInboxId !== undefined) updates.providerInboxId = body.providerInboxId;

    if (body.dailySendLimit !== undefined) {
      // The warm-up schedule exists to protect the domain; letting the UI raise
      // the cap past today's ramp target would defeat it.
      if (!inbox.warmupCompleted && body.dailySendLimit > inbox.dailySendLimit) {
        throw new ApiError(
          400,
          'This inbox is still warming up. Its daily limit increases automatically each week — raising it manually risks the domain.',
          'WARMUP_IN_PROGRESS',
        );
      }
      updates.dailySendLimit = body.dailySendLimit;
    }

    if (body.completeWarmup) {
      updates.warmupCompleted = true;
      updates.dailySendLimit = inbox.maxDailySendLimit;
      updates.status = 'active';
    }

    if (body.status) {
      updates.status = body.status;
      if (body.status === 'paused') {
        updates.pausedReason = 'Paused manually';
      } else if (body.status === 'active' || body.status === 'warming') {
        updates.pausedReason = null;
      }
    }

    const [updated] = await db
      .update(sendingInboxes)
      .set(updates)
      .where(eq(sendingInboxes.id, id))
      .returning();

    await audit({
      ctx,
      action: 'inbox.update',
      entityType: 'sending_inbox',
      entityId: id,
      changes: body,
      request,
    });

    return updated;
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const { id } = await params;

    const [inbox] = await db
      .select()
      .from(sendingInboxes)
      .where(and(eq(sendingInboxes.id, id), eq(sendingInboxes.organizationId, ctx.organizationId)))
      .limit(1);

    if (!inbox) throw new ApiError(404, 'Inbox not found', 'NOT_FOUND');

    // Sent emails reference the inbox; deleting it would sever that history.
    // Blocking is the reversible equivalent and keeps the audit trail intact.
    if (inbox.totalSent > 0) {
      await db
        .update(sendingInboxes)
        .set({
          status: 'blocked',
          pausedReason: 'Retired by an administrator',
          updatedAt: new Date(),
        })
        .where(eq(sendingInboxes.id, id));

      await audit({
        ctx,
        action: 'inbox.retire',
        entityType: 'sending_inbox',
        entityId: id,
        metadata: { emailAddress: inbox.emailAddress, totalSent: inbox.totalSent },
        request,
      });

      return {
        retired: true,
        message: `${inbox.emailAddress} has sent ${inbox.totalSent} emails, so it was retired rather than deleted. Its history stays intact and it will never be selected for sending again.`,
      };
    }

    await db.delete(sendingInboxes).where(eq(sendingInboxes.id, id));

    await audit({
      ctx,
      action: 'inbox.delete',
      entityType: 'sending_inbox',
      entityId: id,
      metadata: { emailAddress: inbox.emailAddress },
      request,
    });

    return { deleted: true };
  });
}
