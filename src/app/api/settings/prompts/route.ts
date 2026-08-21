import { z } from 'zod';
import { db } from '@/db';
import { aiPrompts, type AiOperation } from '@/db/schema';
import { and, eq, desc, sql as dsql } from 'drizzle-orm';
import { DEFAULT_PROMPTS } from '@/lib/ai/prompts';
import { invalidateAiConfigCache } from '@/lib/ai/config';
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

    const prompts = await db
      .select()
      .from(aiPrompts)
      .where(eq(aiPrompts.organizationId, ctx.organizationId))
      .orderBy(aiPrompts.operation, desc(aiPrompts.version));

    // Group so the UI can show the active version plus its history.
    const byOperation = new Map<string, typeof prompts>();
    for (const prompt of prompts) {
      const list = byOperation.get(prompt.operation) ?? [];
      list.push(prompt);
      byOperation.set(prompt.operation, list);
    }

    return {
      prompts: Object.fromEntries(byOperation),
      defaults: DEFAULT_PROMPTS,
    };
  });
}

const operationEnum = z.enum([
  'research',
  'email_generation',
  'follow_up_generation',
  'reply_classification',
]);

const updateSchema = z.object({
  operation: operationEnum,
  systemPrompt: z.string().min(20).max(20000),
  userPromptTemplate: z.string().min(20).max(20000),
});

/**
 * Save a prompt.
 *
 * Editing writes a NEW version and deactivates the previous one — nothing is
 * overwritten, so a bad edit is one click from being undone.
 */
export async function PATCH(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const body = await parseBody(request, updateSchema);
    const operation = body.operation as AiOperation;

    // Every {{variable}} the template uses must be one the code actually
    // supplies, or it renders empty at generation time and silently degrades
    // output quality.
    const known = new Set(
      (DEFAULT_PROMPTS[operation].userPromptTemplate.match(/\{\{(\w+)\}\}/g) ?? []).map((v) =>
        v.slice(2, -2),
      ),
    );
    const used = (body.userPromptTemplate.match(/\{\{(\w+)\}\}/g) ?? []).map((v) => v.slice(2, -2));
    const unknown = [...new Set(used.filter((v) => !known.has(v)))];

    if (unknown.length > 0) {
      throw new ApiError(
        400,
        `Unknown template variables: ${unknown.map((v) => `{{${v}}}`).join(', ')}. ` +
          `Available for this operation: ${[...known].map((v) => `{{${v}}}`).join(', ')}.`,
        'UNKNOWN_VARIABLES',
      );
    }

    const [current] = await db
      .select({ version: aiPrompts.version })
      .from(aiPrompts)
      .where(
        and(eq(aiPrompts.organizationId, ctx.organizationId), eq(aiPrompts.operation, operation)),
      )
      .orderBy(desc(aiPrompts.version))
      .limit(1);

    const nextVersion = (current?.version ?? 0) + 1;

    await db
      .update(aiPrompts)
      .set({ isActive: false })
      .where(
        and(eq(aiPrompts.organizationId, ctx.organizationId), eq(aiPrompts.operation, operation)),
      );

    const [created] = await db
      .insert(aiPrompts)
      .values({
        organizationId: ctx.organizationId,
        operation,
        version: nextVersion,
        systemPrompt: body.systemPrompt,
        userPromptTemplate: body.userPromptTemplate,
        isActive: true,
        updatedBy: ctx.userId,
      })
      .returning();

    invalidateAiConfigCache(ctx.organizationId, operation);

    await audit({
      ctx,
      action: 'settings.prompt_update',
      entityType: 'ai_prompt',
      entityId: created!.id,
      metadata: { operation, version: nextVersion },
      request,
    });

    return {
      prompt: created,
      message: `Saved as version ${nextVersion}. It applies to the next ${operation.replace(/_/g, ' ')} call. Cached research is not re-run.`,
    };
  });
}

const revertSchema = z.object({
  operation: operationEnum,
  version: z.number().int().positive(),
});

/** Roll back to an earlier version. */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAdmin();
    const body = await parseBody(request, revertSchema);
    const operation = body.operation as AiOperation;

    const [target] = await db
      .select()
      .from(aiPrompts)
      .where(
        and(
          eq(aiPrompts.organizationId, ctx.organizationId),
          eq(aiPrompts.operation, operation),
          eq(aiPrompts.version, body.version),
        ),
      )
      .limit(1);

    if (!target) throw new ApiError(404, `Version ${body.version} not found.`, 'NOT_FOUND');

    await db
      .update(aiPrompts)
      .set({ isActive: false })
      .where(
        and(eq(aiPrompts.organizationId, ctx.organizationId), eq(aiPrompts.operation, operation)),
      );

    await db
      .update(aiPrompts)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(aiPrompts.id, target.id));

    invalidateAiConfigCache(ctx.organizationId, operation);

    await audit({
      ctx,
      action: 'settings.prompt_revert',
      entityType: 'ai_prompt',
      entityId: target.id,
      metadata: { operation, version: body.version },
      request,
    });

    return { prompt: target, message: `Reverted to version ${body.version}.` };
  });
}
