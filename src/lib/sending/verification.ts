/**
 * The "Require email verification" rule.
 *
 * This switch lived on the Daily Limits page and was stored, but nothing on the
 * send path ever read it — so it showed ON while unverified addresses went out
 * anyway. Every point that can move an email toward sending now asks here.
 *
 * Unverified addresses are exactly what a bought or scraped list is full of,
 * and bounces are the fastest way to lose a warmed domain.
 */

import { db } from '@/db';
import { settings } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

export const UNVERIFIED_MESSAGE =
  "This address hasn't been verified yet. Sending to unverified addresses risks bounces that " +
  'damage your domain. Wait for verification to finish, or turn off "Require email verification" ' +
  'under Sending → Daily limits.';

/** On unless explicitly switched off — the same default the settings page shows. */
export async function isVerificationRequired(organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.organizationId, organizationId),
        eq(settings.key, 'require_email_verification'),
      ),
    )
    .limit(1);

  return row?.value !== false;
}
