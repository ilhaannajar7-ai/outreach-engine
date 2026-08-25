/**
 * Database schema — Outreach Engine
 *
 * Design rules that must hold for every table added later:
 *  1. Every tenant-scoped table carries `organizationId` as its first FK.
 *     The UI is single-org in V1, but the schema never needs a migration to
 *     become multi-org.
 *  2. Money is stored as `numeric` (exact), never float.
 *  3. Timestamps are `timestamptz`, always UTC at rest.
 *  4. Status fields are pgEnum, not free text — invalid states cannot be written.
 *  5. Anything that touches a third-party provider stores the provider name and
 *     the provider's own id, so swapping providers never loses history.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const leadStatusEnum = pgEnum('lead_status', [
  'new',
  'researching',
  'researched',
  'generating',
  'ready_to_contact',
  'contacted',
  'follow_up_1_sent',
  'follow_up_2_sent',
  'replied',
  'interested',
  'not_interested',
  'meeting_booked',
  'bounced',
  'unsubscribed',
  'closed',
  'error',
]);

export const emailStatusEnum = pgEnum('email_status', [
  'draft',
  'pending_approval',
  'approved',
  'queued',
  'sending',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'rejected',
]);

/**
 * Four touches maximum: the initial email plus three follow-ups.
 *
 * Past four, reply rates collapse while spam complaints climb — and Google
 * filters a sending domain once complaints pass 0.3%. Additional persistence
 * belongs on another channel, not in the same inbox.
 */
export const emailKindEnum = pgEnum('email_kind', [
  'initial',
  'follow_up_1',
  'follow_up_2',
  'follow_up_3',
]);

export const emailEventTypeEnum = pgEnum('email_event_type', [
  'queued',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced',
  'complained',
  'unsubscribed',
  'failed',
]);

export const replyClassificationEnum = pgEnum('reply_classification', [
  'interested',
  'maybe',
  'not_interested',
  'out_of_office',
  'wrong_person',
  'unsubscribe_request',
  'auto_reply',
  'unclassified',
]);

export const aiOperationEnum = pgEnum('ai_operation', [
  'research',
  'email_generation',
  'follow_up_generation',
  'reply_classification',
  // The dashboard assistant. Metered like any other operation so a chatty
  // session cannot quietly consume the month's budget.
  'assistant',
]);

export const jobStatusEnum = pgEnum('job_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'dead',
  'cancelled',
]);

export const jobTypeEnum = pgEnum('job_type', [
  'research_company',
  'generate_email',
  'generate_follow_up',
  'send_email',
  'classify_reply',
  'sync_email_events',
  'check_follow_ups_due',
  'poll_replies',
  'find_contacts',
  'verify_contact_email',
  'source_leads',
  'health_check',
  'daily_digest',
  'backup_database',
]);

export const domainStatusEnum = pgEnum('domain_status', [
  'pending_dns',
  'warming',
  'active',
  'paused',
  'suspended',
]);

export const inboxStatusEnum = pgEnum('inbox_status', [
  'pending_setup',
  'warming',
  'active',
  'paused',
  'blocked',
]);

export const dnsCheckStatusEnum = pgEnum('dns_check_status', ['pass', 'fail', 'missing', 'unknown']);

export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'active',
  'paused',
  'completed',
  'archived',
]);

export const notificationTierEnum = pgEnum('notification_tier', [
  'tier_1_auto_fixed',
  'tier_2_auto_notified',
  'tier_3_stopped',
  'info',
]);

export const notificationChannelEnum = pgEnum('notification_channel', ['dashboard', 'email', 'both']);

export const memberRoleEnum = pgEnum('member_role', ['owner', 'admin', 'member', 'viewer']);

export const healthStatusEnum = pgEnum('health_status', [
  'operational',
  'degraded',
  'down',
  'unknown',
]);

