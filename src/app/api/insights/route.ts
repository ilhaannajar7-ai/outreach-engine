import { requireAuth, requireWriteAccess, handleRoute } from '@/lib/api-helpers';
import { getStoredWeeklyInsights, generateWeeklyInsights } from '@/lib/insights/weekly';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The most recent weekly analysis. Generated on Mondays, or on demand below. */
export async function GET() {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const report = await getStoredWeeklyInsights(ctx.organizationId);
    return { report };
  });
}

/** Regenerate now rather than waiting for Monday. Costs one small AI call. */
export async function POST() {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const report = await generateWeeklyInsights(ctx.organizationId, 7);
    return { report };
  });
}
