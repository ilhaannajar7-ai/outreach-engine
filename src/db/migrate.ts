/**
 * Migration runner. Invoked by `npm run db:migrate` and by the container
 * entrypoint before the app boots, so a deploy can never serve traffic against
 * an out-of-date schema.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  // max: 1 — migrations must run serially on a single connection.
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client);

  console.log('Running migrations…');
  const started = Date.now();

  try {
    await migrate(db, { migrationsFolder: './src/db/migrations' });
    console.log(`Migrations complete in ${Date.now() - started}ms.`);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