// ---------------------------------------------------------------------------
// Tenancy & identity
// ---------------------------------------------------------------------------

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),

    // What this org sells — injected into every AI prompt so generated copy
    // is grounded in the actual offering rather than invented.
    valueProposition: text('value_proposition'),
    servicesOffered: text('services_offered'),
    targetIndustries: text('target_industries'),
    senderName: varchar('sender_name', { length: 255 }),
    senderTitle: varchar('sender_title', { length: 255 }),
    calendarLink: text('calendar_link'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('organizations_slug_idx').on(t.slug)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull(),
    emailVerified: timestamp('email_verified', { withTimezone: true }),
    name: varchar('name', { length: 255 }),
    passwordHash: text('password_hash'),
    image: text('image'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),

    // Two-factor auth (TOTP — authenticator app). The secret is only trusted
    // once twoFactorEnabledAt is set, so an abandoned half-finished setup can
    // never lock anyone out — enrolment requires verifying a live code first.
    twoFactorSecret: text('two_factor_secret'),
    twoFactorEnabledAt: timestamp('two_factor_enabled_at', { withTimezone: true }),
    /** Single-use recovery codes, stored hashed, for a lost device. */
    twoFactorRecoveryCodes: jsonb('two_factor_recovery_codes').$type<string[]>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index('org_members_user_idx').on(t.userId),
  ],
);

