ALTER TYPE "public"."email_kind" ADD VALUE 'follow_up_3';--> statement-breakpoint
ALTER TABLE "ai_research" ADD COLUMN "fit_score" integer;--> statement-breakpoint
ALTER TABLE "ai_research" ADD COLUMN "hook_quality_score" integer;--> statement-breakpoint
ALTER TABLE "ai_research" ADD COLUMN "disqualifiers" jsonb;