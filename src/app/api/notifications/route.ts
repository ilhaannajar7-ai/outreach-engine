import { z } from 'zod';
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  resolveNotification,
} from '@/lib/notifications';
import { requireAuth, handleRoute, parseQuery, parseBody } from '@/lib/api-helpers';

const querySchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const query = parseQuery(request, querySchema);

    const [items, unreadCount] = await Promise.all([
      getNotifications(ctx.organizationId, {
        unreadOnly: query.unreadOnly === 'true',
        limit: query.limit,
      }),
      getUnreadCount(ctx.organizationId),
    ]);

    return { notifications: items, unreadCount };
  });
}

const actionSchema = z.object({
  action: z.enum(['read', 'read_all', 'resolve']),
  id: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const body = await parseBody(request, actionSchema);

    if (body.action === 'read_all') {
      await markAllAsRead(ctx.organizationId);
    } else if (body.id) {
      if (body.action === 'read') await markAsRead(body.id, ctx.organizationId);
      else await resolveNotification(body.id, ctx.organizationId);
    }

    return { unreadCount: await getUnreadCount(ctx.organizationId) };
  });
}
