/**
 * Add or update an organization member's role, creating the user if needed.
 *
 * There is no in-app user management yet, so this is the supported way to add a
 * teammate or hand over ownership. Env-driven, like the seed:
 *
 *   MEMBER_EMAIL=partner@x.com MEMBER_ROLE=owner MEMBER_PASSWORD='...' \
 *   MEMBER_NAME='Partner' ALSO_SET_EMAIL=you@x.com ALSO_SET_ROLE=admin \
 *   npx tsx src/db/add-member.ts
 *
 * MEMBER_PASSWORD is required only when creating a new user; an existing user's
 * password is never touched. ALSO_SET_* re-roles a second, existing member in
 * the same run (how a handover demotes the current owner). It refuses to finish
 * if the org would be left with no owner.
 */

import 'dotenv/config';
import { db } from './index';
import { organizations, users, organizationMembers } from './schema';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
type Role = (typeof ROLES)[number];

function parseRole(value: string | undefined, field: string): Role {
  if (!value || !ROLES.includes(value as Role)) {
    console.error(`${field} must be one of: ${ROLES.join(', ')}`);
    process.exit(1);
  }
  return value as Role;
}

async function setMemberRole(
  orgId: string,
  rawEmail: string,
  role: Role,
  opts: { password?: string; name?: string; createIfMissing: boolean },
): Promise<void> {
  const email = rawEmail.toLowerCase().trim();
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (!user) {
    if (!opts.createIfMissing) {
      console.error(`User ${email} not found.`);
      process.exit(1);
    }
    if (!opts.password || opts.password.length < 10) {
      console.error(`User ${email} does not exist; MEMBER_PASSWORD (>=10 chars) is required to create it.`);
      process.exit(1);
    }
    const passwordHash = await bcrypt.hash(opts.password, 12);
    [user] = await db
      .insert(users)
      .values({ email, name: opts.name ?? email, passwordHash, emailVerified: new Date() })
      .returning();
    console.log(`  ✔ created user ${email}`);
  } else {
    console.log(`  · user ${email} already exists (password unchanged)`);
  }

  await db
    .insert(organizationMembers)
    .values({ organizationId: orgId, userId: user!.id, role })
    .onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: { role },
    });
  console.log(`  ✔ ${email} role = ${role}`);
}

async function main() {
  const memberEmail = process.env.MEMBER_EMAIL;
  if (!memberEmail) {
    console.error('MEMBER_EMAIL is required.');
    process.exit(1);
  }
  const memberRole = parseRole(process.env.MEMBER_ROLE, 'MEMBER_ROLE');

  const [org] = await db.select().from(organizations).limit(1);
  if (!org) {
    console.error('No organization found — run the seed first.');
    process.exit(1);
  }
  console.log(`Organization: ${org.name}`);

  // Add/promote the primary member first, so a handover always has an owner in
  // place before the next step demotes the previous one.
  await setMemberRole(org.id, memberEmail, memberRole, {
    password: process.env.MEMBER_PASSWORD,
    name: process.env.MEMBER_NAME,
    createIfMissing: true,
  });

  if (process.env.ALSO_SET_EMAIL) {
    const alsoRole = parseRole(process.env.ALSO_SET_ROLE, 'ALSO_SET_ROLE');
    await setMemberRole(org.id, process.env.ALSO_SET_EMAIL, alsoRole, { createIfMissing: false });
  }

  const owners = await db
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, org.id), eq(organizationMembers.role, 'owner')));
  if (owners.length === 0) {
    console.error('Refusing to finish: this change would leave the organization with no owner.');
    process.exit(1);
  }
  console.log(`  ✔ organization has ${owners.length} owner(s).`);
  console.log('Done.');
  process.exit(0);
}

main().catch((error) => {
  console.error('FAILED:', error);
  process.exit(1);
});
