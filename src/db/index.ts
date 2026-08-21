/**
 * Database connection.
 *
 * A single pooled client is shared across the process. In dev the instance is
 * stashed on globalThis so Next's hot reload does not open a new pool on every
 * edit and exhaust Postgres connections.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/lib/env';
import * as schema from './schema';

const globalForDb = globalThis as unknown as {
  __outreachSql?: ReturnType<typeof postgres>;
};

function createClient() {
  return postgres(env.DATABASE_URL, {
    // Overridable because some local Postgres substitutes accept only a single
    // connection; setting DB_POOL_MAX=1 makes concurrent queries queue instead
    // of being reset mid-flight.
    max: env.DB_POOL_MAX ?? (env.NODE_ENV === 'production' ? 10 : 5),
    idle_timeout: 20,
    connect_timeout: 10,
    // Postgres NOTICE output is noise in app logs; errors still surface normally.
    onnotice: () => {},
  });
}

export const sql = globalForDb.__outreachSql ?? createClient();

if (env.NODE_ENV !== 'production') {
  globalForDb.__outreachSql = sql;
}

export const db = drizzle(sql, { schema });

export type Database = typeof db;
export { schema };

/** Liveness probe used by the health-check job and the /api/health route. */
export async function checkDatabaseConnection(): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const started = Date.now();
  try {
    await sql`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
