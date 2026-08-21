import { z } from 'zod';
import { db } from '@/db';
import { strategyVariants } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireWriteAccess, handleRoute, parseBody, audit, ApiError } from '@/lib/api-helpers';
import { promoteVariant, countAssignedLeads } from '@/lib/experiments';

type Params = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  angleInstructions: z.string().max(2000).nullable().optional(),
  ctaStyle: z.enum(['call', 'question', 'resource']).nullable().optional(),
  targetLength: z.enum(['short', 'standard']).nullable().optional(),
  weight: z.number().int().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
  /** Make this variant the new baseline. */
  promote: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { id } = await params;
    const body = await parseBody(request, updateSchema);

    const [variant] = await db
      .select()
      .from(strategyVariants)
      .where(
        and(
          eq(strategyVariants.id, id),
          eq(strategyVariants.organizationId, ctx.organizationId),
        ),
      )
      .limit(1);

    if (!variant) throw new ApiError(404, 'Variant not found', 'NOT_FOUND');

    if (body.promote) {
      const result = await promoteVariant({ organizationId: ctx.organizationId, variantId: id });
      if ('error' in result) throw new ApiError(409, result.error, 'CANNOT_PROMOTE');

      await audit({
        ctx,
        action: 'experiment.promote_variant',
        entityType: 'strategy_variant',
        entityId: id,
        metadata: { name: variant.name },
        request,
      });

      return {
        promoted: true,
        message: `"${result.promoted}" is now the control. Leads already sent keep their original assignment.`,
      };
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(body)) {
      if (key !== 'promote' && value !== undefined) updates[key] = value;
    }

    // Editing the angle mid-test changes what the numbers mean: replies already
    // counted came from the old wording. Warn rather than block — early on,
    // fixing a bad variant is more useful than protecting a handful of sends.
    let warning: string | null = null;
    const changesBehaviour =
      body.angleInstructions !== undefined ||
      body.ctaStyle !== undefined ||
      body.targetLength !== undefined;

    if (changesBehaviour) {
      const assigned = await countAssignedLeads(id);
      if (assigned > 0) {
        warning =
          `${assigned} lead${assigned === 1 ? ' has' : 's have'} already been assigned to this ` +
          'variant. Results collected so far came from the previous wording — consider creating ' +
          'a new variant instead so the comparison stays clean.';
      }
    }

    const [updated] = await db
      .update(strategyVariants)
      .set(updates)
      .where(eq(strategyVariants.id, id))
      .returning();

    await audit({
      ctx,
      action: 'experiment.update_variant',
      entityType: 'strategy_variant',
      entityId: id,
      changes: body,
      request,
    });

    return { variant: updated, warning };
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const { id } = await params;

    const [variant] = await db
      .select()
      .from(strategyVariants)
      .where(
        and(
          eq(strategyVariants.id, id),
          eq(strategyVariants.organizationId, ctx.organizationId),
        ),
      )
      .limit(1);

    if (!variant) throw new ApiError(404, 'Variant not found', 'NOT_FOUND');

    // Deleting would set variantId to null on its leads, silently erasing which
    // arm those results belonged to. Deactivating keeps the history intact.
    const assigned = await countAssignedLeads(id);
    if (assigned > 0) {
      throw new ApiError(
        409,
        `${assigned} lead${assigned === 1 ? ' is' : 's are'} assigned to this variant. ` +
          'Deactivate it instead — deleting would erase which variant those results came from.',
        'HAS_ASSIGNED_LEADS',
      );
    }

    await db.delete(strategyVariants).where(eq(strategyVariants.id, id));

    await audit({
      ctx,
      action: 'experiment.delete_variant',
      entityType: 'strategy_variant',
      entityId: id,
      metadata: { name: variant.name },
      request,
    });

    return { deleted: true };
  });
}
