/**
 * AI budget enforcement.
 *
 * Every AI call passes through `assertWithinBudget` first. The check is a SUM
 * over `ai_usage` for the current billing period — never an in-memory counter,
 * because a worker restart must not reset the month's spend to zero.
 *
 * Two thresholds:
 *   warn ($16 default) — notification, work continues
 *   stop ($20 default) — BudgetExceededError, non-essential AI halts
 */

import { db } from '@/db';
import { aiUsage, settings, type AiOperation } from '@/db/schema';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { env } from '@/lib/env';
import { ts } from '@/db/sql-helpers';

export class BudgetExceededError extends Error {
  constructor(
    readonly spent: number,
    readonly limit: number,
    readonly operation: AiOperation,
  ) {
    super(
      `Monthly AI budget reached: $${spent.toFixed(2)} of $${limit.toFixed(2)} used. ` +
        `Operation "${operation}" was blocked. Raise the limit in Settings → AI Configuration, ` +
        `or wait for the next billing period.`,
    );
    this.name = 'BudgetExceededError';
  }
}

/** 'YYYY-MM' in UTC — matches the ai_usage.billing_period column. */
export function currentBillingPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface BudgetStatus {
  spent: number;
  warnAt: number;
  stopAt: number;
  remaining: number;
  percentUsed: number;
  isWarning: boolean;
  isExceeded: boolean;
  billingPeriod: string;
  callCount: number;
}

/**
 * Thresholds come from the settings table when present so the dashboard can
 * change them without a redeploy; env values are the boot fallback.
 */
async function getThresholds(organizationId: string): Promise<{ warnAt: number; stopAt: number }> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.organizationId, organizationId),
        dsql`${settings.key} IN ('ai_budget_warn', 'ai_budget_stop')`,
      ),
    );

  const map = new Map(rows.map((r) => [r.key, r.value]));
  const warn = Number(map.get('ai_budget_warn'));
  const stop = Number(map.get('ai_budget_stop'));

  return {
    warnAt: Number.isFinite(warn) && warn > 0 ? warn : env.AI_MONTHLY_BUDGET_WARN,
    stopAt: Number.isFinite(stop) && stop > 0 ? stop : env.AI_MONTHLY_BUDGET_STOP,
  };
}

export async function getBudgetStatus(
  organizationId: string,
  period = currentBillingPeriod(),
): Promise<BudgetStatus> {
  const [row] = await db
    .select({
      total: dsql<string>`COALESCE(SUM(${aiUsage.costUsd}), 0)`,
      count: dsql<number>`COUNT(*)::int`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.organizationId, organizationId), eq(aiUsage.billingPeriod, period)));

  const spent = Number(row?.total ?? 0);
  const { warnAt, stopAt } = await getThresholds(organizationId);

  return {
    spent,
    warnAt,
    stopAt,
    remaining: Math.max(0, stopAt - spent),
    percentUsed: stopAt > 0 ? (spent / stopAt) * 100 : 0,
    isWarning: spent >= warnAt,
    isExceeded: spent >= stopAt,
    billingPeriod: period,
    callCount: row?.count ?? 0,
  };
}

/**
 * Gate called before every AI request.
 *
 * `estimatedCost` is added to current spend before comparing, so a call that
 * would cross the cap is refused rather than allowed to overshoot it.
 */
export async function assertWithinBudget(
  organizationId: string,
  operation: AiOperation,
  estimatedCost = 0,
): Promise<BudgetStatus> {
  const status = await getBudgetStatus(organizationId);

  if (status.spent + estimatedCost >= status.stopAt) {
    throw new BudgetExceededError(status.spent, status.stopAt, operation);
  }

  return status;
}

/**
 * Record a completed call. Always called — including on failure — so a burst of
 * errored-but-billed calls still counts against the cap.
 */
export async function recordAiUsage(params: {
  organizationId: string;
  operation: AiOperation;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  leadId?: string | null;
  companyId?: string | null;
  durationMs?: number;
  success?: boolean;
  errorMessage?: string | null;
}): Promise<void> {
  await db.insert(aiUsage).values({
    organizationId: params.organizationId,
    operation: params.operation,
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cacheReadTokens: params.cacheReadTokens ?? 0,
    cacheWriteTokens: params.cacheWriteTokens ?? 0,
    costUsd: params.costUsd.toFixed(6),
    leadId: params.leadId ?? null,
    companyId: params.companyId ?? null,
    billingPeriod: currentBillingPeriod(),
    durationMs: params.durationMs ?? null,
    success: params.success ?? true,
    errorMessage: params.errorMessage ?? null,
  });
}

/** Per-operation spend breakdown for the dashboard's cost meter. */
export async function getUsageByOperation(
  organizationId: string,
  period = currentBillingPeriod(),
): Promise<{ operation: AiOperation; costUsd: number; callCount: number; tokens: number }[]> {
  const rows = await db
    .select({
      operation: aiUsage.operation,
      costUsd: dsql<string>`COALESCE(SUM(${aiUsage.costUsd}), 0)`,
      callCount: dsql<number>`COUNT(*)::int`,
      tokens: dsql<number>`COALESCE(SUM(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)::int`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.organizationId, organizationId), eq(aiUsage.billingPeriod, period)))
    .groupBy(aiUsage.operation);

  return rows.map((r) => ({
    operation: r.operation,
    costUsd: Number(r.costUsd),
    callCount: r.callCount,
    tokens: r.tokens,
  }));
}

/** Daily spend series for the cost chart. */
export async function getDailySpend(
  organizationId: string,
  days = 30,
): Promise<{ date: string; costUsd: number; callCount: number }[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      date: dsql<string>`TO_CHAR(DATE_TRUNC('day', ${aiUsage.createdAt}), 'YYYY-MM-DD')`,
      costUsd: dsql<string>`COALESCE(SUM(${aiUsage.costUsd}), 0)`,
      callCount: dsql<number>`COUNT(*)::int`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.organizationId, organizationId), dsql`${aiUsage.createdAt} >= ${ts(since)}`))
    .groupBy(dsql`DATE_TRUNC('day', ${aiUsage.createdAt})`)
    .orderBy(dsql`DATE_TRUNC('day', ${aiUsage.createdAt})`);

  return rows.map((r) => ({
    date: r.date,
    costUsd: Number(r.costUsd),
    callCount: r.callCount,
  }));
}
