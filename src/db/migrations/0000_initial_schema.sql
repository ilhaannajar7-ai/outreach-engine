CREATE TYPE "public"."ai_operation" AS ENUM('research', 'email_generation', 'follow_up_generation', 'reply_classification');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."dns_check_status" AS ENUM('pass', 'fail', 'missing', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('pending_dns', 'warming', 'active', 'paused', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."email_event_type" AS ENUM('queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."email_kind" AS ENUM('initial', 'follow_up_1', 'follow_up_2');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('draft', 'pending_approval', 'approved', 'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."health_status" AS ENUM('operational', 'degraded', 'down', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."inbox_status" AS ENUM('pending_setup', 'warming', 'active', 'paused', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'completed', 'failed', 'dead', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('research_company', 'generate_email', 'generate_follow_up', 'send_email', 'classify_reply', 'sync_email_events', 'check_follow_ups_due', 'verify_contact_email', 'health_check', 'daily_digest', 'backup_database');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'researching', 'researched', 'generating', 'ready_to_contact', 'contacted', 'follow_up_1_sent', 'follow_up_2_sent', 'replied', 'interested', 'not_interested', 'meeting_booked', 'bounced', 'unsubscribed', 'closed', 'error');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('dashboard', 'email', 'both');--> statement-breakpoint
CREATE TYPE "public"."notification_tier" AS ENUM('tier_1_auto_fixed', 'tier_2_auto_notified', 'tier_3_stopped', 'info');--> statement-breakpoint
CREATE TYPE "public"."reply_classification" AS ENUM('interested', 'maybe', 'not_interested', 'out_of_office', 'wrong_person', 'unsubscribe_request', 'auto_reply', 'unclassified');--> statement-breakpoint
CREATE TABLE "ai_model_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"operation" "ai_operation" NOT NULL,
	"model" varchar(100) NOT NULL,
	"max_tokens" integer DEFAULT 2048 NOT NULL,
	"temperature" numeric(3, 2) DEFAULT '1.0' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"operation" "ai_operation" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"system_prompt" text NOT NULL,
	"user_prompt_template" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_research" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"pain_points" jsonb,
	"opportunities" jsonb,
	"value_proposition" text,
	"personalization_hooks" jsonb,
	"raw_response" jsonb,
	"model" varchar(100) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"is_stale" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"operation" "ai_operation" NOT NULL,
	"model" varchar(100) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"lead_id" uuid,
	"company_id" uuid,
	"billing_period" varchar(7) NOT NULL,
	"duration_ms" integer,
	"success" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" varchar(50) NOT NULL,
	"endpoint" varchar(255) NOT NULL,
	"credits_used" integer DEFAULT 1 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"billing_period" varchar(7) NOT NULL,
	"success" boolean DEFAULT true NOT NULL,
	"status_code" integer,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"user_id" uuid,
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" uuid,
	"changes" jsonb,
	"metadata" jsonb,
	"ip_address" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"type" "job_type" NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" varchar(100),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"result" jsonb,
	"last_error" text,
	"idempotency_key" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"target_role" varchar(255),
	"target_industry" varchar(255),
	"target_location" varchar(255),
	"daily_send_limit" integer,
	"max_follow_ups" integer DEFAULT 2 NOT NULL,
	"follow_up_1_delay_days" integer DEFAULT 4 NOT NULL,
	"follow_up_2_delay_days" integer DEFAULT 7 NOT NULL,
	"tone_instructions" text,
	"custom_prompt_additions" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"domain" varchar(255),
	"website" text,
	"industry" varchar(255),
	"size_range" varchar(50),
	"location" varchar(255),
	"country" varchar(100),
	"linkedin_url" text,
	"description" text,
	"hiring_signal" text,
	"hiring_signal_source" varchar(100),
	"hiring_signal_url" text,
	"hiring_signal_seen_at" timestamp with time zone,
	"source" varchar(100) DEFAULT 'manual' NOT NULL,
	"external_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"full_name" varchar(255),
	"email" varchar(320) NOT NULL,
	"job_title" varchar(255),
	"seniority" varchar(50),
	"department" varchar(100),
	"linkedin_url" text,
	"phone" varchar(50),
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verification_status" varchar(50),
	"email_verification_score" integer,
	"email_verified_at" timestamp with time zone,
	"is_unsubscribed" boolean DEFAULT false NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"is_suppressed" boolean DEFAULT false NOT NULL,
	"suppression_reason" text,
	"source" varchar(100) DEFAULT 'manual' NOT NULL,
	"external_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email_id" uuid NOT NULL,
	"event_type" "email_event_type" NOT NULL,
	"provider" varchar(50),
	"provider_event_id" varchar(500),
	"payload" jsonb,
	"bounce_type" varchar(50),
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"inbox_id" uuid,
	"kind" "email_kind" DEFAULT 'initial' NOT NULL,
	"status" "email_status" DEFAULT 'draft' NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"original_subject" text,
	"original_body_text" text,
	"was_edited_by_human" boolean DEFAULT false NOT NULL,
	"from_address" varchar(320),
	"to_address" varchar(320) NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider" varchar(50),
	"provider_message_id" varchar(500),
	"message_id_header" varchar(500),
	"in_reply_to" varchar(500),
	"thread_id" varchar(500),
	"model" varchar(100),
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"cost_usd" numeric(10, 6) DEFAULT '0',
	"open_count" integer DEFAULT 0 NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"campaign_id" uuid,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"research_id" uuid,
	"follow_up_count" integer DEFAULT 0 NOT NULL,
	"next_follow_up_at" timestamp with time zone,
	"first_contacted_at" timestamp with time zone,
	"last_contacted_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"requires_attention" boolean DEFAULT false NOT NULL,
	"attention_reason" text,
	"last_error" text,
	"error_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tier" "notification_tier" DEFAULT 'info' NOT NULL,
	"channel" "notification_channel" DEFAULT 'dashboard' NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"action_url" text,
	"action_label" varchar(100),
	"related_entity_type" varchar(50),
	"related_entity_id" uuid,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"is_resolved" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"email_sent" boolean DEFAULT false NOT NULL,
	"email_sent_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"value_proposition" text,
	"services_offered" text,
	"target_industries" text,
	"sender_name" varchar(255),
	"sender_title" varchar(255),
	"calendar_link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"email_id" uuid,
	"from_address" varchar(320) NOT NULL,
	"subject" text,
	"body_text" text NOT NULL,
	"body_html" text,
	"classification" "reply_classification" DEFAULT 'unclassified' NOT NULL,
	"classification_confidence" numeric(4, 3),
	"classification_reasoning" text,
	"summary" text,
	"model" varchar(100),
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"cost_usd" numeric(10, 6) DEFAULT '0',
	"is_handled" boolean DEFAULT false NOT NULL,
	"handled_by" uuid,
	"handled_at" timestamp with time zone,
	"provider_message_id" varchar(500),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sending_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" varchar(255) NOT NULL,
	"status" "domain_status" DEFAULT 'pending_dns' NOT NULL,
	"spf_status" "dns_check_status" DEFAULT 'unknown' NOT NULL,
	"dkim_status" "dns_check_status" DEFAULT 'unknown' NOT NULL,
	"dmarc_status" "dns_check_status" DEFAULT 'unknown' NOT NULL,
	"dns_last_checked_at" timestamp with time zone,
	"dns_records" jsonb,
	"warmup_started_at" timestamp with time zone,
	"warmup_duration_days" integer DEFAULT 42 NOT NULL,
	"warmup_completed" boolean DEFAULT false NOT NULL,
	"daily_send_limit" integer DEFAULT 20 NOT NULL,
	"max_daily_send_limit" integer DEFAULT 200 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sending_inboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"email_address" varchar(320) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"reply_to_address" varchar(320),
	"status" "inbox_status" DEFAULT 'pending_setup' NOT NULL,
	"provider" varchar(50) DEFAULT 'resend' NOT NULL,
	"provider_inbox_id" varchar(255),
	"daily_send_limit" integer DEFAULT 10 NOT NULL,
	"max_daily_send_limit" integer DEFAULT 100 NOT NULL,
	"sent_today" integer DEFAULT 0 NOT NULL,
	"sent_today_reset_at" timestamp with time zone,
	"reputation_score" integer DEFAULT 50 NOT NULL,
	"total_sent" integer DEFAULT 0 NOT NULL,
	"total_bounced" integer DEFAULT 0 NOT NULL,
	"total_complaints" integer DEFAULT 0 NOT NULL,
	"warmup_started_at" timestamp with time zone,
	"warmup_completed" boolean DEFAULT false NOT NULL,
	"last_sent_at" timestamp with time zone,
	"paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"value" jsonb NOT NULL,
	"value_type" varchar(20) DEFAULT 'string' NOT NULL,
	"description" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"component" varchar(100) NOT NULL,
	"status" "health_status" DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"response_time_ms" integer,
	"message" text,
	"metadata" jsonb,
	"is_auto_fixable" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"email_verified" timestamp with time zone,
	"name" varchar(255),
	"password_hash" text,
	"image" text,
	"last_login_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_model_config" ADD CONSTRAINT "ai_model_config_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model_config" ADD CONSTRAINT "ai_model_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_research" ADD CONSTRAINT "ai_research_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_research" ADD CONSTRAINT "ai_research_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_inbox_id_sending_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."sending_inboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sending_domains" ADD CONSTRAINT "sending_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sending_inboxes" ADD CONSTRAINT "sending_inboxes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sending_inboxes" ADD CONSTRAINT "sending_inboxes_domain_id_sending_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."sending_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_health" ADD CONSTRAINT "system_health_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_model_config_org_op_idx" ON "ai_model_config" USING btree ("organization_id","operation");--> statement-breakpoint
CREATE INDEX "ai_prompts_org_op_idx" ON "ai_prompts" USING btree ("organization_id","operation","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_prompts_org_op_version_idx" ON "ai_prompts" USING btree ("organization_id","operation","version");--> statement-breakpoint
CREATE INDEX "ai_research_company_idx" ON "ai_research" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ai_research_org_idx" ON "ai_research" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_usage_org_period_idx" ON "ai_usage" USING btree ("organization_id","billing_period");--> statement-breakpoint
CREATE INDEX "ai_usage_org_op_idx" ON "ai_usage" USING btree ("organization_id","operation");--> statement-breakpoint
CREATE INDEX "ai_usage_created_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_usage_org_period_idx" ON "api_usage" USING btree ("organization_id","billing_period");--> statement-breakpoint
CREATE INDEX "api_usage_provider_idx" ON "api_usage" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE INDEX "audit_logs_org_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "background_jobs_claim_idx" ON "background_jobs" USING btree ("status","run_at","priority");--> statement-breakpoint
CREATE INDEX "background_jobs_org_type_idx" ON "background_jobs" USING btree ("organization_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_idempotency_idx" ON "background_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "background_jobs_status_idx" ON "background_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_org_status_idx" ON "campaigns" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "companies_org_idx" ON "companies" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_org_domain_idx" ON "companies" USING btree ("organization_id","domain");--> statement-breakpoint
CREATE INDEX "companies_name_idx" ON "companies" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_org_email_idx" ON "contacts" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contacts_suppression_idx" ON "contacts" USING btree ("organization_id","is_unsubscribed","is_suppressed");--> statement-breakpoint
CREATE INDEX "email_events_email_idx" ON "email_events" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "email_events_org_type_idx" ON "email_events" USING btree ("organization_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "email_events_provider_event_idx" ON "email_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "emails_lead_idx" ON "emails" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "emails_org_status_idx" ON "emails" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "emails_scheduled_idx" ON "emails" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "emails_provider_msg_idx" ON "emails" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "emails_thread_idx" ON "emails" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "emails_inbox_idx" ON "emails" USING btree ("inbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_org_contact_campaign_idx" ON "leads" USING btree ("organization_id","contact_id","campaign_id");--> statement-breakpoint
CREATE INDEX "leads_org_status_idx" ON "leads" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "leads_attention_idx" ON "leads" USING btree ("organization_id","requires_attention");--> statement-breakpoint
CREATE INDEX "leads_follow_up_due_idx" ON "leads" USING btree ("next_follow_up_at");--> statement-breakpoint
CREATE INDEX "leads_campaign_idx" ON "leads" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "notifications_org_read_idx" ON "notifications" USING btree ("organization_id","is_read");--> statement-breakpoint
CREATE INDEX "notifications_org_tier_idx" ON "notifications" USING btree ("organization_id","tier");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "replies_lead_idx" ON "replies" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "replies_org_classification_idx" ON "replies" USING btree ("organization_id","classification");--> statement-breakpoint
CREATE INDEX "replies_unhandled_idx" ON "replies" USING btree ("organization_id","is_handled");--> statement-breakpoint
CREATE UNIQUE INDEX "sending_domains_org_domain_idx" ON "sending_domains" USING btree ("organization_id","domain");--> statement-breakpoint
CREATE INDEX "sending_domains_status_idx" ON "sending_domains" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sending_inboxes_email_idx" ON "sending_inboxes" USING btree ("email_address");--> statement-breakpoint
CREATE INDEX "sending_inboxes_org_status_idx" ON "sending_inboxes" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "sending_inboxes_domain_idx" ON "sending_inboxes" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_org_key_idx" ON "settings" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "system_health_component_idx" ON "system_health" USING btree ("component");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");