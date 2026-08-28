/**
 * Pull Smartlead's own send/engagement data back into our tables.
 *
 * Two jobs in one pass, both consequences of sending through a relay campaign
 * rather than a transactional API:
 *
 *  1. REAL MESSAGE IDS. `send()` returns synthetically (`sl-relay:…`) because
 *     Smartlead assigns the RFC Message-ID minutes later, when the campaign
 *     engine actually sends. Until we store the real one, an inbound reply
 *     cannot be threaded back to the email that prompted it. We backfill it
 *     from the lead's message history.
 *
 *  2. ENGAGEMENT. Opens/clicks/bounces arrive by webhook only if Smartlead
 *     fires one for relay sends — unproven, and not something the dashboard
 *     should depend on. Polling the campaign's statistics makes delivery,
 *     opens, clicks and bounces show up regardless, so the dashboard keeps
 *     updating on its own.
 *
 * Everything here is idempotent: events carry a deterministic providerEventId,
 * so re-running never double-counts.
 */

import { db, sql } from '@/db';
import { emails, emailEvents, settings } from '@/db/schema';
import { and, eq, isNotNull, inArray, gte } from 'drizzle-orm';
import { env } from '@/lib/env';

const API_BASE = 'https://server.smartlead.ai/api/v1';

/** Only look at recent sends — old rows are settled and cost API calls. */
const LOOKBACK_DAYS = 14;
/** Bound the per-run message-history lookups (2 API calls each). */
const MAX_BACKFILL_PER_RUN = 25;

export interface SmartleadSyncResult {
  ran: boolean;
  reason?: string;
  messageIdsBackfilled: number;
  eventsRecorded: number;
  emailsUpdated: number;
}

interface StatsRow {
  stats_id?: string;
  lead_email?: string;
  email_subject?: string;
  sent_time?: string;
  open_time?: string | null;
  click_time?: string | null;
  reply_time?: string | null;
  open_count?: number;
  click_count?: number;
  is_bounced?: boolean;
  is_unsubscribed?: boolean;
  sequence_number?: number;
}

interface HistoryItem {
  stats_id?: string;
  message_id?: string;
  type?: string;
  time?: string;
}

async function slPost(path: string, apiKey: string, body: unknown): Promise<void> {
  const url = `${API_BASE}${path}?api_key=${encodeURIComponent(apiKey)}`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
}

