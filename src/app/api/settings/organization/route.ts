import { z } from 'zod';
import { db } from '@/db';
import { organizations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth, requireAdmin, handleRoute, parseBody, audit } from '@/lib/api-helpers';

export async function GET() {
  return handleRoute(async () => {
    const ctx = await requireAuth();

    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId))
      .limit(1);

    return { organization };
  });
}

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  valueProposition: z.string().max(2000).nullable().optional(),
  servicesOffered: z.string().max(2000).nullable().optional(),
  targetIndustries: z.string().max(1000).nullable().optional(),
  senderName: z.string().max(255).nullable().optional(),
  senderTitle: z.string().max(255).nullable().optional(),
  calendarLink: z.string().url().max(500).nullable().optional().or(z.literal('')),
});

/**
 * Organization profile.
 *
 * These fields are injected into every AI prompt — they are what ground the
 * generated copy in a real offering instead of an invented one. Editing them
 * changes what the AI writes on the very next generation.
 */
export async function PATCH(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const body = await parseBody(request, updateSchema);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      updates[key] = value === '' ? null : value;
    }

    const [updated] = await db
      .update(organizations)
      .set(updates)
      .where(eq(organizations.id, ctx.organizationId))
      .returning();

    await audit({
      ctx,
      action: 'settings.organization',
      entityType: 'organization',
      entityId: ctx.organizationId,
      changes: body,
      request,
    });

    return {
      organization: updated,
      message: 'Saved. This is applied to the next email the AI generates.',
    };
  });
}
