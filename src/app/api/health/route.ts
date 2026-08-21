import { NextResponse } from 'next/server';
import { checkDatabaseConnection } from '@/db';

export const dynamic = 'force-dynamic';

/**
 * Liveness/readiness probe. Deliberately unauthenticated and deliberately
 * minimal — it must not leak configuration, and Docker's healthcheck must be
 * able to call it.
 */
export async function GET() {
  const database = await checkDatabaseConnection();

  const body = {
    status: database.ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks: { database: { ok: database.ok, latencyMs: database.latencyMs } },
  };

  return NextResponse.json(body, { status: database.ok ? 200 : 503 });
}
