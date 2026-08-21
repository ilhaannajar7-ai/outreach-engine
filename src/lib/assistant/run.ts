/**
 * The assistant loop.
 *
 * A manual loop rather than the SDK's tool runner, for one reason: the write
 * gate. When the model asks for a tool that changes something, the loop must
 * stop and hand the *exact tool name and arguments* back to the UI, so the
 * operator confirms the real parameters rather than the model's description of
 * them. A runner that executes tools internally cannot offer that.
 *
 * Read tools run freely inside the loop. Write tools never execute here at all.
 */

import {
  getAiService,
  AiFatalError,
  AiRetryableError,
  type AiConversationTurn,
  type AiToolResult,
} from '@/lib/providers/ai';
import { getAiConfig } from '@/lib/ai/config';
import { assertWithinBudget, recordAiUsage } from '@/lib/ai/budget';
import { ASSISTANT_TOOLS, getTool, toolDefinitions, type AssistantContext } from './tools';

/** Stops a runaway conversation from spending the month's budget in one turn. */
const MAX_ITERATIONS = 6;

export interface PendingAction {
  toolName: string;
  input: Record<string, unknown>;
  /** One line describing exactly what will happen. This is what gets approved. */
  summary: string;
}

export interface AssistantTurn {
  /** Prose to show the user. */
  reply: string;
  /** Set when the assistant wants to change something and is waiting on a yes. */
  pendingAction: PendingAction | null;
  /** Read tools that ran, for the "what I checked" line in the UI. */
  toolsUsed: string[];
  costUsd: number;
}

/**
 * Run one turn of conversation.
 *
 * `history` is the prior turns, which the caller persists client-side. Nothing
 * about the conversation is stored server-side — a dashboard chat is not worth
 * a table, and not keeping it means there is nothing to leak.
 */
export async function runAssistantTurn(params: {
  ctx: AssistantContext;
  message: string;
  history: AiConversationTurn[];
}): Promise<AssistantTurn> {
  const { ctx, message, history } = params;

  // Metered like every other AI operation, against the same monthly cap.
  await assertWithinBudget(ctx.organizationId, 'assistant', 0.02);

  const config = await getAiConfig(ctx.organizationId, 'assistant');
  if (!config.isEnabled) {
    return {
      reply: 'The assistant is switched off in AI Configuration.',
      pendingAction: null,
      toolsUsed: [],
      costUsd: 0,
    };
  }

  const ai = getAiService();
  const tools = toolDefinitions(ctx.canWrite);

  const turns: AiConversationTurn[] = [...history, { role: 'user', content: message }];

  const toolsUsed: string[] = [];
  let totalCost = 0;
  let lastText = '';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let response;
    try {
      response = await ai.completeWithTools({
        model: config.model,
        systemPrompt: config.systemPrompt,
        turns,
        tools,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      });
    } catch (error) {
      // A provider failure here becomes a plain reply rather than a 500. "The
      // API key is invalid" is actionable; "Internal server error" is not, and
      // this is the panel someone opens *because* something is wrong.
      return {
        reply: explainProviderFailure(error),
        pendingAction: null,
        toolsUsed,
        costUsd: totalCost,
      };
    }

    totalCost += response.usage.costUsd;

    await recordAiUsage({
      organizationId: ctx.organizationId,
      operation: 'assistant',
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
      cacheWriteTokens: response.usage.cacheWriteTokens,
      costUsd: response.usage.costUsd,
      durationMs: response.durationMs,
      success: true,
    });

    if (response.text) lastText = response.text;

    // No tool calls means the model is done talking.
    if (response.toolCalls.length === 0) {
      return { reply: lastText, pendingAction: null, toolsUsed, costUsd: totalCost };
    }

    // A write request ends the turn. Nothing is executed — the operator sees
    // the real arguments and decides.
    const writeCall = response.toolCalls.find((call) => getTool(call.name)?.access === 'write');
    if (writeCall) {
      const tool = getTool(writeCall.name)!;

      if (!ctx.canWrite) {
        return {
          reply:
            'That change needs an editor or admin account — your role is read-only, so I can ' +
            'look things up but not change them.',
          pendingAction: null,
          toolsUsed,
          costUsd: totalCost,
        };
      }

      return {
        reply:
          lastText ||
          `I can do that — confirm below and I'll apply it.`,
        pendingAction: {
          toolName: writeCall.name,
          input: writeCall.input,
          summary: tool.summarize?.(writeCall.input) ?? `Run ${writeCall.name}`,
        },
        toolsUsed,
        costUsd: totalCost,
      };
    }

    // Read tools: run them and feed the results back.
    turns.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
    });

    const results: AiToolResult[] = [];
    for (const call of response.toolCalls) {
      const tool = getTool(call.name);

      if (!tool) {
        results.push({
          toolCallId: call.id,
          content: `No such tool: ${call.name}`,
          isError: true,
        });
        continue;
      }

      toolsUsed.push(tool.name);

      try {
        const output = await tool.run(call.input, ctx);
        results.push({ toolCallId: call.id, content: JSON.stringify(output) });
      } catch (error) {
        // Hand the failure back rather than throwing — the model can tell the
        // user what broke, which is more useful than a blank panel.
        results.push({
          toolCallId: call.id,
          content: `Tool failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        });
      }
    }

    turns.push({ role: 'tool_results', results });
  }

  return {
    reply:
      lastText ||
      'I looked at several things but could not settle on an answer. Try asking something more specific.',
    pendingAction: null,
    toolsUsed,
    costUsd: totalCost,
  };
}

/**
 * Execute a confirmed action.
 *
 * The tool name is re-resolved and its access level re-checked here rather than
 * trusted from the request: a confirmation POST is just as forgeable as any
 * other, so the write gate has to hold on this side too.
 */
export async function executeConfirmedAction(params: {
  ctx: AssistantContext;
  toolName: string;
  input: Record<string, unknown>;
}): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const tool = getTool(params.toolName);

  if (!tool) return { ok: false, error: `No such tool: ${params.toolName}` };
  if (tool.access !== 'write') {
    return { ok: false, error: 'That tool does not require confirmation.' };
  }
  if (!params.ctx.canWrite) {
    return { ok: false, error: 'Your role does not permit changes.' };
  }

  try {
    const result = await tool.run(params.input, params.ctx);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Turn a provider failure into something the operator can act on.
 *
 * Never includes the raw error body: it is written by an external service and
 * has no business being rendered into the dashboard verbatim.
 */
function explainProviderFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof AiFatalError) {
    if (/401|authentication|invalid.*api.*key|x-api-key/i.test(message)) {
      return (
        "I can't reach Claude — the API key is missing or invalid.\n\n" +
        'Set ANTHROPIC_API_KEY in the .env file on the server and restart. ' +
        'Everything else in the dashboard keeps working meanwhile; only AI ' +
        'operations are affected.'
      );
    }
    if (/model/i.test(message)) {
      return (
        "The configured model was rejected by the API. Check the model id in " +
        'AI Configuration — a typo there will do this.'
      );
    }
    return "I couldn't complete that — the AI provider rejected the request.";
  }

  if (error instanceof AiRetryableError) {
    return (
      'Claude is rate-limited or temporarily unavailable. Try again in a moment — ' +
      'background jobs will retry on their own.'
    );
  }

  return "Something went wrong reaching the AI provider. Check System health for detail.";
}

/** Names of every tool, for the "what can you do" panel. */
export function describeCapabilities(canWrite: boolean) {
  return ASSISTANT_TOOLS.filter((tool) => canWrite || tool.access === 'read').map((tool) => ({
    name: tool.name,
    access: tool.access,
  }));
}
