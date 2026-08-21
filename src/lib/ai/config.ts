/**
 * Runtime AI configuration — which model and which prompt version runs each
 * operation, read from the database so the dashboard can change both without
 * a deploy.
 *
 * Values are cached for 60s. That is short enough that a dashboard edit is
 * visible almost immediately, and long enough that a queue of jobs does not
 * hammer the settings tables.
 */

import { db } from '@/db';
import { aiModelConfig, aiPrompts, type AiOperation } from '@/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { env } from '@/lib/env';
import { DEFAULT_PROMPTS, type PromptDefinition } from './prompts';

const ENV_MODEL_DEFAULTS: Record<AiOperation, string> = {
  research: env.AI_MODEL_RESEARCH,
  email_generation: env.AI_MODEL_EMAIL_GEN,
  follow_up_generation: env.AI_MODEL_FOLLOWUP,
  reply_classification: env.AI_MODEL_CLASSIFY,
  // The assistant reads structured tool output and answers briefly — Haiku
  // handles that well, and it keeps a chatty session cheap.
  assistant: env.AI_MODEL_ASSISTANT,
};

export interface ResolvedAiConfig {
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  userPromptTemplate: string;
  promptVersion: number;
  isEnabled: boolean;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: ResolvedAiConfig; expiresAt: number }>();

/**
 * Resolution order, each layer overriding the last:
 *   1. Code defaults (prompts.ts + env models)
 *   2. ai_prompts row (active version)
 *   3. ai_model_config row
 */
export async function getAiConfig(
  organizationId: string,
  operation: AiOperation,
): Promise<ResolvedAiConfig> {
  const cacheKey = `${organizationId}:${operation}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const fallback: PromptDefinition = DEFAULT_PROMPTS[operation];

  const [modelRow] = await db
    .select()
    .from(aiModelConfig)
    .where(
      and(eq(aiModelConfig.organizationId, organizationId), eq(aiModelConfig.operation, operation)),
    )
    .limit(1);

  const [promptRow] = await db
    .select()
    .from(aiPrompts)
    .where(
      and(
        eq(aiPrompts.organizationId, organizationId),
        eq(aiPrompts.operation, operation),
        eq(aiPrompts.isActive, true),
      ),
    )
    .orderBy(desc(aiPrompts.version))
    .limit(1);

  const resolved: ResolvedAiConfig = {
    model: modelRow?.model ?? ENV_MODEL_DEFAULTS[operation],
    maxTokens: modelRow?.maxTokens ?? fallback.maxTokens,
    temperature: modelRow ? Number(modelRow.temperature) : fallback.temperature,
    systemPrompt: promptRow?.systemPrompt ?? fallback.systemPrompt,
    userPromptTemplate: promptRow?.userPromptTemplate ?? fallback.userPromptTemplate,
    promptVersion: promptRow?.version ?? 0,
    isEnabled: modelRow?.isEnabled ?? true,
  };

  cache.set(cacheKey, { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
  return resolved;
}

/** Called by the settings routes so a save takes effect on the next call, not in 60s. */
export function invalidateAiConfigCache(organizationId?: string, operation?: AiOperation): void {
  if (organizationId && operation) {
    cache.delete(`${organizationId}:${operation}`);
    return;
  }
  if (organizationId) {
    for (const key of cache.keys()) {
      if (key.startsWith(`${organizationId}:`)) cache.delete(key);
    }
    return;
  }
  cache.clear();
}

/** Models the dashboard offers per operation, with indicative per-call cost. */
export const AVAILABLE_MODELS = [
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    tier: 'fast',
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
    description: 'Fastest and cheapest. Good for research, follow-ups, and classification.',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    tier: 'balanced',
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    description: 'Best writing quality per dollar. Recommended for initial email generation.',
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    tier: 'max',
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    description: 'Highest quality. Meaningfully raises cost — use only if quality is short.',
  },
] as const;

export type AvailableModelId = (typeof AVAILABLE_MODELS)[number]['id'];
