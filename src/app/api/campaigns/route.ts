import { z } from 'zod';
import { db } from '@/db';
import { campaigns, leads } from '@/db/schema';
import { eq, desc, sql as dsql } from 'drizzle-orm';
import {
  requireAuth,
  requireWriteAccess,
  handleRoute,
  parseBody,
  audit,
} from '@/lib/api-helpers';

export async function GET() {
  return handleRoute(async () => {
    const ctx = await requireAuth();

    // Counts come from a grouped subquery rather than N queries so the page
    // stays one round-trip regardless of how many campaigns exist.
    const rows = await db
      .select({
        campaign: campaigns,
        leadCount: dsql<number>`COUNT(${leads.id})::int`,
        contactedCount: dsql<number>`COUNT(${leads.id}) FILTER (WHERE ${leads.firstContactedAt} IS NOT NULL)::int`,
        repliedCount: dsql<number>`COUNT(${leads.id}) FILTER (WHERE ${leads.repliedAt} IS NOT NULL)::int`,
        interestedCount: dsql<number>`COUNT(${leads.id}) FILTER (WHERE ${leads.status} = 'interested')::int`,
      })
      .from(campaigns)
      .leftJoin(leads, eq(leads.campaignId, campaigns.id))
      .where(eq(campaigns.organizationId, ctx.organizationId))
      .groupBy(campaigns.id)
      .orderBy(desc(campaigns.createdAt));

    return { campaigns: rows };
  });
}

const createSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  targetRole: z.string().max(255).optional(),
  targetIndustry: z.string().max(255).optional(),
  targetLocation: z.string().max(255).optional(),
  // Capped at 3 (four touches total). Beyond this, reply rates collapse while
  // spam complaints climb past the 0.3% that gets a domain filtered. Defaults
  // to 2 — the house standard — so a campaign created without thinking about
  // it matches the sequence the sending limits were planned around.
  maxFollowUps: z.number().int().min(0).max(3).default(2),
  followUp1DelayDays: z.number().int().min(1).max(60).default(4),
  followUp2DelayDays: z.number().int().min(1).max(60).default(7),
  dailySendLimit: z.number().int().min(1).max(1000).nullable().default(null),
  toneInstructions: z.string().max(2000).optional(),
  customPromptAdditions: z.string().max(4000).optional(),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const body = await parseBody(request, createSchema);

    const [created] = await db
      .insert(campaigns)
      .values({
        organizationId: ctx.organizationId,
        name: body.name,
        description: body.description ?? null,
        targetRole: body.targetRole ?? null,
        targetIndustry: body.targetIndustry ?? null,
        targetLocation: body.targetLocation ?? null,
        maxFollowUps: body.maxFollowUps,
        followUp1DelayDays: body.followUp1DelayDays,
        followUp2DelayDays: body.followUp2DelayDays,
        dailySendLimit: body.dailySendLimit,
        toneInstructions: body.toneInstructions ?? null,
        customPromptAdditions: body.customPromptAdditions ?? null,
        status: 'draft',
      })
      .returning();

    await audit({
      ctx,
      action: 'campaign.create',
      entityType: 'campaign',
      entityId: created!.id,
      metadata: { name: body.name },
      request,
    });

    return { campaign: created };
  });
}
