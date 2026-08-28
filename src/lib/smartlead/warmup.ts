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
import { sendingInboxes } from '@/db/schema';
import { env } from '@/lib/env';

const API_BASE = 'https://server.smartlead.ai/api/v1';
const CACHE_TTL_MS = 30_000;

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
