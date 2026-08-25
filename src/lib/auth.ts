/**
 * Authentication — Auth.js with a credentials provider.
 *
 * Self-hosted rather than a paid identity service: one fewer vendor, one fewer
 * bill, and for a 1–5 user internal tool a password + session cookie is the
 * right amount of machinery.
 *
 * Passwords are bcrypt-hashed (cost 12) and never logged.
 */

import type { NextAuthOptions, DefaultSession } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from '@/db';
import { users, organizationMembers, organizations } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { env } from '@/lib/env';
import { verifyTotp, consumeRecoveryCode } from '@/lib/two-factor';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      organizationId: string;
      organizationName: string;
      role: string;
    } & DefaultSession['user'];
  }

  interface User {
    id: string;
    organizationId: string;
    organizationName: string;
    role: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    organizationId: string;
    organizationName: string;
    role: string;
  }
}

const BCRYPT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export const authOptions: NextAuthOptions = {
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60,
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        totp: { label: 'Authentication code', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials.password) return null;

        const email = credentials.email.toLowerCase().trim();

        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

        // Same generic failure for "no such user" and "wrong password" so the
        // response cannot be used to enumerate accounts.
        if (!user?.passwordHash || !user.isActive) return null;

        const valid = await verifyPassword(credentials.password, user.passwordHash);
        if (!valid) return null;

        // Second factor, when the account has completed enrolment. A distinct
        // error code lets the login screen ask for the code instead of showing
        // "wrong password" — the password was right, it is just not enough.
        if (user.twoFactorEnabledAt && user.twoFactorSecret) {
          const submitted = credentials.totp?.trim();
          if (!submitted) throw new Error('2FA_REQUIRED');

          const codeOk = verifyTotp(submitted, user.twoFactorSecret);
          if (!codeOk) {
            // Fall back to a single-use recovery code for a lost device.
            const remaining = await consumeRecoveryCode(submitted, user.twoFactorRecoveryCodes);
            if (!remaining) throw new Error('2FA_INVALID');
            await db
              .update(users)
              .set({ twoFactorRecoveryCodes: remaining, updatedAt: new Date() })
              .where(eq(users.id, user.id));
          }
        }

        const [membership] = await db
          .select({
            organizationId: organizationMembers.organizationId,
            role: organizationMembers.role,
            organizationName: organizations.name,
          })
          .from(organizationMembers)
          .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
          .where(eq(organizationMembers.userId, user.id))
          .limit(1);

        if (!membership) return null;

        await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          organizationId: membership.organizationId,
          organizationName: membership.organizationName,
          role: membership.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.organizationId = user.organizationId;
        token.organizationName = user.organizationName;
        token.role = user.role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.organizationId = token.organizationId;
        session.user.organizationName = token.organizationName;
        session.user.role = token.role;
      }
      return session;
    },
  },
  secret: env.NEXTAUTH_SECRET,
};

/** True when the role may perform destructive or spend-incurring actions. */
export function canWrite(role: string): boolean {
  return role === 'owner' || role === 'admin' || role === 'member';
}

export function canAdmin(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/** Confirms a user actually belongs to an org before any scoped query runs. */
export async function assertOrgMembership(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const [membership] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .limit(1);

  return Boolean(membership);
}
