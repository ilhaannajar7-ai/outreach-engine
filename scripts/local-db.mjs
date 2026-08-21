/**
 * Local development database.
 *
 * Runs PGlite — real PostgreSQL compiled to WebAssembly — and exposes it on a
 * TCP port speaking the Postgres wire protocol. The app's `postgres` driver
 * connects to it exactly as it would to a normal server, so no application
 * code is aware this is anything unusual.
 *
 * This exists so the app can be run and clicked through on a machine with
 * neither Docker nor PostgreSQL installed. Production uses the real Postgres
 * container in docker-compose.yml — this is never used there.
 *
 *   node scripts/local-db.mjs
 *   → postgres://postgres:postgres@localhost:5433/postgres
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = Number(process.env.LOCAL_DB_PORT ?? 5433);
const DATA_DIR = resolve(process.cwd(), '.localdb');

mkdirSync(DATA_DIR, { recursive: true });

console.log('Starting local Postgres (PGlite)…');

// Persisted to disk so data survives a restart of this script.
const db = await PGlite.create({ dataDir: DATA_DIR });
await db.waitReady;

// maxConnections defaults to 1, which is not enough: the web server and the
// worker are separate processes and each opens its own connection. PGlite still
// executes serially underneath — this only allows both clients to stay attached.
const server = new PGLiteSocketServer({
  db,
  port: PORT,
  host: '127.0.0.1',
  maxConnections: 12,
});
await server.start();

console.log(`
  Local Postgres ready
  ────────────────────────────────────────────────
  DATABASE_URL=postgres://postgres:postgres@localhost:${PORT}/postgres
  data dir: ${DATA_DIR}

  Leave this running. Ctrl+C to stop.
`);

async function shutdown(signal) {
  console.log(`\n${signal} — stopping local Postgres…`);
  try {
    await server.stop();
    await db.close();
  } catch {
    // Already closing; nothing useful left to do.
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
