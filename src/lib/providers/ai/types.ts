/**
 * AI provider contract.
 *
 * The application only ever talks to this interface. Swapping Anthropic for a
 * different vendor means writing one new class — no route, job, or component
 * changes. Nothing above this layer knows what a "message" or a "token" is.
 */

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiCompletionRequest {
  model: string;
  systemPrompt: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for JSON. Implementations that cannot enforce it must still parse defensively. */
  expectJson?: boolean;
}

export interface AiUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface AiCompletionResponse {
  text: string;
  model: string;
  usage: AiUsageStats;
  stopReason: string | null;
  durationMs: number;
}

export interface AiModelPricing {
  /** USD per million input tokens. */
  inputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

// ---------------------------------------------------------------------------
// Tool use
//
// Deliberately provider-neutral — no vendor block types leak above this file,
// so the assistant loop keeps working if the AI provider is ever swapped.
// ---------------------------------------------------------------------------

/** A tool the model may call. `inputSchema` is plain JSON Schema. */
export interface AiToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The model asking for a tool to be run. */
export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** What the tool returned, fed back on the next turn. */
export interface AiToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/**
 * One turn of a tool-using conversation.
 *
 * `tool_results` is its own role rather than a variant of `user` because the
 * caller should never have to know that a given vendor happens to deliver tool
 * output on the user turn.
 */
export type AiConversationTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AiToolCall[] }
  | { role: 'tool_results'; results: AiToolResult[] };

export interface AiToolCompletionRequest {
  model: string;
  systemPrompt: string;
  turns: AiConversationTurn[];
  tools: AiToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface AiToolCompletionResponse {
  /** Any prose the model produced alongside its tool calls. */
  text: string;
  /** Empty when the model is finished and just wants to talk. */
  toolCalls: AiToolCall[];
  model: string;
  usage: AiUsageStats;
  stopReason: string | null;
  durationMs: number;
}

export interface AiService {
  readonly name: string;

  complete(request: AiCompletionRequest): Promise<AiCompletionResponse>;

  /**
   * One turn of a tool-using conversation. The caller owns the loop: it runs
   * whatever tools come back and calls this again with the results. Keeping the
   * loop outside the provider is what lets the assistant pause for human
   * approval before a write ever executes.
   */
  completeWithTools(request: AiToolCompletionRequest): Promise<AiToolCompletionResponse>;

  /**
   * Same as complete(), but parses and validates JSON output. Implementations
   * must retry once on malformed JSON before giving up — models occasionally
   * wrap JSON in prose, and one retry is cheaper than failing the job.
   */
  completeJson<T>(request: AiCompletionRequest, validate: (raw: unknown) => T): Promise<{
    data: T;
    raw: string;
    model: string;
    usage: AiUsageStats;
    durationMs: number;
  }>;

  estimateCost(model: string, inputTokens: number, outputTokens: number): number;

  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

/** Thrown when the provider signals a retryable condition (429, 5xx, timeout). */
export class AiRetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AiRetryableError';
  }
}

/** Thrown when retrying cannot help — bad key, invalid model, malformed request. */
export class AiFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiFatalError';
  }
}
