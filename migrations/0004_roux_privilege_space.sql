-- 0004_roux_privilege_space.sql
-- ChittyRoux carry-through: add privilege + space classification axes to
-- cc_intents and cc_disputes for ChittyTriage routing.
--
-- @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
--
-- Two new axes per ratified Roux vocabulary:
--   privilege ∈ {privileged, pii, hoa_evidentiary, public}
--   space     ∈ {business, legalink}
--
-- CHECK constraints are intentionally deferred — the Roux spec URI is PENDING
-- CERTIFIED; we enforce the enum in the application layer (meta/sovereignty.ts
-- + meta/intent.ts) and will add CHECK constraints in a follow-up once the
-- canonical spec is certified.
--
-- Defaults (public/business) match the lowest-privilege public-bucket so the
-- migration is safe to apply against existing rows.
--
-- Validated on Neon branch br-broad-mud-ak4k790p of project
-- cool-bar-13270800: ADD COLUMN + CREATE INDEX succeed on top of the
-- post-0003 schema; default values applied to existing rows.

-- @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
ALTER TABLE "cc_intents" ADD COLUMN "privilege" text NOT NULL DEFAULT 'public';
--> statement-breakpoint

-- @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
ALTER TABLE "cc_intents" ADD COLUMN "space" text NOT NULL DEFAULT 'business';
--> statement-breakpoint

CREATE INDEX "idx_cc_intents_privilege" ON "cc_intents" ("privilege", "status");
--> statement-breakpoint

CREATE INDEX "idx_cc_intents_space" ON "cc_intents" ("space", "status");
--> statement-breakpoint

-- @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
ALTER TABLE "cc_disputes" ADD COLUMN "privilege" text NOT NULL DEFAULT 'public';
--> statement-breakpoint

-- @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
ALTER TABLE "cc_disputes" ADD COLUMN "space" text NOT NULL DEFAULT 'business';
--> statement-breakpoint

CREATE INDEX "idx_cc_disputes_privilege" ON "cc_disputes" ("privilege", "status");
--> statement-breakpoint

CREATE INDEX "idx_cc_disputes_space" ON "cc_disputes" ("space", "status");
