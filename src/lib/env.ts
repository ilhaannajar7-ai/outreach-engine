/**
 * Environment validation.
 *
 * Fails fast at boot with a readable message rather than throwing an undefined
 * reference at 2am inside a worker. Every secret is read here and nowhere else,
 * and nothing in this file is ever imported by client components.
 */

import { z } from 'zod';

/**
 * A commented-out or blank line in `.env` arrives as an empty string, not as an
 * absent key. Without this, every optional field would fail its validator the
 * moment someone leaves a placeholder blank — so empty means "not set".
 */
function blankAsUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_URL: blankAsUndefined(z.string().url().default('http://localhost:3000')),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Connection pool size. Leave unset in production; set to 1 only for a local
  // single-connection Postgres substitute.
  DB_POOL_MAX: blankAsUndefined(z.coerce.number().int().min(1).max(100).optional()),

  NEXTAUTH_SECRET: z.string().min(16, 'NEXTAUTH_SECRET must be at least 16 characters'),
  NEXTAUTH_URL: blankAsUndefined(z.string().url().optional()),

  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  AI_MODEL_RESEARCH: blankAsUndefined(z.string().default('claude-haiku-4-5')),
  AI_MODEL_EMAIL_GEN: blankAsUndefined(z.string().default('claude-sonnet-5')),
  AI_MODEL_FOLLOWUP: blankAsUndefined(z.string().default('claude-haiku-4-5')),
  AI_MODEL_CLASSIFY: blankAsUndefined(z.string().default('claude-haiku-4-5')),
  AI_MODEL_ASSISTANT: blankAsUndefined(z.string().default('claude-haiku-4-5')),

  AI_MONTHLY_BUDGET_WARN: blankAsUndefined(z.coerce.number().positive().default(16)),
  AI_MONTHLY_BUDGET_STOP: blankAsUndefined(z.coerce.number().positive().default(20)),

  EMAIL_PROVIDER: blankAsUndefined(
    z.enum(['resend', 'smartlead', 'smtp', 'console']).default('console'),
  ),
  RESEND_API_KEY: blankAsUndefined(z.string().optional()),
  RESEND_WEBHOOK_SECRET: blankAsUndefined(z.string().optional()),
  SMARTLEAD_API_KEY: blankAsUndefined(z.string().optional()),
  SMTP_HOST: blankAsUndefined(z.string().optional()),
  SMTP_PORT: blankAsUndefined(z.coerce.number().optional()),
  SMTP_USER: blankAsUndefined(z.string().optional()),
  SMTP_PASSWORD: blankAsUndefined(z.string().optional()),

  ENRICHMENT_PROVIDER: blankAsUndefined(z.enum(['hunter', 'apollo', 'none']).default('none')),
  HUNTER_API_KEY: blankAsUndefined(z.string().optional()),
  APOLLO_API_KEY: blankAsUndefined(z.string().optional()),

  GLOBAL_DAILY_SEND_LIMIT: blankAsUndefined(z.coerce.number().int().positive().default(50)),
  SEND_WINDOW_START_HOUR: blankAsUndefined(z.coerce.number().int().min(0).max(23).default(9)),
  SEND_WINDOW_END_HOUR: blankAsUndefined(z.coerce.number().int().min(0).max(23).default(17)),
  SEND_TIMEZONE: blankAsUndefined(z.string().default('Asia/Kolkata')),

  WORKER_POLL_INTERVAL_MS: blankAsUndefined(z.coerce.number().int().positive().default(5000)),
  WORKER_CONCURRENCY: blankAsUndefined(z.coerce.number().int().positive().default(2)),
  WORKER_MAX_ATTEMPTS: blankAsUndefined(z.coerce.number().int().positive().default(3)),

  ALERT_EMAIL_TO: blankAsUndefined(z.string().email().optional()),
  ALERT_EMAIL_FROM: blankAsUndefined(z.string().email().optional()),

  BACKUP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  S3_ENDPOINT: blankAsUndefined(z.string().optional()),
  S3_BUCKET: blankAsUndefined(z.string().optional()),
  S3_ACCESS_KEY_ID: blankAsUndefined(z.string().optional()),
  S3_SECRET_ACCESS_KEY: blankAsUndefined(z.string().optional()),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        `Copy .env.example to .env and fill in the missing values.`,
    );
  }

  const env = parsed.data;

  // Cross-field checks the schema alone cannot express.
  if (env.AI_MONTHLY_BUDGET_WARN >= env.AI_MONTHLY_BUDGET_STOP) {
    throw new Error(
      `AI_MONTHLY_BUDGET_WARN (${env.AI_MONTHLY_BUDGET_WARN}) must be lower than ` +
        `AI_MONTHLY_BUDGET_STOP (${env.AI_MONTHLY_BUDGET_STOP}).`,
    );
  }
  if (env.SEND_WINDOW_START_HOUR >= env.SEND_WINDOW_END_HOUR) {
    throw new Error('SEND_WINDOW_START_HOUR must be earlier than SEND_WINDOW_END_HOUR.');
  }
  if (env.EMAIL_PROVIDER === 'resend' && !env.RESEND_API_KEY) {
    throw new Error('EMAIL_PROVIDER is "resend" but RESEND_API_KEY is not set.');
  }
  if (env.EMAIL_PROVIDER === 'smartlead' && !env.SMARTLEAD_API_KEY) {
    throw new Error('EMAIL_PROVIDER is "smartlead" but SMARTLEAD_API_KEY is not set.');
  }
  if (
    env.EMAIL_PROVIDER === 'smtp' &&
    (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD)
  ) {
    throw new Error(
      'EMAIL_PROVIDER is "smtp" but SMTP_HOST, SMTP_USER, and SMTP_PASSWORD are not all set.',
    );
  }
  if (env.ENRICHMENT_PROVIDER === 'hunter' && !env.HUNTER_API_KEY) {
    throw new Error('ENRICHMENT_PROVIDER is "hunter" but HUNTER_API_KEY is not set.');
  }
  if (env.ENRICHMENT_PROVIDER === 'apollo' && !env.APOLLO_API_KEY) {
    throw new Error('ENRICHMENT_PROVIDER is "apollo" but APOLLO_API_KEY is not set.');
  }

  return env;
}

let cached: Env | null = null;

/** Validated environment. Server-side only — never import from a client component. */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    cached ??= loadEnv();
    return cached[prop as keyof Env];
  },
});

export const isProduction = () => env.NODE_ENV === 'production';
export const isDevelopment = () => env.NODE_ENV === 'development';
