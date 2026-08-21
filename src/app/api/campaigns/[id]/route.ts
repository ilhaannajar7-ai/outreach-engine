import { z } from 'zod';
import { db } from '@/db';
import { campaigns, leads } from '@/db/schema';
import { and, eq, sql as dsql } from 'drizzle-orm';
import {
  requireWriteAccess,
  handleRoute,
  parseBody,
  audit,
  ApiError,
} from '@/lib/api-helpers';

type Params = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
  targetRole: z.string().max(255).nullable().optional(),
  targetIndustry: z.string().max(255).nullable().optional(),
  targetLocation: z.string().max(255).nullable().optional(),
  maxFollowUps: z.number().int().min(0).max(3).optional(),
  followUp1DelayDays: z.number().int().min(1).max(60).optional(),
  followUp2DelayDays: z.number().int().min(1).max(60).optional(),
  dailySendLimit: z.number().int().min(1).max(1000).nullable().optional(),
  toneInstructions: z.string().max(2000).nullable().optional(),
  customPromptAdditions: z.string().max(4000).nullable().optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { id } = await params;
    const body = await parseBody(request, updateSchema);

    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId)))
      .limit(1);

    if (!campaign) throw new ApiError(404, 'Campaign not found', 'NOT_FOUND');

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) updates[key] = value;
    }

    // Record when a campaign first goes live and when it finishes, so the
    // dashboard can show real durations rather than guessing from row age.
    if (body.status === 'active' && !campaign.startedAt) updates.startedAt = new Date();
    if (body.status === 'completed' && !campaign.completedAt) updates.completedAt = new Date();

    const [updated] = await db
      .update(campaigns)
      .set(updates)
      .where(eq(campaigns.id, id))
      .returning();

    // Pausing must also stop scheduled follow-ups, or drafts keep appearing in
    // the approval queue for a campaign the user believes is stopped.
    if (body.status === 'paused' || body.status === 'archived') {
      await db
        .update(leads)
        .set({ nextFollowUpAt: null, updatedAt: new Date() })
        .where(eq(leads.campaignId, id));
    }

    await audit({
      ctx,
      action: 'campaign.update',
      entityType: 'campaign',
      entityId: id,
      changes: body,
      request,
    });

    return updated;
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { id } = await params;

    const [campaign] = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId)))
      .limit(1);

    if (!campaign) throw new ApiError(404, 'Campaign not found', 'NOT_FOUND');

    const [countRow] = await db
      .select({ count: dsql<number>`COUNT(*)::int` })
      .from(leads)
      .where(eq(leads.campaignId, id));

    // Leads survive campaign deletion (the FK is ON DELETE SET NULL), but
    // silently orphaning hundreds of leads is rarely what someone means.
    if ((countRow?.count ?? 0) > 0) {
      throw new ApiError(
        409,
        `This campaign has ${countRow!.count} lead(s). Archive it instead — deleting would detach them all.`,
        'HAS_LEADS',
      );
    }

    await db.delete(campaigns).where(eq(campaigns.id, id));

    await audit({
      ctx,
      action: 'campaign.delete',
      entityType: 'campaign',
      entityId: id,
      metadata: { name: campaign.name },
      request,
    });

    return { deleted: true };
  });
}
