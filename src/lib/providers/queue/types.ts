/**
 * Job queue contract.
 *
 * Backed by Postgres in V1 (no Redis, no BullMQ — one less service to run,
 * back up, and pay for). If throughput ever demands it, a Redis implementation
 * drops in behind this same interface.
 */

import type { JobType } from '@/db/schema';

export interface EnqueueOptions {
  organizationId?: string;
  /** Higher runs first. */
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  /** Insert is skipped if a job with this key already exists. */
  idempotencyKey?: string;
}

export interface QueuedJob<T = Record<string, unknown>> {
  id: string;
  organizationId: string | null;
  type: JobType;
  payload: T;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

export interface JobQueue {
  readonly name: string;

  enqueue<T extends Record<string, unknown>>(
    type: JobType,
    payload: T,
    options?: EnqueueOptions,
  ): Promise<string | null>;

  /** Atomically claim up to `limit` due jobs for this worker. */
  claim(workerId: string, limit: number): Promise<QueuedJob[]>;

  complete(jobId: string, result?: unknown): Promise<void>;

  /** Records the failure and either schedules a retry or marks the job dead. */
  fail(jobId: string, error: string, retryAfterMs?: number): Promise<void>;

  /** Release jobs whose worker died mid-run so they become claimable again. */
  reclaimStalled(olderThanMs: number): Promise<number>;

  getStats(organizationId?: string): Promise<{
    pending: number;
    running: number;
    failed: number;
    dead: number;
    completedLast24h: number;
  }>;
}
