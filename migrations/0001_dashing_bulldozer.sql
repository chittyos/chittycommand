CREATE TABLE "cc_email_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"email_address" text NOT NULL,
	"display_name" text,
	"connect_ref" text,
	"namespace" text,
	"status" text DEFAULT 'pending',
	"last_synced_at" timestamp with time zone,
	"error_message" text,
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cc_user_namespaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"namespace" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "cc_user_namespaces_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "cc_user_namespaces_namespace_unique" UNIQUE("namespace")
);
--> statement-breakpoint
ALTER TABLE "cc_obligations" ADD COLUMN "escalation_type" text;--> statement-breakpoint
ALTER TABLE "cc_obligations" ADD COLUMN "escalation_threshold_days" integer;--> statement-breakpoint
ALTER TABLE "cc_obligations" ADD COLUMN "escalation_amount" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "cc_obligations" ADD COLUMN "credit_impact_score" integer;--> statement-breakpoint
ALTER TABLE "cc_obligations" ADD COLUMN "preferred_account_id" uuid;--> statement-breakpoint
ALTER TABLE "cc_recommendations" ADD COLUMN "confidence" numeric(3, 2);--> statement-breakpoint
ALTER TABLE "cc_recommendations" ADD COLUMN "suggested_account_id" uuid;--> statement-breakpoint
ALTER TABLE "cc_recommendations" ADD COLUMN "suggested_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "cc_recommendations" ADD COLUMN "payment_sequence" integer;--> statement-breakpoint
ALTER TABLE "cc_recommendations" ADD COLUMN "escalation_risk" text;--> statement-breakpoint
ALTER TABLE "cc_recommendations" ADD COLUMN "scenario_impact" jsonb;--> statement-breakpoint
CREATE INDEX "idx_cc_email_conn_email_user" ON "cc_email_connections" USING btree ("email_address","user_id");--> statement-breakpoint
CREATE INDEX "idx_cc_email_conn_user" ON "cc_email_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_cc_email_conn_namespace" ON "cc_email_connections" USING btree ("namespace");--> statement-breakpoint
ALTER TABLE "cc_obligations" ADD CONSTRAINT "cc_obligations_preferred_account_id_cc_accounts_id_fk" FOREIGN KEY ("preferred_account_id") REFERENCES "public"."cc_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cc_recommendations" ADD CONSTRAINT "cc_recommendations_suggested_account_id_cc_accounts_id_fk" FOREIGN KEY ("suggested_account_id") REFERENCES "public"."cc_accounts"("id") ON DELETE no action ON UPDATE no action;