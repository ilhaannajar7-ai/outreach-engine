import { z } from 'zod';
import { requireAuth, handleRoute, parseBody } from '@/lib/api-helpers';
import { runAssistantTurn } from '@/lib/assistant/run';
import type { AiConversationTurn } from '@/lib/providers/ai';

/**
 * Prior turns are replayed from the client.
 *
 * Only plain user/assistant prose is accepted — tool traffic is rebuilt inside
 * the loop each turn. A client that could inject arbitrary `tool_results` could
 * feed the model fabricated data about the account, so that shape is simply not
 * representable here.
 */
const historyTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(8000),
});

const bodySchema = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(historyTurnSchema).max(20).default([]),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const ctx = await requireAuth();
    const body = await parseBody(request, bodySchema);

    const history: AiConversationTurn[] = body.history.map((turn) =>
      turn.role === 'user'
        ? { role: 'user', content: turn.content }
        : { role: 'assistant', content: turn.content },
    );

    const result = await runAssistantTurn({
      ctx: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        canWrite: ctx.role !== 'viewer',
      },
      message: body.message,
      history,
    });

    return {
      reply: result.reply,
      pendingAction: result.pendingAction,
      toolsUsed: result.toolsUsed,
      costUsd: Number(result.costUsd.toFixed(5)),
    };
  });
}