async function slFetch<T>(path: string, apiKey: string): Promise<T> {
  const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Smartlead ${path} → ${response.status}`);
  return response.json() as Promise<T>;
}

async function getRelayCampaignId(organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.organizationId, organizationId),
        eq(settings.key, 'smartlead_relay_campaign_id'),
      ),
    )
    .limit(1);
  return row?.value != null ? String(row.value) : null;
}

/**
 * Record an event once. The providerEventId is derived from the email, kind and
 * timestamp, so the same real-world event always collapses to one row.
 */
async function recordEvent(params: {
  organizationId: string;
  emailId: string;
  kind: 'delivered' | 'opened' | 'clicked' | 'bounced' | 'unsubscribed';
  occurredAt: Date;
  payload?: unknown;
}): Promise<boolean> {
  const providerEventId = `sl:${params.emailId}:${params.kind}:${Math.floor(
    params.occurredAt.getTime() / 1000,
  )}`;

  const inserted = await db
    .insert(emailEvents)
    .values({
      organizationId: params.organizationId,
      emailId: params.emailId,
      eventType: params.kind,
      provider: 'smartlead',
      providerEventId,
      occurredAt: params.occurredAt,
      payload: (params.payload ?? null) as never,
    })
    .onConflictDoNothing()
    .returning({ id: emailEvents.id });

  return inserted.length > 0;
}

/**
 * Sync one organization. Safe to call on a schedule; returns what changed so the
 * job result is inspectable.
 */
export async function syncSmartleadCampaign(
  organizationId: string,
): Promise<SmartleadSyncResult> {
  const empty: SmartleadSyncResult = {
    ran: false,
    messageIdsBackfilled: 0,
    eventsRecorded: 0,
    emailsUpdated: 0,
  };

  const apiKey = env.SMARTLEAD_API_KEY;
  if (!apiKey) return { ...empty, reason: 'SMARTLEAD_API_KEY is not set' };

  const campaignId = await getRelayCampaignId(organizationId);
  if (!campaignId) return { ...empty, reason: 'No relay campaign configured' };

  // The relay flips itself to COMPLETED once it drains, and a completed campaign
  // ignores new leads. Re-assert ACTIVE so sending can never quietly stall.
  try {
    await slPost(`/campaigns/${campaignId}/status`, apiKey, { status: 'START' });
  } catch {
    // Best-effort; send() also nudges this on every add.
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const sentEmails = await db
    .select({
      id: emails.id,
      toAddress: emails.toAddress,
      sentAt: emails.sentAt,
      status: emails.status,
      openCount: emails.openCount,
      clickCount: emails.clickCount,
      messageIdHeader: emails.messageIdHeader,
      providerMessageId: emails.providerMessageId,
    })
    .from(emails)
    .where(
      and(
        eq(emails.organizationId, organizationId),
        eq(emails.provider, 'smartlead'),
        isNotNull(emails.sentAt),
        gte(emails.sentAt, since),
        inArray(emails.status, ['sent', 'delivered', 'bounced', 'complained']),
      ),
    );

  if (sentEmails.length === 0) return { ...empty, ran: true, reason: 'No recent sends' };

  let messageIdsBackfilled = 0;
  let eventsRecorded = 0;
  let emailsUpdated = 0;

  // --- 1. Engagement from campaign statistics (one call) --------------------
  let stats: StatsRow[] = [];
  try {
    const payload = await slFetch<{ data?: StatsRow[] }>(
      `/campaigns/${campaignId}/statistics?limit=500`,
      apiKey,
    );
    stats = payload.data ?? [];
  } catch {
    // Engagement is best-effort; the message-id backfill below still matters.
  }

  // Group Smartlead's rows by recipient so an address with several touches can
  // be matched to the right one of our emails by send time.
  const statsByEmail = new Map<string, StatsRow[]>();
  for (const row of stats) {
    const key = (row.lead_email ?? '').toLowerCase();
    if (!key) continue;
    const list = statsByEmail.get(key) ?? [];
    list.push(row);
    statsByEmail.set(key, list);
  }

  for (const email of sentEmails) {
    const candidates = statsByEmail.get(email.toAddress.toLowerCase());
    if (!candidates?.length || !email.sentAt) continue;

    // Closest send time wins — Smartlead sends a minute or two after we hand it
    // over, so the nearest row is the one that corresponds to this email.
    const match = candidates
      .map((row) => ({
        row,
        delta: Math.abs(new Date(row.sent_time ?? 0).getTime() - email.sentAt!.getTime()),
      }))
      .sort((a, b) => a.delta - b.delta)[0]?.row;

    if (!match) continue;

    const updates: Record<string, unknown> = {};

    const openCount = Number(match.open_count ?? 0);
    const clickCount = Number(match.click_count ?? 0);
    if (openCount > email.openCount) updates.openCount = openCount;
    if (clickCount > email.clickCount) updates.clickCount = clickCount;

    // Status only ever moves forward: a bounce is terminal, an open proves
    // delivery. Never downgrade a row that already knows more than this feed.
    if (match.is_bounced && email.status !== 'bounced') {
      updates.status = 'bounced';
    } else if (openCount > 0 && email.status === 'sent') {
      updates.status = 'delivered';
    }

    if (Object.keys(updates).length > 0) {
      await db
        .update(emails)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(emails.id, email.id));
      emailsUpdated++;
    }

    if (match.open_time) {
      const at = new Date(match.open_time);
      if (!Number.isNaN(at.getTime())) {
        if (await recordEvent({ organizationId, emailId: email.id, kind: 'delivered', occurredAt: at }))
          eventsRecorded++;
        if (await recordEvent({ organizationId, emailId: email.id, kind: 'opened', occurredAt: at }))
          eventsRecorded++;
      }
    }
    if (match.click_time) {
      const at = new Date(match.click_time);
      if (!Number.isNaN(at.getTime())) {
        if (await recordEvent({ organizationId, emailId: email.id, kind: 'clicked', occurredAt: at }))
          eventsRecorded++;
      }
    }
    if (match.is_bounced) {
      if (
        await recordEvent({
          organizationId,
          emailId: email.id,
          kind: 'bounced',
          occurredAt: email.sentAt,
          payload: { source: 'smartlead_statistics' },
        })
      )
        eventsRecorded++;
    }
    if (match.is_unsubscribed) {
      if (
        await recordEvent({
          organizationId,
          emailId: email.id,
          kind: 'unsubscribed',
          occurredAt: email.sentAt,
        })
      )
        eventsRecorded++;
    }
  }

  // --- 2. Backfill real RFC Message-IDs so replies can be threaded ----------
  // The send path stores our synthetic id as the message-id header (it has
  // nothing better at that moment), so "needs backfill" means missing OR still
  // synthetic — not merely empty.
  const isSynthetic = (value: string | null) =>
    !value || value.startsWith('sl-relay:') || value.startsWith('sl-reply:');

  const needsMessageId = sentEmails
    .filter((e) => isSynthetic(e.messageIdHeader))
    .slice(0, MAX_BACKFILL_PER_RUN);
  const historyCache = new Map<string, HistoryItem[]>();

  for (const email of needsMessageId) {
    if (!email.sentAt) continue;
    const key = email.toAddress.toLowerCase();

    let history = historyCache.get(key);
    if (!history) {
      try {
        const lead = await slFetch<{ id?: string | number }>(
          `/leads/?email=${encodeURIComponent(email.toAddress)}`,
          apiKey,
        );
        if (!lead?.id) continue;
        const payload = await slFetch<{ history?: HistoryItem[] }>(
          `/campaigns/${campaignId}/leads/${lead.id}/message-history`,
          apiKey,
        );
        history = (payload.history ?? []).filter((m) => m.type === 'SENT' && m.message_id);
        historyCache.set(key, history);
      } catch {
        continue;
      }
    }

    if (!history.length) continue;

    const match = history
      .map((item) => ({
        item,
        delta: Math.abs(new Date(item.time ?? 0).getTime() - email.sentAt!.getTime()),
      }))
      .sort((a, b) => a.delta - b.delta)[0]?.item;

    if (!match?.message_id) continue;

    await db
      .update(emails)
      .set({
        messageIdHeader: match.message_id,
        // Keep the thread anchored to the first message of the conversation.
        threadId: match.stats_id ? `sl-thread:${match.stats_id}` : undefined,
        updatedAt: new Date(),
      })
      .where(eq(emails.id, email.id));

    messageIdsBackfilled++;
  }

  return { ran: true, messageIdsBackfilled, eventsRecorded, emailsUpdated };
}

/** Recompute per-inbox counters the dashboard reads, from real email rows. */
export async function refreshInboxCountersFromEmails(organizationId: string): Promise<void> {
  await sql`
    UPDATE sending_inboxes i
    SET total_bounced = COALESCE(sub.bounced, 0),
        updated_at = NOW()
    FROM (
      SELECT inbox_id, COUNT(*) FILTER (WHERE status = 'bounced')::int AS bounced
      FROM emails
      WHERE organization_id = ${organizationId} AND inbox_id IS NOT NULL
      GROUP BY inbox_id
    ) sub
    WHERE i.id = sub.inbox_id AND i.organization_id = ${organizationId}
  `;
}
