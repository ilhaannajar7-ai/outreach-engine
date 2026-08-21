import { z } from 'zod';
import { db } from '@/db';
import { sendingDomains, sendingInboxes } from '@/db/schema';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { checkAllDns } from '@/lib/sending/dns-check';
import { requireAdmin, handleRoute, parseBody, audit, ApiError } from '@/lib/api-helpers';

type Params = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  status: z.enum(['pending_dns', 'warming', 'active', 'paused', 'suspended']).optional(),
  dailySendLimit: z.number().int().min(0).max(1000).optional(),
  maxDailySendLimit: z.number().int().min(1).max(1000).optional(),
  startWarmup: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const { id } = await params;
    const body = await parseBody(request, updateSchema);

    const [domain] = await db
      .select()
      .from(sendingDomains)
      .where(and(eq(sendingDomains.id, id), eq(sendingDomains.organizationId, ctx.organizationId)))
      .limit(1);

    if (!domain) throw new ApiError(404, 'Domain not found', 'NOT_FOUND');

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.startWarmup) {
      // Warming a domain whose DNS is wrong is how domains get blacklisted.
      if (domain.spfStatus !== 'pass' || domain.dkimStatus !== 'pass') {
        throw new ApiError(
          400,
          'SPF and DKIM must pass before warm-up can start. Re-check DNS from this page.',
          'DNS_NOT_READY',
        );
      }
      updates.warmupStartedAt = domain.warmupStartedAt ?? new Date();
      updates.status = 'warming';
      updates.warmupCompleted = false;
    }

    if (body.status) updates.status = body.status;
    if (body.dailySendLimit !== undefined) updates.dailySendLimit = body.dailySendLimit;
    if (body.maxDailySendLimit !== undefined) updates.maxDailySendLimit = body.maxDailySendLimit;
    if (body.notes !== undefined) updates.notes = body.notes;

    const [updated] = await db
      .update(sendingDomains)
      .set(updates)
      .where(eq(sendingDomains.id, id))
      .returning();

    // Pausing a domain must pause its inboxes too, or sends keep going out.
    if (body.status === 'paused' || body.status === 'suspended') {
      await db
        .update(sendingInboxes)
        .set({
          status: 'paused',
          pausedReason: `Domain ${domain.domain} was ${body.status}`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(sendingInboxes.domainId, id), dsql`${sendingInboxes.status} IN ('active','warming')`),
        );
    }

    await audit({
      ctx,
      action: 'domain.update',
      entityType: 'sending_domain',
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

    const [domain] = await db
      .select()
      .from(sendingDomains)
      .where(and(eq(sendingDomains.id, id), eq(sendingDomains.organizationId, ctx.organizationId)))
      .limit(1);

    if (!domain) throw new ApiError(404, 'Domain not found', 'NOT_FOUND');

    const [inboxCount] = await db
      .select({ count: dsql<number>`COUNT(*)::int` })
      .from(sendingInboxes)
      .where(eq(sendingInboxes.domainId, id));

    // Deleting would cascade to inboxes and orphan the send history attached to
    // them. Pausing is almost always what was actually meant.
    if ((inboxCount?.count ?? 0) > 0) {
      throw new ApiError(
        409,
        `${domain.domain} still has ${inboxCount!.count} inbox(es). Remove them first, or pause the domain instead of deleting it.`,
        'HAS_INBOXES',
      );
    }

    await db.delete(sendingDomains).where(eq(sendingDomains.id, id));

    await audit({
      ctx,
      action: 'domain.delete',
      entityType: 'sending_domain',
      entityId: id,
      metadata: { domain: domain.domain },
      request,
    });

    return { deleted: true };
  });
}
