-- Codex P2 fixes (PR #103):
--   F1 — cc_intents.reclaim_count column for reclaimStuckIntents() bookkeeping.
--   F4 — composite FK cc_intents(plan_id, goal_id) -> cc_plans(id, goal_id).
ALTER TABLE "cc_intents" ADD COLUMN "reclaim_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cc_plans" ADD CONSTRAINT "cc_plans_id_goal_id_unique" UNIQUE("id","goal_id");--> statement-breakpoint
ALTER TABLE "cc_intents" DROP CONSTRAINT "cc_intents_plan_id_cc_plans_id_fk";--> statement-breakpoint
ALTER TABLE "cc_intents" ADD CONSTRAINT "cc_intents_plan_goal_cc_plans_fk" FOREIGN KEY ("plan_id","goal_id") REFERENCES "public"."cc_plans"("id","goal_id") ON DELETE cascade ON UPDATE no action;
