ALTER TABLE "cc_disputes" ADD COLUMN "privilege" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "cc_disputes" ADD COLUMN "space" text DEFAULT 'business' NOT NULL;--> statement-breakpoint
ALTER TABLE "cc_intents" ADD COLUMN "privilege" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "cc_intents" ADD COLUMN "space" text DEFAULT 'business' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_cc_disputes_privilege" ON "cc_disputes" USING btree ("privilege","status");--> statement-breakpoint
CREATE INDEX "idx_cc_disputes_space" ON "cc_disputes" USING btree ("space","status");--> statement-breakpoint
CREATE INDEX "idx_cc_intents_privilege" ON "cc_intents" USING btree ("privilege","status");--> statement-breakpoint
CREATE INDEX "idx_cc_intents_space" ON "cc_intents" USING btree ("space","status");