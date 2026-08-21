/**
 * First-run seed.
 *
 * Creates the organization, the owner account, default AI config, default
 * prompts, and default settings. Safe to re-run — every insert is guarded, so
 * it will not duplicate or overwrite anything you have since edited.
 */

import 'dotenv/config';
import { db, sql } from './index';
import {
  organizations,
  users,
  organizationMembers,
  aiModelConfig,
  aiPrompts,
  settings,
  type AiOperation,
} from './schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { DEFAULT_PROMPTS } from '@/lib/ai/prompts';

const ORG_NAME = process.env.SEED_ORG_NAME ?? 'My Outsourcing Company';
const ORG_SLUG = process.env.SEED_ORG_SLUG ?? 'default';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? 'Admin';

async function main() {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 10) {
    console.error(
      'SEED_ADMIN_PASSWORD must be set to at least 10 characters.\n' +
        'Run:  SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=<strong-password> npm run db:seed',
    );
    process.exit(1);
  }

  console.log('Seeding…');

  // --- Organization -------------------------------------------------------
  let [org] = await db.select().from(organizations).where(eq(organizations.slug, ORG_SLUG)).limit(1);

  if (!org) {
    [org] = await db
      .insert(organizations)
      .values({
        name: ORG_NAME,
        slug: ORG_SLUG,
        valueProposition:
          'We provide trained offshore teams that handle back-office and finance operations at a fraction of local hiring cost.',
        servicesOffered:
          'Accounting and bookkeeping, accounts payable/receivable, payroll processing, data entry, customer support, and back-office administration.',
        targetIndustries: 'Logistics, manufacturing, professional services, e-commerce, healthcare admin',
        senderName: ADMIN_NAME,
        senderTitle: 'Director',
      })
      .returning();
    console.log(`  ✔ organization "${ORG_NAME}"`);
  } else {
    console.log(`  · organization "${org.name}" already exists`);
  }

  const orgId = org!.id;

  // --- Owner account ------------------------------------------------------
  const email = ADMIN_EMAIL.toLowerCase().trim();
  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (!user) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    [user] = await db
      .insert(users)
      .values({ email, name: ADMIN_NAME, passwordHash, emailVerified: new Date() })
      .returning();
    console.log(`  ✔ user ${email}`);
  } else {
    console.log(`  · user ${email} already exists (password unchanged)`);
  }

  await db
    .insert(organizationMembers)
    .values({ organizationId: orgId, userId: user!.id, role: 'owner' })
    .onConflictDoNothing();

  // --- AI model assignment ------------------------------------------------
  const modelDefaults: Record<AiOperation, { model: string; maxTokens: number; temperature: string }> = {
    research: { model: 'claude-haiku-4-5', maxTokens: 1500, temperature: '0.30' },
    email_generation: { model: 'claude-sonnet-5', maxTokens: 1200, temperature: '0.70' },
    follow_up_generation: { model: 'claude-haiku-4-5', maxTokens: 900, temperature: '0.70' },
    reply_classification: { model: 'claude-haiku-4-5', maxTokens: 700, temperature: '0.10' },
    assistant: { model: 'claude-haiku-4-5', maxTokens: 4096, temperature: '0.40' },
  };

  for (const [operation, config] of Object.entries(modelDefaults) as [
    AiOperation,
    (typeof modelDefaults)[AiOperation],
  ][]) {
    await db
      .insert(aiModelConfig)
      .values({ organizationId: orgId, operation, ...config })
      .onConflictDoNothing();
  }
  console.log('  ✔ AI model configuration');

  // --- Prompts ------------------------------------------------------------
  for (const [operation, prompt] of Object.entries(DEFAULT_PROMPTS) as [
    AiOperation,
    (typeof DEFAULT_PROMPTS)[AiOperation],
  ][]) {
    await db
      .insert(aiPrompts)
      .values({
        organizationId: orgId,
        operation,
        version: 1,
        systemPrompt: prompt.systemPrompt,
        userPromptTemplate: prompt.userPromptTemplate,
        isActive: true,
      })
      .onConflictDoNothing();
  }
  console.log('  ✔ AI prompts (v1)');

  // --- Settings -----------------------------------------------------------
  const defaultSettings: { key: string; value: unknown; valueType: string; description: string }[] = [
    {
      key: 'ai_budget_warn',
      value: 16,
      valueType: 'number',
      description: 'Monthly AI spend (USD) that triggers a warning notification',
    },
    {
      key: 'ai_budget_stop',
      value: 20,
      valueType: 'number',
      description: 'Monthly AI spend (USD) at which non-essential AI operations stop',
    },
    {
      key: 'global_daily_send_limit',
      value: 50,
      valueType: 'number',
      description: 'Maximum emails sent per day across every inbox',
    },
    {
      key: 'require_email_verification',
      value: true,
      valueType: 'boolean',
      description: 'Only send to addresses the enrichment provider marked safe',
    },
    {
      key: 'auto_research_on_import',
      value: false,
      valueType: 'boolean',
      description: 'Queue research automatically when leads are imported (costs AI credits)',
    },
  ];

  for (const setting of defaultSettings) {
    await db
      .insert(settings)
      .values({
        organizationId: orgId,
        key: setting.key,
        value: setting.value,
        valueType: setting.valueType,
        description: setting.description,
      })
      .onConflictDoNothing();
  }
  console.log('  ✔ default settings');

  console.log(`\nSeed complete.\n  Sign in at /login as ${email}\n`);
  await sql.end();
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
