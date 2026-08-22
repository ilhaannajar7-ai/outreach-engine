/**
 * Job: source_leads
 *
 * The front of the funnel. Asks the sourcing provider which companies are
 * hiring for the roles we staff, creates the ones we have never seen, and hands
 * each straight to find_contacts with thenResearch — so a sourced company walks
 * itself to a draft in the approval queue without anyone touching it.
 *
 * Three things keep an autonomous job that spends money honest:
 *   - it is off unless SOURCING_PROVIDER is set and the org enabled it
 *   - a per-run cap bounds the spend of any single run
 *   - domains already in the database are skipped before any credit is spent
 *
 * It deliberately stops at the draft. Sending still requires a human approval,
 * exactly as it does for a CSV-imported lead.
 */

import { db } from '@/db';
import { companies, settings } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { getSourcingService, SourcingQuotaError } from '@/lib/providers/sourcing';
import { getJobQueue } from '@/lib/providers/queue';
import { recordApiUsage } from '@/lib/enrichment/usage';
import { notifyHandled, notifyStopped } from '@/lib/notifications';
import { env } from '@/lib/env';
import type { JobHandler } from '../types';

/** Settings keys that configure autonomous sourcing. */
export const SOURCING_KEYS = [
  'auto_sourcing_enabled',
  'sourcing_job_titles',
  'sourcing_locations',
  'sourcing_employee_ranges',
  'sourcing_daily_limit',
  'sourcing_page_cursor',
] as const;

export interface SourcingConfig {
  enabled: boolean;
  jobTitles: string[];
  locations: string[];
  employeeRanges: string[];
  dailyLimit: number;
  pageCursor: number;
}

/** Roles an outsourcing provider can actually staff — the default hunt. */
const DEFAULT_JOB_TITLES = [
  'Accounts Payable',
  'Accounts Receivable',
  'Bookkeeper',
  'Data Entry',
  'Customer Support Representative',
  'Virtual Assistant',
];

export async function getSourcingConfig(organizationId: string): Promise<SourcingConfig> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      and(eq(settings.organizationId, organizationId), inArray(settings.key, [...SOURCING_KEYS])),
    );

  const map = new Map(rows.map((r) => [r.key, r.value]));

  return {
    enabled: map.get('auto_sourcing_enabled') === true,
    jobTitles: asStringArray(map.get('sourcing_job_titles')) ?? DEFAULT_JOB_TITLES,
    locations: asStringArray(map.get('sourcing_locations')) ?? [],
    employeeRanges: asStringArray(map.get('sourcing_employee_ranges')) ?? ['11,50', '51,200'],
    dailyLimit: asNumber(map.get('sourcing_daily_limit')) ?? 25,
    pageCursor: asNumber(map.get('sourcing_page_cursor')) ?? 1,
  };
}

