import { z } from 'zod';
import { db } from '@/db';
import { users, organizationMembers } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireAdmin, handleRoute, parseBody, audit, ApiError } from '@/lib/api-helpers';
import bcrypt from 'bcryptjs';

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

const createSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(255),
  role: z.enum(ROLES),
  // Sets the initial password for a brand-new user. Ignored if the person
  // already has an account (their existing password is never reset here).
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
});

/** Add a member to the organization, creating their user account if needed. */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const body = await parseBody(request, createSchema);

    // Only an owner may grant the owner role.
    if (body.role === 'owner' && ctx.role !== 'owner') {
      throw new ApiError(403, 'Only an owner can grant the owner role.', 'FORBIDDEN');
    }

    const email = body.email.toLowerCase().trim();

    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    let createdUser = false;
    if (!user) {
      const passwordHash = await bcrypt.hash(body.password, 12);
      [user] = await db
        .insert(users)
        .values({ email, name: body.name, passwordHash, emailVerified: new Date() })
        .returning();
      createdUser = true;
    }

    const [existing] = await db
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, ctx.organizationId),
          eq(organizationMembers.userId, user!.id),
        ),
      )
      .limit(1);
    if (existing) {
      throw new ApiError(409, 'That person is already a member of this organization.', 'DUPLICATE');
    }

    await db
      .insert(organizationMembers)
      .values({ organizationId: ctx.organizationId, userId: user!.id, role: body.role });

    await audit({
      ctx,
      action: 'member.add',
      entityType: 'organization_member',
      entityId: user!.id,
      changes: { email, role: body.role, createdUser },
      request,
    });

    return {
      message: createdUser
        ? `${email} added as ${body.role}. Share their password with them.`
        : `${email} added as ${body.role} (existing account — password unchanged).`,
      createdUser,
    };
  });
}
