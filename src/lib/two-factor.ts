/**
 * Two-factor authentication (TOTP).
 *
 * An authenticator app rather than emailed codes, deliberately: the droplet
 * cannot send transactional mail (DigitalOcean blocks outbound SMTP, and the
 * campaign sender is not a transactional channel), so an emailed code would
 * depend on infrastructure we do not have. TOTP needs no delivery path at all,
 * and is not interceptable the way an inbox is.
 *
 * Recovery codes are bcrypt-hashed and single-use — losing a phone must not
 * mean losing the account, but a leaked backup file must not be a master key.
 */

import { generateSecret as otpGenerateSecret, generateURI, verifySync } from 'otplib';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

export const TOTP_ISSUER = 'Outreach Engine';

/** Seconds of clock drift allowed either side, so a slightly-off phone works. */
const TOLERANCE_SECONDS = 30;

export function generateSecret(): string {
  return otpGenerateSecret();
}

/** The otpauth:// URI an authenticator app scans. */
export function buildOtpAuthUrl(email: string, secret: string): string {
  return generateURI({ strategy: 'totp', issuer: TOTP_ISSUER, label: email, secret });
}

export function verifyTotp(token: string, secret: string): boolean {
  const cleaned = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  try {
    return verifySync({ strategy: 'totp', secret, token: cleaned, epochTolerance: TOLERANCE_SECONDS })
      .valid;
  } catch {
    return false;
  }
}

export const RECOVERY_CODE_COUNT = 8;

/** Plaintext codes are returned once, for the user to save; only hashes persist. */
export async function generateRecoveryCodes(): Promise<{ plain: string[]; hashed: string[] }> {
  const plain = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g)!.join('-'),
  );
  const hashed = await Promise.all(plain.map((code) => bcrypt.hash(code, 10)));
  return { plain, hashed };
}

/**
 * Check a recovery code and return the remaining hashes with the used one
 * removed, or null when it does not match. Consuming is the caller's job so the
 * removal and the login happen in the same step.
 */
export async function consumeRecoveryCode(
  input: string,
  hashes: string[] | null | undefined,
): Promise<string[] | null> {
  if (!hashes?.length) return null;
  const candidate = input.trim().toUpperCase();
  if (!candidate) return null;

  for (let i = 0; i < hashes.length; i += 1) {
    if (await bcrypt.compare(candidate, hashes[i]!)) {
      return hashes.filter((_, index) => index !== i);
    }
  }
  return null;
}
