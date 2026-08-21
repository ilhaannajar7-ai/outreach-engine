import type { Config } from 'drizzle-kit';
import { config } from 'dotenv';

config({ path: '.env' });

export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://outreach:outreach@localhost:5432/outreach',
  },
  verbose: true,
  strict: true,
} satisfies Config;
