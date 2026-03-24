CREATE TABLE IF NOT EXISTS "cc_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_id" text,
	"account_name" text NOT NULL,
	"account_type" text NOT NULL,
	"institution" text NOT NULL,
	"current_balance" numeric(12, 2),
	"credit_limit" numeric(12, 2),
	"interest_rate" numeric(5, 3),
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_actions_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"description" text NOT NULL,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"status" text NOT NULL,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"executed_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_cashflow_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projection_date" date NOT NULL,
	"projected_inflow" numeric(12, 2) DEFAULT '0',
	"projected_outflow" numeric(12, 2) DEFAULT '0',
	"projected_balance" numeric(12, 2) DEFAULT '0',
	"obligations" jsonb,
	"confidence" numeric(3, 2),
	"generated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_decision_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid,
	"obligation_id" uuid,
	"decision" text NOT NULL,
	"original_action" text,
	"modified_action" text,
	"confidence_at_decision" numeric(3, 2),
	"outcome_status" text,
	"outcome_recorded_at" timestamp with time zone,
	"session_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_dispute_correspondence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid,
	"direction" text NOT NULL,
	"channel" text NOT NULL,
	"subject" text,
	"content" text,
	"attachments" jsonb DEFAULT '[]'::jsonb,
	"sent_at" timestamp with time zone DEFAULT now(),
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"counterparty" text NOT NULL,
	"dispute_type" text NOT NULL,
	"amount_claimed" numeric(12, 2),
	"amount_at_stake" numeric(12, 2),
	"stage" text DEFAULT 'filed' NOT NULL,
	"status" text DEFAULT 'open',
	"priority" integer DEFAULT 5,
	"description" text,
	"next_action" text,
	"next_action_date" date,
	"resolution_target" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chitty_id" varchar(64),
	"doc_type" text NOT NULL,
	"source" text NOT NULL,
	"filename" text,
	"r2_key" text,
	"content_text" text,
	"parsed_data" jsonb,
	"linked_obligation_id" uuid,
	"linked_account_id" uuid,
	"linked_dispute_id" uuid,
	"processing_status" text DEFAULT 'pending',
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_legal_deadlines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chitty_id" varchar(64),
	"case_ref" text NOT NULL,
	"case_system" text,
	"deadline_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"deadline_date" timestamp with time zone NOT NULL,
	"reminder_days" integer[] DEFAULT '{7,3,1}',
	"status" text DEFAULT 'upcoming',
	"urgency_score" integer,
	"evidence_db_ref" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chitty_id" varchar(64),
	"account_id" uuid,
	"category" text NOT NULL,
	"subcategory" text,
	"payee" text NOT NULL,
	"amount_due" numeric(12, 2),
	"amount_minimum" numeric(12, 2),
	"due_date" date NOT NULL,
	"recurrence" text,
	"recurrence_day" integer,
	"status" text DEFAULT 'pending',
	"auto_pay" boolean DEFAULT false,
	"negotiable" boolean DEFAULT false,
	"late_fee" numeric(8, 2),
	"grace_period_days" integer DEFAULT 0,
	"urgency_score" integer,
	"action_type" text,
	"action_payload" jsonb,
	"source_doc_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_payment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_type" text NOT NULL,
	"horizon_days" integer DEFAULT 90,
	"starting_balance" numeric(12, 2),
	"ending_balance" numeric(12, 2),
	"lowest_balance" numeric(12, 2),
	"lowest_balance_date" date,
	"total_inflows" numeric(12, 2),
	"total_outflows" numeric(12, 2),
	"total_late_fees_avoided" numeric(12, 2) DEFAULT '0',
	"total_late_fees_risked" numeric(12, 2) DEFAULT '0',
	"schedule" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb,
	"status" text DEFAULT 'draft',
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chitty_id" varchar(64),
	"property_name" text,
	"address" text NOT NULL,
	"unit" text,
	"doorloop_id" text,
	"property_type" text,
	"monthly_hoa" numeric(8, 2),
	"hoa_payee" text,
	"annual_tax" numeric(12, 2),
	"tax_pin" text,
	"mortgage_account_id" uuid,
	"mortgage_servicer" text,
	"mortgage_account" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "cc_properties_tax_pin_unique" UNIQUE("tax_pin")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obligation_id" uuid,
	"dispute_id" uuid,
	"rec_type" text NOT NULL,
	"priority" integer NOT NULL,
	"title" text NOT NULL,
	"reasoning" text NOT NULL,
	"estimated_savings" numeric(10, 2),
	"action_type" text,
	"action_payload" jsonb,
	"action_url" text,
	"status" text DEFAULT 'active',
	"expires_at" timestamp with time zone,
	"model_version" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"acted_on_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_revenue_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_id" text,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"recurrence" text,
	"recurrence_day" integer,
	"next_expected_date" date,
	"confidence" numeric(3, 2) DEFAULT '0.50',
	"verified_by" text,
	"contract_ref" text,
	"account_id" uuid,
	"status" text DEFAULT 'active',
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_scrape_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chitty_id" varchar(64),
	"job_type" varchar(50) NOT NULL,
	"target" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now(),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result" jsonb,
	"error_message" text,
	"parent_job_id" uuid,
	"cron_source" varchar(30),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chitty_id" varchar(64),
	"source" text NOT NULL,
	"sync_type" text NOT NULL,
	"status" text NOT NULL,
	"records_synced" integer DEFAULT 0,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now(),
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"notion_page_id" text,
	"title" text NOT NULL,
	"description" text,
	"task_type" text DEFAULT 'general' NOT NULL,
	"source" text DEFAULT 'notion' NOT NULL,
	"priority" integer DEFAULT 5,
	"backend_status" text DEFAULT 'queued' NOT NULL,
	"assigned_to" text,
	"due_date" date,
	"verification_type" text DEFAULT 'soft' NOT NULL,
	"verification_artifact" text,
	"verification_notes" text,
	"verified_at" timestamp with time zone,
	"spawned_recommendation_id" uuid,
	"ledger_record_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "cc_tasks_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "cc_tasks_notion_page_id_unique" UNIQUE("notion_page_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cc_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"obligation_id" uuid,
	"source" text NOT NULL,
	"source_id" text,
	"counterparty" text,
	"amount" numeric(12, 2) NOT NULL,
	"direction" text NOT NULL,
	"description" text,
	"category" text,
	"tx_date" date NOT NULL,
	"posted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_decision_feedback" ADD CONSTRAINT "cc_decision_feedback_recommendation_id_cc_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."cc_recommendations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_decision_feedback" ADD CONSTRAINT "cc_decision_feedback_obligation_id_cc_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."cc_obligations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_dispute_correspondence" ADD CONSTRAINT "cc_dispute_correspondence_dispute_id_cc_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."cc_disputes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_documents" ADD CONSTRAINT "cc_documents_linked_obligation_id_cc_obligations_id_fk" FOREIGN KEY ("linked_obligation_id") REFERENCES "public"."cc_obligations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_documents" ADD CONSTRAINT "cc_documents_linked_account_id_cc_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."cc_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_documents" ADD CONSTRAINT "cc_documents_linked_dispute_id_cc_disputes_id_fk" FOREIGN KEY ("linked_dispute_id") REFERENCES "public"."cc_disputes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_obligations" ADD CONSTRAINT "cc_obligations_account_id_cc_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cc_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_properties" ADD CONSTRAINT "cc_properties_mortgage_account_id_cc_accounts_id_fk" FOREIGN KEY ("mortgage_account_id") REFERENCES "public"."cc_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_recommendations" ADD CONSTRAINT "cc_recommendations_obligation_id_cc_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."cc_obligations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_recommendations" ADD CONSTRAINT "cc_recommendations_dispute_id_cc_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."cc_disputes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_revenue_sources" ADD CONSTRAINT "cc_revenue_sources_account_id_cc_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cc_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_tasks" ADD CONSTRAINT "cc_tasks_spawned_recommendation_id_cc_recommendations_id_fk" FOREIGN KEY ("spawned_recommendation_id") REFERENCES "public"."cc_recommendations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_transactions" ADD CONSTRAINT "cc_transactions_account_id_cc_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cc_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cc_transactions" ADD CONSTRAINT "cc_transactions_obligation_id_cc_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."cc_obligations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_actions_log_date" ON "cc_actions_log" USING btree ("executed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_cashflow_date" ON "cc_cashflow_projections" USING btree ("projection_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_decision_feedback_rec" ON "cc_decision_feedback" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_decision_feedback_ob" ON "cc_decision_feedback" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_decision_feedback_created" ON "cc_decision_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_dispute_corr_dispute" ON "cc_dispute_correspondence" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_legal_deadlines_date" ON "cc_legal_deadlines" USING btree ("deadline_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_obligations_due" ON "cc_obligations" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_obligations_status" ON "cc_obligations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_obligations_urgency" ON "cc_obligations" USING btree ("urgency_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_payment_plans_status" ON "cc_payment_plans" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_recommendations_priority" ON "cc_recommendations" USING btree ("priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_recommendations_status" ON "cc_recommendations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_revenue_sources_next" ON "cc_revenue_sources" USING btree ("next_expected_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_revenue_sources_status" ON "cc_revenue_sources" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_scrape_jobs_status" ON "cc_scrape_jobs" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_scrape_jobs_type" ON "cc_scrape_jobs" USING btree ("job_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_scrape_jobs_chitty" ON "cc_scrape_jobs" USING btree ("chitty_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_tasks_status" ON "cc_tasks" USING btree ("backend_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_tasks_external_id" ON "cc_tasks" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_tasks_notion_page_id" ON "cc_tasks" USING btree ("notion_page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_tasks_due_date" ON "cc_tasks" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_tasks_priority" ON "cc_tasks" USING btree ("priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_tasks_type" ON "cc_tasks" USING btree ("task_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_transactions_date" ON "cc_transactions" USING btree ("tx_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_transactions_account" ON "cc_transactions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_transactions_source" ON "cc_transactions" USING btree ("source","source_id");