import { z } from 'zod';
import { db } from '@/db';
import { aiModelConfig, settings, type AiOperation } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { AVAILABLE_MODELS, invalidateAiConfigCache } from '@/lib/ai/config';
import { getBudgetStatus, getUsageByOperation, getDailySpend } from '@/lib/ai/budget';
import {
  requireAuth,
  requireAdmin,
  handleRoute,
  parseBody,
  audit,
  ApiError,
} from '@/lib/api-helpers';

export async function GET() {
  return handleRoute(async () => {
    const ctx = await requireAuth();

    const [models, budget, byOperation, dailySpend] = await Promise.all([
      db.select().from(aiModelConfig).where(eq(aiModelConfig.organizationId, ctx.organizationId)),
      getBudgetStatus(ctx.organizationId),
      getUsageByOperation(ctx.organizationId),
      getDailySpend(ctx.organizationId, 30),
    ]);

    return { models, availableModels: AVAILABLE_MODELS, budget, byOperation, dailySpend };
  });
}

const operationEnum = z.enum([
  'research',
  'email_generation',
  'follow_up_generation',
  'reply_classification',
]);

const updateSchema = z.object({
  models: z
    .array(
      z.object({
        operation: operationEnum,
        model: z.string().min(1).max(100),
        maxTokens: z.number().int().min(100).max(8192).optional(),
        temperature: z.number().min(0).max(2).optional(),
        isEnabled: z.boolean().optional(),
      }),
    )
    .optional(),
  budgetWarn: z.number().positive().max(10000).optional(),
  budgetStop: z.number().positive().max(10000).optional(),
});

/** Change model assignment and budget thresholds. No deploy required. */
export async function PATCH(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const body = await parseBody(request, updateSchema);

    if (body.budgetWarn !== undefined && body.budgetStop !== undefined) {
      if (body.budgetWarn >= body.budgetStop) {
        throw new ApiError(
          400,
          'The warning threshold must be lower than the stop threshold.',
          'INVALID_BUDGET',
        );
      }
    }

    const validModelIds = new Set(AVAILABLE_MODELS.map((m) => m.id));

    if (body.models) {
      for (const entry of body.models) {
        if (!validModelIds.has(entry.model as never)) {
          throw new ApiError(
            400,
            `"${entry.model}" is not an available model. Choose one of: ${[...validModelIds].join(', ')}.`,
            'INVALID_MODEL',
          );
        }

        await db
          .insert(aiModelConfig)
          .values({
            organizationId: ctx.organizationId,
            operation: entry.operation as AiOperation,
            model: entry.model,
            maxTokens: entry.maxTokens ?? 2048,
            temperature: (entry.temperature ?? 1).toFixed(2),
            isEnabled: entry.isEnabled ?? true,
            updatedBy: ctx.userId,
          })
          .onConflictDoUpdate({
            target: [aiModelConfig.organizationId, aiModelConfig.operation],
            set: {
              model: entry.model,
              ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
              ...(entry.temperature !== undefined
                ? { temperature: entry.temperature.toFixed(2) }
                : {}),
              ...(entry.isEnabled !== undefined ? { isEnabled: entry.isEnabled } : {}),
              updatedBy: ctx.userId,
              updatedAt: new Date(),
            },
          });
      }
    }

    for (const [key, value] of [
      ['ai_budget_warn', body.budgetWarn],
      ['ai_budget_stop', body.budgetStop],
    ] as const) {
      if (value === undefined) continue;

      await db
        .insert(settings)
        .values({
          organizationId: ctx.organizationId,
          key,
          value,
          valueType: 'number',
          updatedBy: ctx.userId,
        })
        .onConflictDoUpdate({
          target: [settings.organizationId, settings.key],
          set: { value, updatedBy: ctx.userId, updatedAt: new Date() },
        });
    }

    // Without this the change would not take effect for up to 60 seconds.
    invalidateAiConfigCache(ctx.organizationId);

    await audit({
      ctx,
      action: 'settings.ai_update',
      entityType: 'ai_config',
      changes: body,
      request,
    });

    const [models, budget] = await Promise.all([
      db.select().from(aiModelConfig).where(eq(aiModelConfig.organizationId, ctx.organizationId)),
      getBudgetStatus(ctx.organizationId),
    ]);

    return { models, budget, message: 'Saved. Changes apply to the next AI call.' };
  });
}