/** Auth.js session storage (credentials provider still uses the session table). */
export const sessions = pgTable(
  'sessions',
  {
    sessionToken: text('session_token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Sending infrastructure — domains and inboxes
// ---------------------------------------------------------------------------

/**
 * A sending domain. Adding a domain is a row insert made from the dashboard —
 * scaling from 1 domain to 5 never touches code.
 */
export const sendingDomains = pgTable(
  'sending_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    domain: varchar('domain', { length: 255 }).notNull(),
    status: domainStatusEnum('status').notNull().default('pending_dns'),

    // DNS authentication — re-checked by a scheduled job, surfaced on the dashboard.
    spfStatus: dnsCheckStatusEnum('spf_status').notNull().default('unknown'),
    dkimStatus: dnsCheckStatusEnum('dkim_status').notNull().default('unknown'),
    dmarcStatus: dnsCheckStatusEnum('dmarc_status').notNull().default('unknown'),
    dnsLastCheckedAt: timestamp('dns_last_checked_at', { withTimezone: true }),
    dnsRecords: jsonb('dns_records').$type<Record<string, string>>(),

    // Warm-up: ramps the cap automatically day by day.
    warmupStartedAt: timestamp('warmup_started_at', { withTimezone: true }),
    warmupDurationDays: integer('warmup_duration_days').notNull().default(42),
    warmupCompleted: boolean('warmup_completed').notNull().default(false),

    dailySendLimit: integer('daily_send_limit').notNull().default(20),
    maxDailySendLimit: integer('max_daily_send_limit').notNull().default(200),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sending_domains_org_domain_idx').on(t.organizationId, t.domain),
    index('sending_domains_status_idx').on(t.organizationId, t.status),
  ],
);

/**
 * A mailbox that actually sends. Sends are distributed across active inboxes
 * round-robin, weighted by remaining daily headroom.
 */
export const sendingInboxes = pgTable(
  'sending_inboxes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    domainId: uuid('domain_id')
      .notNull()
      .references(() => sendingDomains.id, { onDelete: 'cascade' }),

    emailAddress: varchar('email_address', { length: 320 }).notNull(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    replyToAddress: varchar('reply_to_address', { length: 320 }),

    status: inboxStatusEnum('status').notNull().default('pending_setup'),

    // Which provider physically delivers for this inbox. Different inboxes may
    // use different providers at the same time — that is how a migration from
    // Resend to Smartlead happens without downtime.
    provider: varchar('provider', { length: 50 }).notNull().default('resend'),
    providerInboxId: varchar('provider_inbox_id', { length: 255 }),

    dailySendLimit: integer('daily_send_limit').notNull().default(10),
    maxDailySendLimit: integer('max_daily_send_limit').notNull().default(100),
    sentToday: integer('sent_today').notNull().default(0),
    sentTodayResetAt: timestamp('sent_today_reset_at', { withTimezone: true }),

    // 0–100 health score derived from bounce/complaint rates. Drops below the
    // floor and the inbox pauses itself.
    reputationScore: integer('reputation_score').notNull().default(50),
    totalSent: integer('total_sent').notNull().default(0),
    totalBounced: integer('total_bounced').notNull().default(0),
    totalComplaints: integer('total_complaints').notNull().default(0),

    warmupStartedAt: timestamp('warmup_started_at', { withTimezone: true }),
    warmupCompleted: boolean('warmup_completed').notNull().default(false),

    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    pausedReason: text('paused_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sending_inboxes_email_idx').on(t.emailAddress),
    index('sending_inboxes_org_status_idx').on(t.organizationId, t.status),
    index('sending_inboxes_domain_idx').on(t.domainId),
  ],
);

// ---------------------------------------------------------------------------
// Companies, contacts, leads
// ---------------------------------------------------------------------------

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    name: varchar('name', { length: 255 }).notNull(),
    domain: varchar('domain', { length: 255 }),
    website: text('website'),
    industry: varchar('industry', { length: 255 }),
    sizeRange: varchar('size_range', { length: 50 }),
    location: varchar('location', { length: 255 }),
    country: varchar('country', { length: 100 }),
    linkedinUrl: text('linkedin_url'),
    description: text('description'),

    // Why this company entered the pipeline (e.g. "hiring 3 AR clerks").
    hiringSignal: text('hiring_signal'),
    hiringSignalSource: varchar('hiring_signal_source', { length: 100 }),
    hiringSignalUrl: text('hiring_signal_url'),
    hiringSignalSeenAt: timestamp('hiring_signal_seen_at', { withTimezone: true }),

    source: varchar('source', { length: 100 }).notNull().default('manual'),
    externalId: varchar('external_id', { length: 255 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('companies_org_idx').on(t.organizationId),
    uniqueIndex('companies_org_domain_idx').on(t.organizationId, t.domain),
    index('companies_name_idx').on(t.organizationId, t.name),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    firstName: varchar('first_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }),
    fullName: varchar('full_name', { length: 255 }),
    email: varchar('email', { length: 320 }).notNull(),
    jobTitle: varchar('job_title', { length: 255 }),
    seniority: varchar('seniority', { length: 50 }),
    department: varchar('department', { length: 100 }),
    linkedinUrl: text('linkedin_url'),
    phone: varchar('phone', { length: 50 }),

    // Verification result from the enrichment provider. Only `valid` addresses
    // are ever sent to.
    emailVerified: boolean('email_verified').notNull().default(false),
    emailVerificationStatus: varchar('email_verification_status', { length: 50 }),
    emailVerificationScore: integer('email_verification_score'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),

    // Suppression — honoured globally, forever, across all campaigns.
    isUnsubscribed: boolean('is_unsubscribed').notNull().default(false),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    isSuppressed: boolean('is_suppressed').notNull().default(false),
    suppressionReason: text('suppression_reason'),

    source: varchar('source', { length: 100 }).notNull().default('manual'),
    externalId: varchar('external_id', { length: 255 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contacts_org_email_idx').on(t.organizationId, t.email),
    index('contacts_company_idx').on(t.companyId),
    index('contacts_suppression_idx').on(t.organizationId, t.isUnsubscribed, t.isSuppressed),
  ],
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    status: campaignStatusEnum('status').notNull().default('draft'),

    targetRole: varchar('target_role', { length: 255 }),
    targetIndustry: varchar('target_industry', { length: 255 }),
    targetLocation: varchar('target_location', { length: 255 }),

    // Per-campaign overrides; null falls back to the org/global setting.
    dailySendLimit: integer('daily_send_limit'),
    maxFollowUps: integer('max_follow_ups').notNull().default(2),
    followUp1DelayDays: integer('follow_up_1_delay_days').notNull().default(4),
    followUp2DelayDays: integer('follow_up_2_delay_days').notNull().default(7),

    // Extra instructions merged into the email-generation prompt.
    toneInstructions: text('tone_instructions'),
    customPromptAdditions: text('custom_prompt_additions'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('campaigns_org_status_idx').on(t.organizationId, t.status)],
);

/**
 * A strategy variant: one approach being tested against the others.
 *
 * Assignment is per LEAD, not per email — the whole sequence a person receives
 * has to come from one approach, or the result measures nothing.
 *
 * Results are computed live from leads and emails rather than kept in counter
 * columns here. Denormalised counters drift the moment a send fails or a job
 * retries, and a drifted counter in an experiment is worse than a slow query:
 * it silently changes which variant appears to win.
 */
export const strategyVariants = pgTable(
  'strategy_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),

    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),

    /** Exactly one variant per campaign is the baseline others are measured against. */
    isControl: boolean('is_control').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    /** Relative share of new leads. Equal weights mean an even split. */
    weight: integer('weight').notNull().default(1),

    // --- What actually differs between arms ---
    /** Merged into the email prompt for leads on this variant. */
    angleInstructions: text('angle_instructions'),
    /** 'call' | 'question' | 'resource' — how the email asks for the next step. */
    ctaStyle: varchar('cta_style', { length: 30 }),
    /** 'short' | 'standard' */
    targetLength: varchar('target_length', { length: 20 }),

    /** Set when a variant wins and is rolled out as the new baseline. */
    promotedAt: timestamp('promoted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('strategy_variants_org_idx').on(t.organizationId),
    index('strategy_variants_campaign_idx').on(t.campaignId, t.isActive),
  ],
);

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    /**
     * Assigned once, at creation, and never reassigned — moving a lead between
     * arms mid-sequence would attribute its replies to the wrong approach.
     */
    variantId: uuid('variant_id').references(() => strategyVariants.id, { onDelete: 'set null' }),

    status: leadStatusEnum('status').notNull().default('new'),
    priority: integer('priority').notNull().default(0),

    researchId: uuid('research_id'),

    followUpCount: integer('follow_up_count').notNull().default(0),
    nextFollowUpAt: timestamp('next_follow_up_at', { withTimezone: true }),

    firstContactedAt: timestamp('first_contacted_at', { withTimezone: true }),
    lastContactedAt: timestamp('last_contacted_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),

    // Set when the AI classifies a reply as needing a human. Cleared once handled.
    requiresAttention: boolean('requires_attention').notNull().default(false),
    attentionReason: text('attention_reason'),

    lastError: text('last_error'),
    errorCount: integer('error_count').notNull().default(0),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('leads_org_contact_campaign_idx').on(t.organizationId, t.contactId, t.campaignId),
    index('leads_org_status_idx').on(t.organizationId, t.status),
    index('leads_attention_idx').on(t.organizationId, t.requiresAttention),
    index('leads_follow_up_due_idx').on(t.nextFollowUpAt),
    index('leads_campaign_idx').on(t.campaignId),
  ],
);

// ---------------------------------------------------------------------------
// AI research cache
// ---------------------------------------------------------------------------

/**
 * Research is cached per company and reused across every lead at that company.
 * This is the single biggest AI cost saver — 5 contacts at one company cost
 * one research call, not five.
 */
/**
 * A research hook: a fact the recipient can verify, plus what it implies.
 *
 * The pairing is the point — the observation proves someone looked, and the
 * inference proves someone thought. `score` is assigned by `hook-quality.ts`.
 */
export interface ScoredHook {
  observation: string;
  inference: string;
  score: number;
}

export const aiResearch = pgTable(
  'ai_research',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    summary: text('summary').notNull(),
    painPoints: jsonb('pain_points').$type<string[]>(),
    opportunities: jsonb('opportunities').$type<string[]>(),
    valueProposition: text('value_proposition'),
    /** Scored observation/inference pairs, strongest first. */
    personalizationHooks: jsonb('personalization_hooks').$type<ScoredHook[]>(),
    rawResponse: jsonb('raw_response'),

    /** The model's own 0-100 judgement of how well this company fits the offer. */
    fitScore: integer('fit_score'),
    /**
     * Best hook score from `hook-quality.ts`. Below the threshold means no hook
     * was company-specific, and an email built on it would read as automated —
     * so generation is blocked rather than producing filler.
     */
    hookQualityScore: integer('hook_quality_score'),
    /** Reasons not to pursue: wrong department, size mismatch, unrelated signal. */
    disqualifiers: jsonb('disqualifiers').$type<string[]>(),

    model: varchar('model', { length: 100 }).notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),

    isStale: boolean('is_stale').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_research_company_idx').on(t.companyId),
    index('ai_research_org_idx').on(t.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

export const emails = pgTable(
  'emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    inboxId: uuid('inbox_id').references(() => sendingInboxes.id, { onDelete: 'set null' }),

    kind: emailKindEnum('kind').notNull().default('initial'),
    status: emailStatusEnum('status').notNull().default('draft'),

    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),

    // Preserved so the dashboard can show exactly what the human changed.
    originalSubject: text('original_subject'),
    originalBodyText: text('original_body_text'),
    wasEditedByHuman: boolean('was_edited_by_human').notNull().default(false),

    fromAddress: varchar('from_address', { length: 320 }),
    toAddress: varchar('to_address', { length: 320 }).notNull(),

    // Human approval gate — nothing sends without approvedBy set.
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedBy: uuid('rejected_by').references(() => users.id, { onDelete: 'set null' }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),

    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),

    provider: varchar('provider', { length: 50 }),
    providerMessageId: varchar('provider_message_id', { length: 500 }),
    messageIdHeader: varchar('message_id_header', { length: 500 }),
    inReplyTo: varchar('in_reply_to', { length: 500 }),
    threadId: varchar('thread_id', { length: 500 }),

    model: varchar('model', { length: 100 }),
    inputTokens: integer('input_tokens').default(0),
    outputTokens: integer('output_tokens').default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).default('0'),

    openCount: integer('open_count').notNull().default(0),
    clickCount: integer('click_count').notNull().default(0),

    failureReason: text('failure_reason'),
    attemptCount: integer('attempt_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('emails_lead_idx').on(t.leadId),
    index('emails_org_status_idx').on(t.organizationId, t.status),
    index('emails_scheduled_idx').on(t.status, t.scheduledFor),
    index('emails_provider_msg_idx').on(t.providerMessageId),
    index('emails_thread_idx').on(t.threadId),
    index('emails_inbox_idx').on(t.inboxId),
  ],
);

export const emailEvents = pgTable(
  'email_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    emailId: uuid('email_id')
      .notNull()
      .references(() => emails.id, { onDelete: 'cascade' }),

    eventType: emailEventTypeEnum('event_type').notNull(),
    provider: varchar('provider', { length: 50 }),
    providerEventId: varchar('provider_event_id', { length: 500 }),
    payload: jsonb('payload'),

    // Bounce detail — drives the inbox reputation score.
    bounceType: varchar('bounce_type', { length: 50 }),
    reason: text('reason'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('email_events_email_idx').on(t.emailId),
    index('email_events_org_type_idx').on(t.organizationId, t.eventType),
    uniqueIndex('email_events_provider_event_idx').on(t.provider, t.providerEventId),
  ],
);

export const replies = pgTable(
  'replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    emailId: uuid('email_id').references(() => emails.id, { onDelete: 'set null' }),

    fromAddress: varchar('from_address', { length: 320 }).notNull(),
    subject: text('subject'),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),

    classification: replyClassificationEnum('classification').notNull().default('unclassified'),
    classificationConfidence: numeric('classification_confidence', { precision: 4, scale: 3 }),
    classificationReasoning: text('classification_reasoning'),
    summary: text('summary'),

    model: varchar('model', { length: 100 }),
    inputTokens: integer('input_tokens').default(0),
    outputTokens: integer('output_tokens').default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).default('0'),

    // The AI never replies. A human always does.
    isHandled: boolean('is_handled').notNull().default(false),
    handledBy: uuid('handled_by').references(() => users.id, { onDelete: 'set null' }),
    handledAt: timestamp('handled_at', { withTimezone: true }),

    providerMessageId: varchar('provider_message_id', { length: 500 }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('replies_lead_idx').on(t.leadId),
    index('replies_org_classification_idx').on(t.organizationId, t.classification),
    index('replies_unhandled_idx').on(t.organizationId, t.isHandled),
  ],
);