export const sourceLeadsHandler: JobHandler<{
  /** Overrides the configured cap for a manual "run it now" from the dashboard. */
  limit?: number;
  /** Manual runs bypass the enabled flag; the scheduled run never does. */
  force?: boolean;
}> = async (job) => {
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('source_leads requires an organizationId');

  if (env.SOURCING_PROVIDER === 'none') {
    return { skipped: true, reason: 'No sourcing provider configured (SOURCING_PROVIDER=none).' };
  }

  const config = await getSourcingConfig(organizationId);
  if (!config.enabled && !job.payload.force) {
    return { skipped: true, reason: 'Auto-sourcing is disabled for this organization.' };
  }

  const limit = Math.min(job.payload.limit ?? config.dailyLimit, 100);
  const service = getSourcingService();
  const started = Date.now();

  let sourced;
  try {
    sourced = await service.findHiringCompanies({
      jobTitles: config.jobTitles,
      locations: config.locations,
      employeeRanges: config.employeeRanges,
      limit,
      page: config.pageCursor,
    });
    await recordApiUsage({
      organizationId,
      provider: service.name,
      endpoint: 'find_hiring_companies',
      creditsUsed: sourced.length,
      success: true,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordApiUsage({
      organizationId,
      provider: service.name,
      endpoint: 'find_hiring_companies',
      success: false,
      errorMessage: message,
      durationMs: Date.now() - started,
    });

    // Out of credits is a stop-and-ask, not a retry — retrying cannot succeed
    // and each attempt re-hits a provider that has already said no.
    if (error instanceof SourcingQuotaError) {
      await notifyStopped(
        organizationId,
        'Lead sourcing stopped — provider credits exhausted',
        message,
        { actionUrl: '/settings', actionLabel: 'Review sourcing settings' },
      );
      return { skipped: true, reason: message };
    }
    throw error;
  }

  if (!sourced.length) {
    // An empty page usually means the cursor walked past the end of the result
    // set, so reset it rather than returning nothing again tomorrow.
    await setSetting(organizationId, 'sourcing_page_cursor', 1);
    return { sourced: 0, created: 0, reason: 'No companies returned; page cursor reset to 1.' };
  }

  // One query instead of one per company, and it costs nothing to check.
  const domains = sourced.map((c) => c.domain);
  const existing = await db
    .select({ domain: companies.domain })
    .from(companies)
    .where(and(eq(companies.organizationId, organizationId), inArray(companies.domain, domains)));
  const known = new Set(existing.map((r) => r.domain));

  const fresh = sourced.filter((c) => !known.has(c.domain));

  const queue = getJobQueue();
  let created = 0;

  for (const candidate of fresh) {
    const [company] = await db
      .insert(companies)
      .values({
        organizationId,
        name: candidate.name,
        domain: candidate.domain,
        website: candidate.website ?? null,
        industry: candidate.industry ?? null,
        sizeRange: candidate.sizeRange ?? null,
        location: candidate.location ?? null,
        country: candidate.country ?? null,
        linkedinUrl: candidate.linkedinUrl ?? null,
        description: candidate.description ?? null,
        hiringSignal: candidate.hiringSignal ?? null,
        hiringSignalSource: service.name,
        hiringSignalUrl: candidate.hiringSignalUrl ?? null,
        hiringSignalSeenAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: companies.id });

    // A concurrent run won the race for this domain — nothing to do.
    if (!company) continue;
    created += 1;

    await queue.enqueue(
      'find_contacts',
      { companyId: company.id, campaignId: null, thenResearch: true },
      {
        organizationId,
        idempotencyKey: `find_contacts:${company.id}`,
      },
    );
  }

  // Walk to the next page so tomorrow's run sees new companies instead of
  // re-reading the same ones and skipping them all as duplicates.
  await setSetting(organizationId, 'sourcing_page_cursor', config.pageCursor + 1);

  if (created > 0) {
    await notifyHandled(
      organizationId,
      `${created} new ${created === 1 ? 'company' : 'companies'} sourced`,
      `Found ${sourced.length} hiring ${sourced.length === 1 ? 'company' : 'companies'}, ` +
        `${created} new. Contact discovery and research are running; drafts will appear in the approval queue.`,
      { actionUrl: '/leads', actionLabel: 'View leads' },
    );
  }

  return {
    sourced: sourced.length,
    created,
    duplicates: sourced.length - fresh.length,
    nextPage: config.pageCursor + 1,
  };
};

async function setSetting(organizationId: string, key: string, value: unknown): Promise<void> {
  const existing = await db
    .select({ id: settings.id })
    .from(settings)
    .where(and(eq(settings.organizationId, organizationId), eq(settings.key, key)))
    .limit(1);

  if (existing.length) {
    await db
      .update(settings)
      .set({ value, updatedAt: new Date() })
      .where(eq(settings.id, existing[0]!.id));
    return;
  }

  await db.insert(settings).values({
    organizationId,
    key,
    value,
    valueType: typeof value === 'number' ? 'number' : 'json',
  });
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return items.length ? items : undefined;
}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
