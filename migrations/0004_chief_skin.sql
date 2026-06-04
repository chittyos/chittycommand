ALTER TABLE "cc_actions_log" ADD COLUMN "intent_id" uuid;--> statement-breakpoint
ALTER TABLE "cc_actions_log" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "cc_actions_log" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "cc_actions_log" ADD CONSTRAINT "cc_actions_log_intent_id_cc_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."cc_intents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cc_actions_log_intent_executed" ON "cc_actions_log" USING btree ("intent_id","executed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cc_actions_log_intent_idempotency" ON "cc_actions_log" USING btree ("intent_id","idempotency_key") WHERE intent_id IS NOT NULL AND idempotency_key IS NOT NULL;