// ---------------------------------------------------------------------------
// AI configuration, prompts, and metering
// ---------------------------------------------------------------------------

/**
 * Which model runs which operation. Editable from the dashboard — changing a
 * model is an UPDATE, never a deploy.
 */
export const aiModelConfig = pgTable(
  'ai_model_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    operation: aiOperationEnum('operation').notNull(),
    model: varchar('model', { length: 100 }).notNull(),
    maxTokens: integer('max_tokens').notNull().default(2048),
    temperature: numeric('temperature', { precision: 3, scale: 2 }).notNull().default('1.0'),

    isEnabled: boolean('is_enabled').notNull().default(true),

    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ai_model_config_org_op_idx').on(t.organizationId, t.operation)],
);

/**
 * System prompts, versioned. Editing a prompt from the dashboard writes a new
 * version and deactivates the old one, so a bad edit is one click to revert.
 */
export const aiPrompts = pgTable(
  'ai_prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    operation: aiOperationEnum('operation').notNull(),
    version: integer('version').notNull().default(1),
    systemPrompt: text('system_prompt').notNull(),
    userPromptTemplate: text('user_prompt_template').notNull(),

    isActive: boolean('is_active').notNull().default(true),

    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_prompts_org_op_idx').on(t.organizationId, t.operation, t.isActive),
    uniqueIndex('ai_prompts_org_op_version_idx').on(t.organizationId, t.operation, t.version),
  ],
);

