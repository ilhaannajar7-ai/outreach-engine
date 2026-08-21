import { z } from 'zod';
import { db } from '@/db';
import { settings } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { env } from '@/lib/env';
import { requireAuth, requireAdmin, handleRoute, parseBody, audit } from '@/lib/api-helpers';

const KEYS = [
  'global_daily_send_limit',
  'require_email_verification',
  'auto_research_on_import',
] as const;

export async function GET() {
  return handleRoute(async () => {
    const ctx = await requireAuth();

    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(and(eq(settings.organizationId, ctx.organizationId), inArray(settings.key, [...KEYS])));

    const map = new Map(rows.map((r) => [r.key, r.value]));

    return {
      globalDailySendLimit: Number(map.get('global_daily_send_limit') ?? env.GLOBAL_DAILY_SEND_LIMIT),
      requireEmailVerification: map.get('require_email_verification') !== false,
      autoResearchOnImport: map.get('auto_research_on_import') === true,
      sendWindow: {
        startHour: env.SEND_WINDOW_START_HOUR,
        endHour: env.SEND_WINDOW_END_HOUR,
        timezone: env.SEND_TIMEZONE,
      },
    };
  });
}

const updateSchema = z.object({
  globalDailySendLimit: z.number().int().min(1).max(5000).optional(),
  requireEmailVerification: z.boolean().optional(),
  autoResearchOnImport: z.boolean().optional(),
});

export async function PATCH(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const body = await parseBody(request, updateSchema);

    const writes: { key: string; value: unknown; valueType: string }[] = [];
    if (body.globalDailySendLimit !== undefined)
      writes.push({
        key: 'global_daily_send_limit',
        value: body.globalDailySendLimit,
        valueType: 'number',
      });
    if (body.requireEmailVerification !== undefined)
      writes.push({
        key: 'require_email_verification',
        value: body.requireEmailVerification,
        valueType: 'boolean',
      });
    if (body.autoResearchOnImport !== undefined)
      writes.push({
        key: 'auto_research_on_import',
        value: body.autoResearchOnImport,
        valueType: 'boolean',
      });

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

    await audit({
      ctx,
      action: 'settings.limits',
      entityType: 'settings',
      changes: body,
      request,
    });

    return { message: 'Saved. This applies to the next send.' };
  });
}
