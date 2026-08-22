/**
 * Autonomous lead-sourcing configuration.
 *
 * Read and change what the daily source_leads job hunts for, plus the two
 * switches that decide how far a sourced company travels on its own:
 * auto-sourcing (find companies) and auto-generate (draft the email once
 * research is strong). Approval is never automated and is not configurable
 * here — sending always waits for a human.
 */

import { z } from 'zod';
import { db } from '@/db';
import { settings } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { env } from '@/lib/env';
import { getJobQueue } from '@/lib/providers/queue';
import { requireAuth, requireAdmin, handleRoute, parseBody, audit } from '@/lib/api-helpers';

const KEYS = [
  'auto_sourcing_enabled',
  'auto_generate_after_research',
  'sourcing_job_titles',
  'sourcing_locations',
  'sourcing_employee_ranges',
  'sourcing_daily_limit',
  'sourcing_page_cursor',
] as const;

const DEFAULT_JOB_TITLES = [
  'Accounts Payable',
  'Accounts Receivable',
  'Bookkeeper',
  'Data Entry',
  'Customer Support Representative',
  'Virtual Assistant',
];

export async function GET() {
  return handleRoute(async () => {
    const ctx = await requireAuth();

    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(and(eq(settings.organizationId, ctx.organizationId), inArray(settings.key, [...KEYS])));

    const map = new Map(rows.map((r) => [r.key, r.value]));

    return {
      // Without a provider the toggles are inert — say so rather than showing
      // an "enabled" switch that silently does nothing.
      provider: env.SOURCING_PROVIDER,
      providerConfigured: env.SOURCING_PROVIDER !== 'none',
      autoSourcingEnabled: map.get('auto_sourcing_enabled') === true,
      autoGenerateAfterResearch: map.get('auto_generate_after_research') === true,
      jobTitles: asStringArray(map.get('sourcing_job_titles')) ?? DEFAULT_JOB_TITLES,
      locations: asStringArray(map.get('sourcing_locations')) ?? [],
      employeeRanges: asStringArray(map.get('sourcing_employee_ranges')) ?? ['11,50', '51,200'],
      dailyLimit: asNumber(map.get('sourcing_daily_limit')) ?? 25,
      pageCursor: asNumber(map.get('sourcing_page_cursor')) ?? 1,
    };
  });
}

const updateSchema = z.object({
  autoSourcingEnabled: z.boolean().optional(),
  autoGenerateAfterResearch: z.boolean().optional(),
  jobTitles: z.array(z.string().min(1).max(100)).min(1).max(25).optional(),
  locations: z.array(z.string().min(1).max(100)).max(25).optional(),
  employeeRanges: z.array(z.string().min(1).max(30)).max(10).optional(),
  dailyLimit: z.number().int().min(1).max(100).optional(),
  /** Reset paging to re-walk the result set from the top. */
  resetPageCursor: z.boolean().optional(),
  /** Queue one run immediately instead of waiting for the 07:00 schedule. */
  runNow: z.boolean().optional(),
});

export async function PATCH(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const body = await parseBody(request, updateSchema);

    const writes: { key: string; value: unknown; valueType: string }[] = [];
    const push = (key: string, value: unknown, valueType: string) =>
      writes.push({ key, value, valueType });

    if (body.autoSourcingEnabled !== undefined)
      push('auto_sourcing_enabled', body.autoSourcingEnabled, 'boolean');
    if (body.autoGenerateAfterResearch !== undefined)
      push('auto_generate_after_research', body.autoGenerateAfterResearch, 'boolean');
    if (body.jobTitles !== undefined) push('sourcing_job_titles', body.jobTitles, 'json');
    if (body.locations !== undefined) push('sourcing_locations', body.locations, 'json');
    if (body.employeeRanges !== undefined)
      push('sourcing_employee_ranges', body.employeeRanges, 'json');
    if (body.dailyLimit !== undefined) push('sourcing_daily_limit', body.dailyLimit, 'number');
    if (body.resetPageCursor) push('sourcing_page_cursor', 1, 'number');

    for (const write of writes) {
      await db
        .insert(settings)
        .values({
          organizationId: ctx.organizationId,
          key: write.key,
          value: write.value,
          valueType: write.valueType,
          updatedBy: ctx.userId,
        })
        .onConflictDoUpdate({
          target: [settings.organizationId, settings.key],
          set: { value: write.value, updatedBy: ctx.userId, updatedAt: new Date() },
        });
    }

    let queued = false;
    if (body.runNow) {
      // force:true so a manual run works before the toggle is flipped on —
      // that is how you test the criteria without committing to a daily job.
      await getJobQueue().enqueue(
        'source_leads',
        { force: true },
        {
          organizationId: ctx.organizationId,
          idempotencyKey: `source:manual:${ctx.organizationId}:${Date.now()}`,
        },
      );
      queued = true;
    }

    await audit({
      ctx,
      action: 'settings.sourcing',
      entityType: 'settings',
      changes: body,
      request,
    });

    return {
      message: queued
        ? 'Saved. A sourcing run is queued — new companies appear in Leads shortly.'
        : 'Saved. This applies to the next sourcing run.',
      queued,
    };
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