/**
 * One row per AI call. This table is the budget enforcer — the cap check is a
 * SUM over the current month, never an estimate.
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    operation: aiOperationEnum('operation').notNull(),
    model: varchar('model', { length: 100 }).notNull(),

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),

    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),

    // 'YYYY-MM' — indexed so the monthly SUM is a single index scan.
    billingPeriod: varchar('billing_period', { length: 7 }).notNull(),

    durationMs: integer('duration_ms'),
    success: boolean('success').notNull().default(true),
    errorMessage: text('error_message'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_usage_org_period_idx').on(t.organizationId, t.billingPeriod),
    index('ai_usage_org_op_idx').on(t.organizationId, t.operation),
    index('ai_usage_created_idx').on(t.createdAt),
  ],
);

/** Non-AI third-party calls (Hunter, Apollo, email provider) — same shape. */
export const apiUsage = pgTable(
  'api_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    provider: varchar('provider', { length: 50 }).notNull(),
    endpoint: varchar('endpoint', { length: 255 }).notNull(),
    creditsUsed: integer('credits_used').notNull().default(1),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    billingPeriod: varchar('billing_period', { length: 7 }).notNull(),

    success: boolean('success').notNull().default(true),
    statusCode: integer('status_code'),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('api_usage_org_period_idx').on(t.organizationId, t.billingPeriod),
    index('api_usage_provider_idx').on(t.organizationId, t.provider),
  ],
);

