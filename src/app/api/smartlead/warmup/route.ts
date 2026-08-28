import { requireAuth, handleRoute } from '@/lib/api-helpers';
import { getSmartleadWarmup } from '@/lib/smartlead/warmup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Live Smartlead warm-up / deliverability data for the current org's mailboxes.
 * The dashboard panel polls this. `?refresh=1` bypasses the 30s server cache.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const forceRefresh = new URL(request.url).searchParams.get('refresh') === '1';
    return getSmartleadWarmup(ctx.organizationId, forceRefresh);
  });
}
