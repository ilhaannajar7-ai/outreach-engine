import { z } from 'zod';
import { db } from '@/db';
import { organizationMembers } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireAdmin, handleRoute, parseBody, audit, ApiError } from '@/lib/api-helpers';

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
const patchSchema = z.object({ role: z.enum(ROLES) });

async function ownerCount(orgId: string): Promise<number> {
  const owners = await db
    .select()
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.role, 'owner')),
    );
  return owners.length;
}

/** Change a member's role. */
export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const { userId } = await params;
    const body = await parseBody(request, patchSchema);

    const [member] = await db
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, ctx.organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!member) throw new ApiError(404, 'Member not found', 'NOT_FOUND');

    // Owner is the highest role — only an owner may grant it or change an owner.
    if ((body.role === 'owner' || member.role === 'owner') && ctx.role !== 'owner') {
      throw new ApiError(403, 'Only an owner can assign or change the owner role.', 'FORBIDDEN');
    }
    // Never leave the org without an owner.
    if (member.role === 'owner' && body.role !== 'owner' && (await ownerCount(ctx.organizationId)) <= 1) {
      throw new ApiError(
        400,
        'This is the only owner — promote someone else to owner before changing this role.',
        'LAST_OWNER',
      );
    }

    await db
      .update(organizationMembers)
      .set({ role: body.role })
      .where(
        and(
          eq(organizationMembers.organizationId, ctx.organizationId),
          eq(organizationMembers.userId, userId),
        ),
      );

    await audit({
      ctx,
      action: 'member.role',
      entityType: 'organization_member',
      entityId: userId,
      changes: { role: body.role },
      request,
    });
    return { message: `Role updated to ${body.role}.` };
  });
}

/** Remove a member from the organization (their user account is left intact). */
export async function DELETE(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const { userId } = await params;

    const [member] = await db
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, ctx.organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!member) throw new ApiError(404, 'Member not found', 'NOT_FOUND');

    if (userId === ctx.userId) {
      throw new ApiError(400, 'You cannot remove yourself.', 'SELF_REMOVE');
    }
    if (member.role === 'owner' && ctx.role !== 'owner') {
      throw new ApiError(403, 'Only an owner can remove an owner.', 'FORBIDDEN');
    }
    if (member.role === 'owner' && (await ownerCount(ctx.organizationId)) <= 1) {
      throw new ApiError(400, 'Cannot remove the only owner.', 'LAST_OWNER');
    }

    await db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, ctx.organizationId),
          eq(organizationMembers.userId, userId),
        ),
      );

    await audit({
      ctx,
      action: 'member.remove',
      entityType: 'organization_member',
      entityId: userId,
      request,
    });
    return { message: 'Member removed.' };
  });
}