// ---------------------------------------------------------------------------
// Settings, jobs, notifications, health, audit
// ---------------------------------------------------------------------------

/**
 * Typed key/value settings so the dashboard can change behaviour without a
 * deploy: budget thresholds, send windows, global caps, feature flags.
 */
export const settings = pgTable(
  'settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    key: varchar('key', { length: 100 }).notNull(),
    value: jsonb('value').notNull(),
    valueType: varchar('value_type', { length: 20 }).notNull().default('string'),
    description: text('description'),

    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('settings_org_key_idx').on(t.organizationId, t.key)],
);

/**
 * Postgres-backed job queue. Claimed with SELECT ... FOR UPDATE SKIP LOCKED —
 * no Redis, no BullMQ, and it survives a restart because it is just a table.
 */
export const backgroundJobs = pgTable(
  'background_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),

    type: jobTypeEnum('type').notNull(),
    status: jobStatusEnum('status').notNull().default('pending'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),

    priority: integer('priority').notNull().default(0),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),

    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),

    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: varchar('locked_by', { length: 100 }),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),

    result: jsonb('result'),
    lastError: text('last_error'),

    // Set for jobs that must not be enqueued twice (e.g. one research per company).
    idempotencyKey: varchar('idempotency_key', { length: 255 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('background_jobs_claim_idx').on(t.status, t.runAt, t.priority),
    index('background_jobs_org_type_idx').on(t.organizationId, t.type),
    uniqueIndex('background_jobs_idempotency_idx').on(t.idempotencyKey),
    index('background_jobs_status_idx').on(t.status),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    tier: notificationTierEnum('tier').notNull().default('info'),
    channel: notificationChannelEnum('channel').notNull().default('dashboard'),

    title: varchar('title', { length: 255 }).notNull(),
    message: text('message').notNull(),
    // Deep link into the dashboard so every alert is one click from its fix.
    actionUrl: text('action_url'),
    actionLabel: varchar('action_label', { length: 100 }),

    relatedEntityType: varchar('related_entity_type', { length: 50 }),
    relatedEntityId: uuid('related_entity_id'),

    isRead: boolean('is_read').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),
    isResolved: boolean('is_resolved').notNull().default(false),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    emailSent: boolean('email_sent').notNull().default(false),
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),

    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_org_read_idx').on(t.organizationId, t.isRead),
    index('notifications_org_tier_idx').on(t.organizationId, t.tier),
    index('notifications_created_idx').on(t.createdAt),
  ],
);

