/**
 * Live Smartlead warm-up / deliverability read layer.
 *
 * Smartlead is where the *real* warm-up health lives — the app's own
 * `reputation_score` is a lagging indicator computed only after 20+ real sends,
 * so during warm-up it sits frozen at its default. This module pulls the actual
 * numbers Smartlead computes (warm-up reputation, inbox-vs-spam placement, the
 * daily ramp) so the dashboard can show them.
 *
 * It reads two endpoints per connected mailbox:
 *   GET /email-accounts                      → account + warmup_details summary
 *   GET /email-accounts/{id}/warmup-stats    → totals + per-day time series
 *
 * SECURITY: the /email-accounts response contains SMTP/IMAP passwords. This
 * module maps to a whitelisted, secret-free shape — nothing here ever returns a
 * credential to the client.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { sendingInboxes, settings } from '@/db/schema';
import { env } from '@/lib/env';

const API_BASE = 'https://server.smartlead.ai/api/v1';
const CACHE_TTL_MS = 30_000;

/** One real outreach send, as Smartlead recorded it. */
export interface SmartleadSend {
  toEmail: string;
  subject: string;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  repliedAt: string | null;
  openCount: number;
  clickCount: number;
  bounced: boolean;
  unsubscribed: boolean;
  sequenceNumber: number;
}

export interface SmartleadActivity {
  configured: boolean;
  reason?: string;
  campaignId: string | null;
  campaignStatus: string | null;
  fetchedAt: string;
  totals: {
    sent: number;
    opened: number;
    clicked: number;
    replied: number;
    bounced: number;
    unsubscribed: number;
    openRate: number;
    replyRate: number;
    bounceRate: number;
  };
  recent: SmartleadSend[];
}

export interface WarmupDayStat {
  date: string;
  sent: number;
  replies: number;
  savedFromSpam: number;
}

export interface SmartleadAccount {
  emailAddress: string;
  fromName: string | null;
  warmupEnabled: boolean;
  warmupStatus: string | null;
  reputation: number | null; // 0–100, parsed from Smartlead's "97%"
  smtpConnected: boolean;
  imapConnected: boolean;
  blockedReason: string | null;
  messagePerDay: number | null; // real-send daily cap on the mailbox
  dailySentCount: number; // real sends so far today
  maxWarmupPerDay: number | null;
  totalWarmupSent: number;
  totalWarmupSpam: number;
  warmupInboxCount: number; // warm-up emails that landed in inbox
  warmupReceived: number;
  spamRate: number | null; // % of warm-up mail marked spam
  statsByDate: WarmupDayStat[];
}

export interface SmartleadWarmup {
  configured: boolean;
  reason?: string;
  fetchedAt: string;
  accounts: SmartleadAccount[];
}

interface RawWarmupDetails {
  status?: string;
  total_spam_count?: number;
  warmup_reputation?: string | number;
  blocked_reason?: string | null;
  max_email_per_day?: number;
}

interface RawAccount {
  id: number;
  from_email?: string;
  from_name?: string | null;
  warmup_enabled?: boolean;
  is_smtp_success?: boolean;
  is_imap_success?: boolean;
  message_per_day?: number;
  daily_sent_count?: number;
  warmup_reputation?: string | number;
  warmup_details?: RawWarmupDetails | null;
}

interface RawWarmupStats {
  sent_count?: string | number;
  spam_count?: string | number;
  inbox_count?: string | number;
  warmup_email_received_count?: string | number;
  stats_by_date?: Array<{
    date?: string;
    sent_count?: number;
    reply_count?: number;
    save_from_spam_count?: number;
  }>;
}

const cache = new Map<string, { at: number; data: SmartleadWarmup }>();
const activityCache = new Map<string, { at: number; data: SmartleadActivity }>();

/**
 * Live sending + engagement for the relay campaign — what actually went out and
 * what recipients did with it, straight from Smartlead rather than our mirror.
 *
 * The 10-minute sync writes this into our tables for the funnel and reports;
 * this reader is what makes the dashboard show it *now*, and is also how you can
 * tell our mirror apart from the provider's own truth if they ever disagree.
 */
