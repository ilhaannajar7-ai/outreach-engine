/**
 * Inbox selection and send-capacity accounting.
 *
 * This is what makes "add a domain" a dashboard action rather than a code
 * change: sends are distributed across whatever active inboxes exist, weighted
 * by remaining headroom, and every cap is a database value.
 *
 * Three caps apply to every send, all of them enforced:
 *   1. Global daily limit (org setting)
 *   2. Per-domain daily limit
 *   3. Per-inbox daily limit (ramped by the warm-up schedule)
 */

import { db, sql } from '@/db';
import { sendingInboxes, sendingDomains, emails, settings } from '@/db/schema';
import { and, eq, gte, sql as dsql } from 'drizzle-orm';
import { env } from '@/lib/env';

export interface AvailableInbox {
  id: string;
  emailAddress: string;
  displayName: string;
  replyToAddress: string | null;
  provider: string;
  providerInboxId: string | null;
  domainId: string;
  domain: string;
  sentToday: number;
  dailySendLimit: number;
  headroom: number;
  reputationScore: number;
}

export class NoCapacityError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'NoCapacityError';
  }
}

/**
 * Warm-up ramp. Starts at 10/day and roughly doubles each week until the
 * inbox's configured maximum. Inbox providers score new senders on volume
 * consistency, so this curve is deliberately gentle — going faster is the most
 * common way to burn a domain.
 */
export function warmupDailyLimit(
  warmupStartedAt: Date | null,
  maxLimit: number,
  warmupCompleted: boolean,
): number {
  if (warmupCompleted) return maxLimit;
  if (!warmupStartedAt) return 0;

  const daysElapsed = Math.floor((Date.now() - warmupStartedAt.getTime()) / (24 * 60 * 60 * 1000));
  const week = Math.floor(daysElapsed / 7);

  const schedule = [10, 20, 35, 50, 75, 100];
  const target = schedule[week] ?? maxLimit;

  return Math.min(target, maxLimit);
}

/** Reset per-day counters that belong to a previous day. */
async function resetStaleCounters(organizationId: string): Promise<void> {
  await sql`
    UPDATE sending_inboxes
    SET sent_today = 0,
        sent_today_reset_at = NOW(),
        updated_at = NOW()
    WHERE organization_id = ${organizationId}
      AND (sent_today_reset_at IS NULL
           OR sent_today_reset_at < DATE_TRUNC('day', NOW()))
  `;
}

async function getGlobalDailyLimit(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.organizationId, organizationId), eq(settings.key, 'global_daily_send_limit')))
    .limit(1);

  const value = Number(row?.value);
  return Number.isFinite(value) && value > 0 ? value : env.GLOBAL_DAILY_SEND_LIMIT;
}

/** Emails actually sent today across the whole org. */
export async function getSentTodayCount(organizationId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [row] = await db
    .select({ count: dsql<number>`COUNT(*)::int` })
    .from(emails)
    .where(
      and(
        eq(emails.organizationId, organizationId),
        gte(emails.sentAt, startOfDay),
        // Every status that means the message actually left the building, so a
        // bounce still counts against today's quota. Opens are tracked in
        // `open_count`, not status — there is no 'opened' email_status.
        dsql`${emails.status} IN ('sent', 'delivered', 'bounced', 'complained')`,
      ),
    );

  return row?.count ?? 0;
}

/**
 * Inboxes that can send right now, ordered by most remaining headroom.
 *
 * Ordering by headroom rather than round-robin keeps volume even across
 * inboxes, which is exactly the pattern reputation systems reward.
 */
