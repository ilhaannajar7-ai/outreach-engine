/**
 * Anthropic implementation of AiService.
 *
 * This is the only file in the codebase that imports the Anthropic SDK.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';
import {
  type AiService,
  type AiCompletionRequest,
  type AiCompletionResponse,
  type AiModelPricing,
  type AiUsageStats,
  type AiToolCompletionRequest,
  type AiToolCompletionResponse,
  type AiConversationTurn,
  AiRetryableError,
  AiFatalError,
} from './types';

/**
 * USD per million tokens. Kept here rather than fetched, because the budget
 * enforcer must be able to price a call before making it.
 */
const PRICING: Record<string, AiModelPricing> = {
  'claude-haiku-4-5': {
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
  },
  'claude-sonnet-5': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  'claude-sonnet-4-6': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  'claude-opus-5': {
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
  },
};

/** Unknown model → priced at the most expensive known rate so we never under-bill ourselves. */
const FALLBACK_PRICING: AiModelPricing = {
  inputPerMillion: 5.0,
  outputPerMillion: 25.0,
  cacheReadPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
};

export class AnthropicAiService implements AiService {
  readonly name = 'anthropic';
  private client: Anthropic;

  /**
   * Models that have rejected `temperature`, learned at runtime.
   *
   * Newer models (Sonnet 5 and later) deprecated the parameter and return a 400
   * if it is sent. Rather than hardcode a model list that goes stale with every
   * release, the first rejection for a model is remembered and `temperature` is
   * dropped for it from then on — process-wide, so it costs one retry per model
   * per boot, not per call.
   */
  private noTemperatureModels = new Set<string>();

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? env.ANTHROPIC_API_KEY,
      maxRetries: 2,
      timeout: 120_000,
    });
  }

  /**
   * Create a message, transparently retrying without `temperature` if the model
   * has deprecated it. Every code path goes through here so the handling exists
   * in exactly one place.
   */
  private async createMessage(
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> {
    const cleaned =
      this.noTemperatureModels.has(params.model) && 'temperature' in params
        ? (() => {
            const { temperature: _omit, ...rest } = params;
            return rest;
          })()
        : params;

    try {
      return await this.client.messages.create(cleaned);
    } catch (error) {
      // Learn the deprecation and retry once without the parameter.
      if (
        error instanceof Anthropic.APIError &&
        error.status === 400 &&
        /temperature.*(deprecated|not supported|unsupported)/i.test(error.message) &&
        'temperature' in cleaned
      ) {
        this.noTemperatureModels.add(params.model);
        const { temperature: _omit, ...rest } = cleaned;
        return await this.client.messages.create(rest);
      }
      throw error;
    }
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const started = Date.now();

    try {
      const response = await this.createMessage({
        model: request.model,
        max_tokens: request.maxTokens ?? 2048,
        temperature: request.temperature ?? 1.0,
        system: request.systemPrompt,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
      const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;

      const usage: AiUsageStats = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd: this.calculateCost(
          response.model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        ),
      };

      return {
        text,
        model: response.model,
        usage,
        stopReason: response.stop_reason,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  async completeWithTools(
    request: AiToolCompletionRequest,
  ): Promise<AiToolCompletionResponse> {
    const started = Date.now();

    try {
      const response = await this.createMessage({
        model: request.model,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 1.0,
        system: request.systemPrompt,
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          // The registry authors these as JSON Schema, which is exactly what
          // the API wants — the cast only satisfies the SDK's narrower type.
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        })),
        messages: request.turns.map((turn) => this.toMessageParam(turn)),
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const toolCalls = response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        }));

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
      const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;

      return {
        text,
        toolCalls,
        model: response.model,
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          costUsd: this.calculateCost(
            response.model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
          ),
        },
        stopReason: response.stop_reason,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  /** Map one neutral turn onto the vendor's message shape. */
  private toMessageParam(turn: AiConversationTurn): Anthropic.MessageParam {
    if (turn.role === 'user') {
      return { role: 'user', content: turn.content };
    }

    if (turn.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (turn.content) blocks.push({ type: 'text', text: turn.content });

      for (const call of turn.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }

      // An assistant turn must never be empty, and a tool-only turn has no
      // prose to carry.
      return { role: 'assistant', content: blocks.length > 0 ? blocks : '(no output)' };
    }

    // Tool results are delivered on the user turn in this vendor's protocol.
    return {
      role: 'user',
      content: turn.results.map((result) => ({
        type: 'tool_result' as const,
        tool_use_id: result.toolCallId,
        content: result.content,
        is_error: result.isError ?? false,
      })),
    };
  }

  async completeJson<T>(
    request: AiCompletionRequest,
    validate: (raw: unknown) => T,
  ): Promise<{
    data: T;
    raw: string;
    model: string;
    usage: AiUsageStats;
    durationMs: number;
  }> {
    const jsonRequest: AiCompletionRequest = {
      ...request,
      systemPrompt:
        `${request.systemPrompt}\n\n` +
        `Respond with a single valid JSON object and nothing else. ` +
        `No markdown fences, no commentary before or after.`,
    };

    let lastError: Error | null = null;
    let totalUsage: AiUsageStats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    let totalDuration = 0;

    // Two attempts: models occasionally wrap JSON in prose, and one retry is
    // far cheaper than failing the job and re-running the whole pipeline.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await this.complete(jsonRequest);

      totalUsage = {
        inputTokens: totalUsage.inputTokens + response.usage.inputTokens,
        outputTokens: totalUsage.outputTokens + response.usage.outputTokens,
        cacheReadTokens: totalUsage.cacheReadTokens + response.usage.cacheReadTokens,
        cacheWriteTokens: totalUsage.cacheWriteTokens + response.usage.cacheWriteTokens,
        costUsd: totalUsage.costUsd + response.usage.costUsd,
      };
      totalDuration += response.durationMs;

      try {
        const parsed = JSON.parse(extractJson(response.text));
        return {
          data: validate(parsed),
          raw: response.text,
          model: response.model,
          usage: totalUsage,
          durationMs: totalDuration,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 2) break;

        jsonRequest.messages = [
          ...request.messages,
          { role: 'assistant', content: response.text },
          {
            role: 'user',
            content:
              'That response was not valid JSON. Return the same information as a ' +
              'single valid JSON object only — no prose, no code fences.',
          },
        ];
      }
    }

    throw new AiFatalError(
      `Model did not return valid JSON after 2 attempts: ${lastError?.message ?? 'unknown error'}`,
    );
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    return this.calculateCost(model, inputTokens, outputTokens, 0, 0);
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      // Cheapest possible real call: 1 output token on the cheapest model.
      await this.client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheWriteTokens: number,
  ): number {
    const pricing = PRICING[model] ?? FALLBACK_PRICING;
    const cost =
      (inputTokens / 1_000_000) * pricing.inputPerMillion +
      (outputTokens / 1_000_000) * pricing.outputPerMillion +
      (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion +
      (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion;

    // 6dp matches the numeric(10,6) column the cost is stored in.
    return Math.round(cost * 1_000_000) / 1_000_000;
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof Anthropic.APIError) {
      const status = error.status;

      if (status === 429) {
        const retryAfter = error.headers?.['retry-after'];
        const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 60_000;
        return new AiRetryableError(`Rate limited by Anthropic API`, retryAfterMs);
      }
      if (status !== undefined && status >= 500) {
        return new AiRetryableError(`Anthropic API server error (${status}): ${error.message}`);
      }
      if (status === 401 || status === 403) {
        return new AiFatalError(`Anthropic API authentication failed — check ANTHROPIC_API_KEY`);
      }
      if (status === 400) {
        return new AiFatalError(`Invalid request to Anthropic API: ${error.message}`);
      }
      return new AiFatalError(`Anthropic API error (${status}): ${error.message}`);
    }

    if (error instanceof Error) {
      if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(error.message)) {
        return new AiRetryableError(`Network error calling Anthropic: ${error.message}`);
      }
      return error;
    }

    return new Error(String(error));
  }
}

/**
 * Pull a JSON object out of a response that may be fenced or padded with prose.
 * Tries the raw text first so well-behaved responses cost nothing extra.
 */
function extractJson(text: string): string {
  const trimmed = text.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}
