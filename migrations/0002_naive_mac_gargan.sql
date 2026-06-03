CREATE TABLE "cc_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_chitty_id" varchar(64) NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"target_date" timestamp with time zone,
	"achieved_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cc_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"intent_type" text NOT NULL,
	"target_channel" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"sovereignty_assessment" jsonb,
	"human_gate_reason" text,
	"dispatched_task_id" text,
	"scheduled_for" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cc_node_leases" (
	"role" text PRIMARY KEY NOT NULL,
	"node_id" varchar(64),
	"node_descriptor" text,
	"session_id" text,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cc_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"title" text NOT NULL,
	"rationale" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"supersedes_plan_id" uuid,
	"authored_by" varchar(64),
	"sovereignty_assessment" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "cc_intents" ADD CONSTRAINT "cc_intents_plan_id_cc_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."cc_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cc_intents" ADD CONSTRAINT "cc_intents_goal_id_cc_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."cc_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cc_plans" ADD CONSTRAINT "cc_plans_goal_id_cc_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."cc_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cc_goals_owner" ON "cc_goals" USING btree ("owner_chitty_id");--> statement-breakpoint
CREATE INDEX "idx_cc_goals_status" ON "cc_goals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_cc_goals_priority" ON "cc_goals" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "idx_cc_intents_plan" ON "cc_intents" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_cc_intents_goal" ON "cc_intents" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_cc_intents_status" ON "cc_intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_cc_intents_priority" ON "cc_intents" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "idx_cc_intents_scheduled" ON "cc_intents" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "idx_cc_node_leases_node" ON "cc_node_leases" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_cc_node_leases_expires" ON "cc_node_leases" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_cc_plans_goal" ON "cc_plans" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_cc_plans_status" ON "cc_plans" USING btree ("status");