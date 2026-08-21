import type { QueuedJob } from '@/lib/providers/queue';

export type JobHandler<TPayload = Record<string, unknown>> = (
  job: QueuedJob<TPayload>,
) => Promise<unknown>;

/**
 * Errors carrying this flag are retried with the standard backoff. Everything
 * else fails the job immediately — retrying a bad prompt or an invalid address
 * only burns money and time.
 */
export function isRetryable(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return (
    name === 'AiRetryableError' ||
    name === 'EmailRetryableError' ||
    name === 'EnrichmentRetryableError'
  );
}

export function retryDelayMs(error: unknown): number | undefined {
  const after = (error as { retryAfterMs?: number })?.retryAfterMs;
  return typeof after === 'number' ? after : undefined;
}