export async function getSmartleadActivity(
  organizationId: string,
  forceRefresh = false,
): Promise<SmartleadActivity> {
  const now = Date.now();
  if (!forceRefresh) {
    const hit = activityCache.get(organizationId);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.data;
  }

  const base: SmartleadActivity = {
    configured: false,
    campaignId: null,
    campaignStatus: null,
    fetchedAt: new Date().toISOString(),
    totals: {
      sent: 0,
      opened: 0,
      clicked: 0,
      replied: 0,
      bounced: 0,
      unsubscribed: 0,
      openRate: 0,
      replyRate: 0,
      bounceRate: 0,
    },
    recent: [],
  };

  const apiKey = env.SMARTLEAD_API_KEY;
  if (!apiKey) return { ...base, reason: 'SMARTLEAD_API_KEY is not set.' };

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

  const campaignId = row?.value != null ? String(row.value) : null;
  if (!campaignId) {
    return { ...base, reason: 'No Smartlead relay campaign is configured yet.' };
  }

  let campaignStatus: string | null = null;
  try {
    const campaign = await slFetch<{ status?: string }>(`/campaigns/${campaignId}`, apiKey);
    campaignStatus = campaign.status ?? null;
  } catch {
    // Status is a nicety; the statistics below are the substance.
  }

  interface StatRow {
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

  let rows: StatRow[] = [];
  try {
    const payload = await slFetch<{ data?: StatRow[] }>(
      `/campaigns/${campaignId}/statistics?limit=500`,
      apiKey,
    );
    rows = payload.data ?? [];
  } catch (error) {
    return {
      ...base,
      configured: true,
      campaignId,
      campaignStatus,
      reason: error instanceof Error ? error.message : 'Could not read campaign statistics.',
    };
  }

  const sent = rows.length;
  const opened = rows.filter((r) => r.open_time).length;
  const clicked = rows.filter((r) => r.click_time).length;
  const replied = rows.filter((r) => r.reply_time).length;
  const bounced = rows.filter((r) => r.is_bounced).length;
  const unsubscribed = rows.filter((r) => r.is_unsubscribed).length;
  const pct = (n: number) => (sent > 0 ? (n / sent) * 100 : 0);

  const recent = rows
    .slice()
    .sort((a, b) => new Date(b.sent_time ?? 0).getTime() - new Date(a.sent_time ?? 0).getTime())
    .slice(0, 25)
    .map((r) => ({
      toEmail: r.lead_email ?? '(unknown)',
      subject: r.email_subject ?? '(no subject)',
      sentAt: r.sent_time ?? null,
      openedAt: r.open_time ?? null,
      clickedAt: r.click_time ?? null,
      repliedAt: r.reply_time ?? null,
      openCount: Number(r.open_count ?? 0),
      clickCount: Number(r.click_count ?? 0),
      bounced: Boolean(r.is_bounced),
      unsubscribed: Boolean(r.is_unsubscribed),
      sequenceNumber: Number(r.sequence_number ?? 1),
    }));

  const data: SmartleadActivity = {
    configured: true,
    campaignId,
    campaignStatus,
    fetchedAt: new Date().toISOString(),
    totals: {
      sent,
      opened,
      clicked,
      replied,
      bounced,
      unsubscribed,
      openRate: pct(opened),
      replyRate: pct(replied),
      bounceRate: pct(bounced),
    },
    recent,
  };

  activityCache.set(organizationId, { at: now, data });
  return data;
}

/** Parse Smartlead's reputation, which arrives as "97%" or a bare number. */
function parseReputation(value: string | number | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : parseFloat(value.replace('%', '').trim());
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toNumber(value: string | number | undefined): number {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

async function slFetch<T>(path: string, apiKey: string): Promise<T> {
  const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Smartlead ${path} → ${response.status} ${text.slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Fetch live warm-up data for every Smartlead mailbox this organization sends
 * from. Cached per-org for 30s so multiple viewers / a polling UI don't hammer
 * the Smartlead API. Pass `forceRefresh` to bypass the cache.
 */
export async function getSmartleadWarmup(
  organizationId: string,
  forceRefresh = false,
): Promise<SmartleadWarmup> {
  const now = Date.now();
  if (!forceRefresh) {
    const hit = cache.get(organizationId);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.data;
  }

  const apiKey = env.SMARTLEAD_API_KEY;
  if (!apiKey) {
    return { configured: false, reason: 'SMARTLEAD_API_KEY is not set.', fetchedAt: new Date().toISOString(), accounts: [] };
  }

  // Scope to this org's Smartlead mailboxes only (tenant boundary).
  const inboxes = await db
    .select({ providerInboxId: sendingInboxes.providerInboxId })
    .from(sendingInboxes)
    .where(
      and(
        eq(sendingInboxes.organizationId, organizationId),
        eq(sendingInboxes.provider, 'smartlead'),
        isNotNull(sendingInboxes.providerInboxId),
      ),
    );

  const wantedIds = new Set(inboxes.map((i) => String(i.providerInboxId)));
  if (wantedIds.size === 0) {
    return {
      configured: false,
      reason: 'No mailboxes are connected to Smartlead yet.',
      fetchedAt: new Date().toISOString(),
      accounts: [],
    };
  }

  const list = await slFetch<RawAccount[]>('/email-accounts', apiKey);
  const mine = list.filter((a) => wantedIds.has(String(a.id)));

  const accounts = await Promise.all(
    mine.map(async (a): Promise<SmartleadAccount> => {
      const details = a.warmup_details ?? {};
      let stats: RawWarmupStats = {};
      try {
        stats = await slFetch<RawWarmupStats>(`/email-accounts/${a.id}/warmup-stats`, apiKey);
      } catch {
        // Summary data is still worth showing even if the per-day call fails.
      }

      const totalWarmupSent = toNumber(stats.sent_count);
      const totalWarmupSpam = toNumber(stats.spam_count);
      const spamRate = totalWarmupSent > 0 ? (totalWarmupSpam / totalWarmupSent) * 100 : null;

      return {
        emailAddress: a.from_email ?? '(unknown)',
        fromName: a.from_name ?? null,
        warmupEnabled: Boolean(a.warmup_enabled),
        warmupStatus: details.status ?? null,
        reputation: parseReputation(details.warmup_reputation ?? a.warmup_reputation),
        smtpConnected: Boolean(a.is_smtp_success),
        imapConnected: Boolean(a.is_imap_success),
        blockedReason: details.blocked_reason ?? null,
        messagePerDay: a.message_per_day ?? null,
        dailySentCount: toNumber(a.daily_sent_count),
        maxWarmupPerDay: details.max_email_per_day ?? null,
        totalWarmupSent,
        totalWarmupSpam,
        warmupInboxCount: toNumber(stats.inbox_count),
        warmupReceived: toNumber(stats.warmup_email_received_count),
        spamRate,
        statsByDate: (stats.stats_by_date ?? []).map((d) => ({
          date: d.date ?? '',
          sent: toNumber(d.sent_count),
          replies: toNumber(d.reply_count),
          savedFromSpam: toNumber(d.save_from_spam_count),
        })),
      };
    }),
  );

  const data: SmartleadWarmup = {
    configured: true,
    fetchedAt: new Date().toISOString(),
    accounts,
  };
  cache.set(organizationId, { at: now, data });
  return data;
}
