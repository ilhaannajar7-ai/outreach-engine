import { z } from 'zod';
import { db } from '@/db';
import { strategyVariants } from '@/db/schema';
import { and, eq, sql as dsql } from 'drizzle-orm';
import {
  requireAuth,
  requireWriteAccess,
  handleRoute,
  parseBody,
  parseQuery,
  audit,
} from '@/lib/api-helpers';
import { getExperimentResults } from '@/lib/experiments';

const querySchema = z.object({
  campaignId: z.string().uuid().nullish(),
});

export async function GET(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const query = parseQuery(request, querySchema);

    const results = await getExperimentResults({
      organizationId: ctx.organizationId,
      campaignId: query.campaignId ?? null,
    });

    return results;
  });
}

const createSchema = z.object({
  campaignId: z.string().uuid().nullish(),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  angleInstructions: z.string().max(2000).optional(),
  ctaStyle: z.enum(['call', 'question', 'resource']).optional(),
  targetLength: z.enum(['short', 'standard']).optional(),
  weight: z.number().int().min(1).max(100).default(1),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const body = await parseBody(request, createSchema);

    const campaignId = body.campaignId ?? null;

    // The first variant in a scope becomes the control automatically — an
    // experiment with no baseline cannot be evaluated, and making the operator
    // remember to tick a box is a way to end up with one.
    const [existing] = await db
      .select({ count: dsql<number>`COUNT(*)::int` })
      .from(strategyVariants)
      .where(
        and(
          eq(strategyVariants.organizationId, ctx.organizationId),
          campaignId
            ? eq(strategyVariants.campaignId, campaignId)
            : dsql`${strategyVariants.campaignId} IS NULL`,
        ),
      );

    const isFirst = (existing?.count ?? 0) === 0;

    const [created] = await db
      .insert(strategyVariants)
      .values({
        organizationId: ctx.organizationId,
        campaignId,
        name: body.name,
        description: body.description ?? null,
        angleInstructions: body.angleInstructions ?? null,
        ctaStyle: body.ctaStyle ?? null,
        targetLength: body.targetLength ?? null,
        weight: body.weight,
        isControl: isFirst,
        isActive: true,
      })
      .returning();

    await audit({
      ctx,
      action: 'experiment.create_variant',
      entityType: 'strategy_variant',
      entityId: created!.id,
      metadata: { name: body.name, isControl: isFirst },
      request,
    });

    return {
      variant: created,
      message: isFirst
        ? `"${body.name}" created as the control. Add a second variant to start testing.`
        : `"${body.name}" created. New leads will be split between the active variants.`,
    };
  });
}
