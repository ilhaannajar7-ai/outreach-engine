/**
 * Two-factor enrolment for the signed-in user.
 *
 * GET    — current status
 * POST   — start enrolment: returns a secret + QR to scan (not yet active)
 * PUT    — confirm enrolment with a live code; returns one-time recovery codes
 * DELETE — turn 2FA off (requires a current code, so a hijacked session cannot)
 */

import { z } from 'zod';
import QRCode from 'qrcode';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth, handleRoute, parseBody, audit, ApiError } from '@/lib/api-helpers';
import {
  generateSecret,
  buildOtpAuthUrl,
  verifyTotp,
  generateRecoveryCodes,
  consumeRecoveryCode,
} from '@/lib/two-factor';

async function loadUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new ApiError(404, 'User not found', 'NOT_FOUND');
  return user;
}

export async function GET() {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const user = await loadUser(ctx.userId);
    return {
      enabled: Boolean(user.twoFactorEnabledAt),
      enabledAt: user.twoFactorEnabledAt,
      recoveryCodesRemaining: user.twoFactorRecoveryCodes?.length ?? 0,
    };
  });
}

export async function POST() {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const user = await loadUser(ctx.userId);
    if (user.twoFactorEnabledAt) {
      throw new ApiError(400, 'Two-factor is already on. Turn it off first to re-enrol.', 'ALREADY_ON');
    }

    // Stored immediately but inert until PUT confirms a real code works.
    const secret = generateSecret();
    await db
      .update(users)
      .set({ twoFactorSecret: secret, updatedAt: new Date() })
      .where(eq(users.id, ctx.userId));

    const otpauth = buildOtpAuthUrl(user.email, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });

    return { secret, otpauth, qrDataUrl };
  });
}

const confirmSchema = z.object({ code: z.string().min(6).max(10) });

export async function PUT(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const body = await parseBody(request, confirmSchema);
    const user = await loadUser(ctx.userId);

    if (!user.twoFactorSecret) {
      throw new ApiError(400, 'Start setup first.', 'NO_PENDING_SETUP');
    }
    if (user.twoFactorEnabledAt) {
      throw new ApiError(400, 'Two-factor is already on.', 'ALREADY_ON');
    }
    if (!verifyTotp(body.code, user.twoFactorSecret)) {
      throw new ApiError(400, 'That code is not right. Check the app and try again.', 'BAD_CODE');
    }

    const { plain, hashed } = await generateRecoveryCodes();
    await db
      .update(users)
      .set({ twoFactorEnabledAt: new Date(), twoFactorRecoveryCodes: hashed, updatedAt: new Date() })
      .where(eq(users.id, ctx.userId));

    await audit({ ctx, action: 'account.2fa_enabled', entityType: 'user', entityId: ctx.userId, request });

    // Shown exactly once — only hashes are kept.
    return { enabled: true, recoveryCodes: plain };
  });
}

export async function DELETE(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const body = await parseBody(request, confirmSchema);
    const user = await loadUser(ctx.userId);

    if (!user.twoFactorEnabledAt || !user.twoFactorSecret) {
      throw new ApiError(400, 'Two-factor is not on.', 'NOT_ON');
    }

    // A current code (or a recovery code) is required, so someone who merely
    // has the session cannot quietly remove the second factor.
    const codeOk =
      verifyTotp(body.code, user.twoFactorSecret) ||
      (await consumeRecoveryCode(body.code, user.twoFactorRecoveryCodes)) !== null;
    if (!codeOk) {
      throw new ApiError(400, 'That code is not right.', 'BAD_CODE');
    }

    await db
      .update(users)
      .set({
        twoFactorSecret: null,
        twoFactorEnabledAt: null,
        twoFactorRecoveryCodes: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, ctx.userId));

    await audit({ ctx, action: 'account.2fa_disabled', entityType: 'user', entityId: ctx.userId, request });
    return { enabled: false, message: 'Two-factor authentication is off.' };
  });
}
