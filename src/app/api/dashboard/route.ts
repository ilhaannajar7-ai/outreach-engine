import { requireAuth, handleRoute, parseQuery } from '@/lib/api-helpers';
import { getDashboardData } from '@/lib/queries/dashboard';
import { z } from 'zod';

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(14),
});

export async function GET(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const { days } = parseQuery(request, querySchema);
    return getDashboardData(ctx.organizationId, days);
  });
}