export const systemHealth = pgTable(
  'system_health',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),

    component: varchar('component', { length: 100 }).notNull(),
    status: healthStatusEnum('status').notNull().default('unknown'),

    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),

    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    responseTimeMs: integer('response_time_ms'),
    message: text('message'),
    metadata: jsonb('metadata'),

    // True when the dashboard should show a "Fix ↻" button for this component.
    isAutoFixable: boolean('is_auto_fixable').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('system_health_component_idx').on(t.component)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    action: varchar('action', { length: 100 }).notNull(),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: uuid('entity_id'),

    changes: jsonb('changes'),
    metadata: jsonb('metadata'),

    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_org_idx').on(t.organizationId, t.createdAt),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_user_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  companies: many(companies),
  contacts: many(contacts),
  leads: many(leads),
  campaigns: many(campaigns),
  sendingDomains: many(sendingDomains),
  sendingInboxes: many(sendingInboxes),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(organizationMembers),
  sessions: many(sessions),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [organizationMembers.userId], references: [users.id] }),
}));

export const sendingDomainsRelations = relations(sendingDomains, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [sendingDomains.organizationId],
    references: [organizations.id],
  }),
  inboxes: many(sendingInboxes),
}));

export const sendingInboxesRelations = relations(sendingInboxes, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [sendingInboxes.organizationId],
    references: [organizations.id],
  }),
  domain: one(sendingDomains, {
    fields: [sendingInboxes.domainId],
    references: [sendingDomains.id],
  }),
  emails: many(emails),
}));

export const companiesRelations = relations(companies, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [companies.organizationId],
    references: [organizations.id],
  }),
  contacts: many(contacts),
  leads: many(leads),
  research: many(aiResearch),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [contacts.organizationId],
    references: [organizations.id],
  }),
  company: one(companies, { fields: [contacts.companyId], references: [companies.id] }),
  leads: many(leads),
}));

