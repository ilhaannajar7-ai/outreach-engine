/**
 * Record a third-party enrichment call in `api_usage`.
 *
 * Hunter is metered separately from the AI budget: it has its own monthly
 * credit allowance, and the dashboard needs to show how much of it the pipeline
 * is burning so a discovery run cannot quietly exhaust the month's searches.
 */

import { db } from '@/db';
import { apiUsage } from '@/db/schema';

export async function recordApiUsage(params: {
  organizationId: string;
  provider: string;
  endpoint: string;
  creditsUsed?: number;
  success: boolean;
  statusCode?: number;
  errorMessage?: string;
  durationMs?: number;
}): Promise<void> {
  const billingPeriod = new Date().toISOString().slice(0, 7); // YYYY-MM

  await db
    .insert(apiUsage)
    .values({
      organizationId: params.organizationId,
      provider: params.provider,
      endpoint: params.endpoint,
      creditsUsed: params.creditsUsed ?? 1,
      billingPeriod,
      success: params.success,
      statusCode: params.statusCode ?? null,
      errorMessage: params.errorMessage ?? null,
      durationMs: params.durationMs ?? null,
    })
    // Metering must never take down the operation it is measuring.
    .catch(() => {});
}
