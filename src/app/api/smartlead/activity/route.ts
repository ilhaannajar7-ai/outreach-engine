import { requireAuth, handleRoute } from '@/lib/api-helpers';
import { getSmartleadActivity } from '@/lib/smartlead/warmup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Live sending + engagement for the relay campaign, straight from Smartlead.
 * The dashboard polls this; `?refresh=1` bypasses the 30s server cache.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const forceRefresh = new URL(request.url).searchParams.get('refresh') === '1';
    return getSmartleadActivity(ctx.organizationId, forceRefresh);
  });
}
