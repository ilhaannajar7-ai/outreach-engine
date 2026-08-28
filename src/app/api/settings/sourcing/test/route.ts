import { requireAdmin, handleRoute } from '@/lib/api-helpers';
import { getSourcingService } from '@/lib/providers/sourcing';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Probe the configured sourcing provider and report the real result.
 *
 * Worth its own endpoint because "configured" and "working" are different
 * things: an Apollo key on a trial plan is present and valid but still cannot
 * call the search API. Showing that plainly beats an enabled-looking toggle
 * that silently finds nothing.
 */
export async function POST() {
  return handleRoute(async () => {
    await requireAdmin();

    if (env.SOURCING_PROVIDER === 'none') {
      return {
        ok: false,
        provider: 'none',
        message: 'No sourcing provider is configured. Set SOURCING_PROVIDER=apollo and APOLLO_API_KEY.',
      };
    }

    const service = getSourcingService();
    const result = await service.healthCheck();

    if (result.ok) {
      return {
        ok: true,
        provider: service.name,
        latencyMs: result.latencyMs,
        message: `${service.name} is reachable and the search API is available.`,
      };
    }

    const raw = result.error ?? 'Unknown error';
    // Apollo's trial plans return 403 API_INACCESSIBLE — the single most likely
    // failure here, and one no amount of retrying will fix.
    const planBlocked = /not included in your|API_INACCESSIBLE|403/i.test(raw);

    return {
      ok: false,
      provider: service.name,
      latencyMs: result.latencyMs,
      message: planBlocked
        ? `${service.name} rejected the request because your plan does not include API access. ` +
          'Apollo search requires a paid plan — upgrade at apollo.io/pricing, then test again.'
        : `${service.name} could not be reached: ${raw}`,
      detail: raw.slice(0, 400),
    };
  });
}