export const campaignsRelations = relations(campaigns, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [campaigns.organizationId],
    references: [organizations.id],
  }),
  leads: many(leads),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [leads.organizationId],
    references: [organizations.id],
  }),
  company: one(companies, { fields: [leads.companyId], references: [companies.id] }),
  contact: one(contacts, { fields: [leads.contactId], references: [contacts.id] }),
  campaign: one(campaigns, { fields: [leads.campaignId], references: [campaigns.id] }),
  emails: many(emails),
  replies: many(replies),
}));

export const aiResearchRelations = relations(aiResearch, ({ one }) => ({
  organization: one(organizations, {
    fields: [aiResearch.organizationId],
    references: [organizations.id],
  }),
  company: one(companies, { fields: [aiResearch.companyId], references: [companies.id] }),
}));

export const emailsRelations = relations(emails, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [emails.organizationId],
    references: [organizations.id],
  }),
  lead: one(leads, { fields: [emails.leadId], references: [leads.id] }),
  inbox: one(sendingInboxes, { fields: [emails.inboxId], references: [sendingInboxes.id] }),
  events: many(emailEvents),
}));

export const emailEventsRelations = relations(emailEvents, ({ one }) => ({
  email: one(emails, { fields: [emailEvents.emailId], references: [emails.id] }),
}));

export const repliesRelations = relations(replies, ({ one }) => ({
  organization: one(organizations, {
    fields: [replies.organizationId],
    references: [organizations.id],
  }),
  lead: one(leads, { fields: [replies.leadId], references: [leads.id] }),
  email: one(emails, { fields: [replies.emailId], references: [emails.id] }),
}));

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type SendingDomain = typeof sendingDomains.$inferSelect;
export type NewSendingDomain = typeof sendingDomains.$inferInsert;
export type SendingInbox = typeof sendingInboxes.$inferSelect;
export type NewSendingInbox = typeof sendingInboxes.$inferInsert;
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type AiResearch = typeof aiResearch.$inferSelect;
export type NewAiResearch = typeof aiResearch.$inferInsert;
export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
export type EmailEvent = typeof emailEvents.$inferSelect;
export type NewEmailEvent = typeof emailEvents.$inferInsert;
export type Reply = typeof replies.$inferSelect;
export type NewReply = typeof replies.$inferInsert;
export type AiModelConfig = typeof aiModelConfig.$inferSelect;
export type NewAiModelConfig = typeof aiModelConfig.$inferInsert;
export type AiPrompt = typeof aiPrompts.$inferSelect;
export type NewAiPrompt = typeof aiPrompts.$inferInsert;
export type AiUsage = typeof aiUsage.$inferSelect;
export type NewAiUsage = typeof aiUsage.$inferInsert;
export type ApiUsage = typeof apiUsage.$inferSelect;
export type NewApiUsage = typeof apiUsage.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type NewBackgroundJob = typeof backgroundJobs.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type SystemHealth = typeof systemHealth.$inferSelect;
export type NewSystemHealth = typeof systemHealth.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

export type LeadStatus = (typeof leadStatusEnum.enumValues)[number];
export type EmailStatus = (typeof emailStatusEnum.enumValues)[number];
export type EmailKind = (typeof emailKindEnum.enumValues)[number];
export type ReplyClassification = (typeof replyClassificationEnum.enumValues)[number];
export type AiOperation = (typeof aiOperationEnum.enumValues)[number];
export type JobType = (typeof jobTypeEnum.enumValues)[number];
export type JobStatus = (typeof jobStatusEnum.enumValues)[number];
export type DomainStatus = (typeof domainStatusEnum.enumValues)[number];
export type InboxStatus = (typeof inboxStatusEnum.enumValues)[number];
export type NotificationTier = (typeof notificationTierEnum.enumValues)[number];
