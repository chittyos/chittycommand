-- 0003_codex_p2_fixes.sql
-- Resolves Codex P2 findings on PR #101.
--
-- F4 — composite FK on cc_intents(plan_id, goal_id) -> cc_plans(id, goal_id)
--      so an intent's goal_id MUST match its plan's goal_id. Requires a
--      UNIQUE(id, goal_id) constraint on cc_plans (Postgres requires the
--      referenced columns to have a unique/PK constraint covering them).
--
-- F1 — adds cc_intents.reclaim_count for the reclaimStuckIntents() bookkeeping
--      added in meta/intent.ts.
--
-- Validated on Neon branch br-delicate-mode-akkgde73 of project
-- cool-bar-13270800: matching (plan_id, goal_id) inserts succeed; mismatched
-- inserts fail with "violates foreign key constraint
-- cc_intents_plan_goal_cc_plans_fk".

-- fixes codex-p2 PR#101 finding-1
ALTER TABLE "cc_intents" ADD COLUMN IF NOT EXISTS "reclaim_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- fixes codex-p2 PR#101 finding-4
ALTER TABLE "cc_plans" ADD CONSTRAINT "cc_plans_id_goal_id_unique" UNIQUE ("id", "goal_id");
--> statement-breakpoint

-- fixes codex-p2 PR#101 finding-4
ALTER TABLE "cc_intents" DROP CONSTRAINT "cc_intents_plan_id_cc_plans_id_fk";
--> statement-breakpoint

-- fixes codex-p2 PR#101 finding-4
ALTER TABLE "cc_intents" ADD CONSTRAINT "cc_intents_plan_goal_cc_plans_fk"
  FOREIGN KEY ("plan_id", "goal_id") REFERENCES "public"."cc_plans"("id", "goal_id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
