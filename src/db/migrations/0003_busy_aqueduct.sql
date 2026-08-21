CREATE TABLE "strategy_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"is_control" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"angle_instructions" text,
	"cta_style" varchar(30),
	"target_length" varchar(20),
	"promoted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "variant_id" uuid;--> statement-breakpoint
ALTER TABLE "strategy_variants" ADD CONSTRAINT "strategy_variants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_variants" ADD CONSTRAINT "strategy_variants_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strategy_variants_org_idx" ON "strategy_variants" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "strategy_variants_campaign_idx" ON "strategy_variants" USING btree ("campaign_id","is_active");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_variant_id_strategy_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."strategy_variants"("id") ON DELETE set null ON UPDATE no action;