export async function getAvailableInboxes(organizationId: string): Promise<AvailableInbox[]> {
  await resetStaleCounters(organizationId);

  const rows = await db
    .select({
      id: sendingInboxes.id,
      emailAddress: sendingInboxes.emailAddress,
      displayName: sendingInboxes.displayName,
      replyToAddress: sendingInboxes.replyToAddress,
      provider: sendingInboxes.provider,
      providerInboxId: sendingInboxes.providerInboxId,
      domainId: sendingInboxes.domainId,
      domain: sendingDomains.domain,
      sentToday: sendingInboxes.sentToday,
      dailySendLimit: sendingInboxes.dailySendLimit,
      maxDailySendLimit: sendingInboxes.maxDailySendLimit,
      warmupStartedAt: sendingInboxes.warmupStartedAt,
      warmupCompleted: sendingInboxes.warmupCompleted,
      reputationScore: sendingInboxes.reputationScore,
      domainDailyLimit: sendingDomains.dailySendLimit,
      domainStatus: sendingDomains.status,
    })
    .from(sendingInboxes)
    .innerJoin(sendingDomains, eq(sendingInboxes.domainId, sendingDomains.id))
    .where(
      and(
        eq(sendingInboxes.organizationId, organizationId),
        dsql`${sendingInboxes.status} IN ('active', 'warming')`,
        dsql`${sendingDomains.status} IN ('active', 'warming')`,
      ),
    );

  // Domain-level usage caps the sum of its inboxes regardless of per-inbox room.
  const domainUsage = new Map<string, number>();
  for (const row of rows) {
    domainUsage.set(row.domainId, (domainUsage.get(row.domainId) ?? 0) + row.sentToday);
  }

  const available: AvailableInbox[] = [];

  for (const row of rows) {
    const effectiveLimit = row.warmupCompleted
      ? row.dailySendLimit
      : Math.min(
          row.dailySendLimit,
          warmupDailyLimit(row.warmupStartedAt, row.maxDailySendLimit, row.warmupCompleted),
        );

    const inboxHeadroom = effectiveLimit - row.sentToday;
    const domainHeadroom = row.domainDailyLimit - (domainUsage.get(row.domainId) ?? 0);
    const headroom = Math.min(inboxHeadroom, domainHeadroom);

    if (headroom <= 0) continue;

    available.push({
      id: row.id,
      emailAddress: row.emailAddress,
      displayName: row.displayName,
      replyToAddress: row.replyToAddress,
      provider: row.provider,
      providerInboxId: row.providerInboxId,
      domainId: row.domainId,
      domain: row.domain,
      sentToday: row.sentToday,
      dailySendLimit: effectiveLimit,
      headroom,
      reputationScore: row.reputationScore,
    });
  }

  // Most headroom first; break ties on reputation so healthier inboxes lead.
  return available.sort((a, b) => b.headroom - a.headroom || b.reputationScore - a.reputationScore);
}

/**
 * Pick the inbox for the next send, after confirming global capacity.
 *
 * Throws NoCapacityError with a human-readable reason — the reason is surfaced
 * directly on the dashboard, so it must explain what to do, not just what failed.
 */
export async function selectInboxForSend(organizationId: string): Promise<AvailableInbox> {
  const globalLimit = await getGlobalDailyLimit(organizationId);
  const sentToday = await getSentTodayCount(organizationId);

  if (sentToday >= globalLimit) {
    throw new NoCapacityError(
      `Global daily send limit reached (${sentToday}/${globalLimit}). ` +
        `Sending resumes tomorrow, or raise the limit in Settings → Daily Limits.`,
    );
  }

  const inboxes = await getAvailableInboxes(organizationId);

  if (inboxes.length === 0) {
    throw new NoCapacityError(
      `No inbox has capacity right now. Every active inbox has hit its daily cap, ` +
        `or all inboxes are paused. Check Sending → Domains & Inboxes.`,
    );
  }

  return inboxes[0]!;
}

/** Increment the inbox counter after a successful send. */
export async function recordInboxSend(inboxId: string): Promise<void> {
  await sql`
    UPDATE sending_inboxes
    SET sent_today   = sent_today + 1,
        total_sent   = total_sent + 1,
        last_sent_at = NOW(),
        updated_at   = NOW()
    WHERE id = ${inboxId}
  `;
}

/** Total remaining sends across all inboxes, bounded by the global cap. */
export async function getRemainingCapacityToday(organizationId: string): Promise<{
  remaining: number;
  globalLimit: number;
  sentToday: number;
  inboxCount: number;
}> {
  const globalLimit = await getGlobalDailyLimit(organizationId);
  const sentToday = await getSentTodayCount(organizationId);
  const inboxes = await getAvailableInboxes(organizationId);

  const inboxCapacity = inboxes.reduce((sum, i) => sum + i.headroom, 0);

  return {
    remaining: Math.max(0, Math.min(globalLimit - sentToday, inboxCapacity)),
    globalLimit,
    sentToday,
    inboxCount: inboxes.length,
  };
}

/** True when the clock is inside the configured sending window. */
export function isWithinSendWindow(now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: env.SEND_TIMEZONE,
    }).format(now),
  );

  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: env.SEND_TIMEZONE,
  }).format(now);

  // Weekend cold email performs poorly and looks automated.
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  return hour >= env.SEND_WINDOW_START_HOUR && hour < env.SEND_WINDOW_END_HOUR;
}
