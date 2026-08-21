import { z } from 'zod';
import { requireWriteAccess, handleRoute, parseBody, audit } from '@/lib/api-helpers';
import { executeConfirmedAction } from '@/lib/assistant/run';
import { invalidateAiConfigCache } from '@/lib/ai/config';

const bodySchema = z.object({
  toolName: z.string().min(1).max(100),
  input: z.record(z.unknown()).default({}),
});

/**
 * Execute an action the operator confirmed.
 *
 * The write gate is re-checked inside `executeConfirmedAction` rather than
 * trusted from this request — a confirmation POST is as forgeable as any other,
 * so it cannot be the only thing standing between the model and a mutation.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireWriteAccess();
    const body = await parseBody(request, bodySchema);

    const result = await executeConfirmedAction({
      ctx: { organizationId: ctx.organizationId, userId: ctx.userId, canWrite: true },
      toolName: body.toolName,
      input: body.input,
    });

    await audit({
      ctx,
      action: `assistant.${body.toolName}`,
      entityType: 'assistant_action',
      metadata: { input: body.input, ok: result.ok, error: result.error ?? null },
      request,
    });

    // Model and prompt changes are cached for 60s; a confirmed change should be
    // live on the next call, not a minute later.
    if (body.toolName === 'set_ai_model' || body.toolName === 'set_ai_budget') {
      invalidateAiConfigCache(ctx.organizationId);
    }

    if (!result.ok) {
      return { applied: false, error: result.error };
    }

    return { applied: true, result: result.result };
  });
}
