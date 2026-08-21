import type { JobQueue } from './types';
import { PostgresJobQueue } from './postgres';

export * from './types';
export { PostgresJobQueue };

let instance: JobQueue | null = null;

export function getJobQueue(): JobQueue {
  instance ??= new PostgresJobQueue();
  return instance;
}

export function setJobQueue(queue: JobQueue): void {
  instance = queue;
}
