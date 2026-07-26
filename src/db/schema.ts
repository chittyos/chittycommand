import { pgTable, uuid, varchar, text, numeric, boolean, integer, date, timestamp, jsonb, index, uniqueIndex, unique, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Accounts ──────────────────────────────────────────────────
export const ccAccounts = pgTable('cc_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull(),
  sourceId: text('source_id'),
  accountName: text('account_name').notNull(),
  accountType: text('account_type').notNull(),
  institution: text('institution').notNull(),
  currentBalance: numeric('current_balance', { precision: 12, scale: 2 }),
  creditLimit: numeric('credit_limit', { precision: 12, scale: 2 }),
  interestRate: numeric('interest_rate', { precision: 5, scale: 3 }),
  metadata: jsonb('metadata').default({}),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ── Obligations ───────────────────────────────────────────────
export const ccObligations = pgTable('cc_obligations', {
  id: uuid('id').primaryKey().defaultRandom(),
  chittyId: varchar('chitty_id', { length: 64 }),
  accountId: uuid('account_id').references(() => ccAccounts.id),
  category: text('category').notNull(),
  subcategory: text('subcategory'),
  payee: text('payee').notNull(),
  amountDue: numeric('amount_due', { precision: 12, scale: 2 }),
  amountMinimum: numeric('amount_minimum', { precision: 12, scale: 2 }),
  dueDate: date('due_date').notNull(),
  recurrence: text('recurrence'),
  recurrenceDay: integer('recurrence_day'),
  status: text('status').default('pending'),
  autoPay: boolean('auto_pay').default(false),
  negotiable: boolean('negotiable').default(false),
  lateFee: numeric('late_fee', { precision: 8, scale: 2 }),
  gracePeriodDays: integer('grace_period_days').default(0),
  urgencyScore: integer('urgency_score'),
  actionType: text('action_type'),
  actionPayload: jsonb('action_payload'),
  sourceDocId: uuid('source_doc_id'),
  // Escalation tracking (migration 0008)
  escalationType: text('escalation_type'),
  escalationThresholdDays: integer('escalation_threshold_days'),
  escalationAmount: numeric('escalation_amount', { precision: 8, scale: 2 }),
  creditImpactScore: integer('credit_impact_score'),
  preferredAccountId: uuid('preferred_account_id').references(() => ccAccounts.id),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  dueDateIdx: index('idx_cc_obligations_due').on(table.dueDate),
  statusIdx: index('idx_cc_obligations_status').on(table.status),
  urgencyIdx: index('idx_cc_obligations_urgency').on(table.urgencyScore),
}));

// ── Transactions ──────────────────────────────────────────────
export const ccTransactions = pgTable('cc_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').references(() => ccAccounts.id),
  obligationId: uuid('obligation_id').references(() => ccObligations.id),
  source: text('source').notNull(),
  sourceId: text('source_id'),
  counterparty: text('counterparty'),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  direction: text('direction').notNull(),
  description: text('description'),
  category: text('category'),
  txDate: date('tx_date').notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  dateIdx: index('idx_cc_transactions_date').on(table.txDate),
  accountIdx: index('idx_cc_transactions_account').on(table.accountId),
  sourceIdx: index('idx_cc_transactions_source').on(table.source, table.sourceId),
}));

// ── Properties ────────────────────────────────────────────────
export const ccProperties = pgTable('cc_properties', {
  id: uuid('id').primaryKey().defaultRandom(),
  chittyId: varchar('chitty_id', { length: 64 }),
  propertyName: text('property_name'),
  address: text('address').notNull(),
  unit: text('unit'),
  doorloopId: text('doorloop_id'),
  propertyType: text('property_type'),
  monthlyHoa: numeric('monthly_hoa', { precision: 8, scale: 2 }),
  hoaPayee: text('hoa_payee'),
  annualTax: numeric('annual_tax', { precision: 12, scale: 2 }),
  taxPin: text('tax_pin').unique(),
  mortgageAccountId: uuid('mortgage_account_id').references(() => ccAccounts.id),
  mortgageServicer: text('mortgage_servicer'),
  mortgageAccount: text('mortgage_account'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ── Legal Deadlines ───────────────────────────────────────────
export const ccLegalDeadlines = pgTable('cc_legal_deadlines', {
  id: uuid('id').primaryKey().defaultRandom(),
  chittyId: varchar('chitty_id', { length: 64 }),
  caseRef: text('case_ref').notNull(),
  caseSystem: text('case_system'),
  deadlineType: text('deadline_type').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  deadlineDate: timestamp('deadline_date', { withTimezone: true }).notNull(),
  reminderDays: integer('reminder_days').array().default(sql`'{7,3,1}'`),
  status: text('status').default('upcoming'),
  urgencyScore: integer('urgency_score'),
  evidenceDbRef: text('evidence_db_ref'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  dateIdx: index('idx_cc_legal_deadlines_date').on(table.deadlineDate),
}));


// ── Documents ─────────────────────────────────────────────────
export const ccDocuments = pgTable('cc_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  chittyId: varchar('chitty_id', { length: 64 }),
  docType: text('doc_type').notNull(),
  source: text('source').notNull(),
  filename: text('filename'),
  r2Key: text('r2_key'),
  contentText: text('content_text'),
  parsedData: jsonb('parsed_data'),
  linkedObligationId: uuid('linked_obligation_id').references(() => ccObligations.id),
  linkedAccountId: uuid('linked_account_id').references(() => ccAccounts.id),
  linkedDisputeId: text('linked_dispute_id'), // Migrating away from local FK to ChittyCases reference
  processingStatus: text('processing_status').default('pending'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ── Recommendations ───────────────────────────────────────────
export const ccRecommendations = pgTable('cc_recommendations', {
  id: uuid('id').primaryKey().defaultRandom(),
  obligationId: uuid('obligation_id').references(() => ccObligations.id),
  disputeId: text('dispute_id'), // Migrating away from local FK to ChittyCases reference
  recType: text('rec_type').notNull(),
  priority: integer('priority').notNull(),
  title: text('title').notNull(),
  reasoning: text('reasoning').notNull(),
  estimatedSavings: numeric('estimated_savings', { precision: 10, scale: 2 }),
  actionType: text('action_type'),
  actionPayload: jsonb('action_payload'),
  actionUrl: text('action_url'),
  status: text('status').default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  modelVersion: text('model_version'),
  // Planner-aware fields (migration 0008)
  confidence: numeric('confidence', { precision: 3, scale: 2 }),
  suggestedAccountId: uuid('suggested_account_id').references(() => ccAccounts.id),
  suggestedAmount: numeric('suggested_amount', { precision: 12, scale: 2 }),
  paymentSequence: integer('payment_sequence'),
  escalationRisk: text('escalation_risk'),
  scenarioImpact: jsonb('scenario_impact'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  actedOnAt: timestamp('acted_on_at', { withTimezone: true }),
}, (table) => ({
  priorityIdx: index('idx_cc_recommendations_priority').on(table.priority),
  statusIdx: index('idx_cc_recommendations_status').on(table.status),
}));

// ── Actions Log ───────────────────────────────────────────────
// ADR-001 amendment (PR-A): intent-execution audit lives here, NOT in a
// separate `intent_executions` table. Three additive columns + two indexes
// per chittyschema-overlord review.
export const ccActionsLog = pgTable('cc_actions_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actionType: text('action_type').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id'),
  description: text('description').notNull(),
  requestPayload: jsonb('request_payload'),
  responsePayload: jsonb('response_payload'),
  status: text('status').notNull(),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata').default({}),
  executedAt: timestamp('executed_at', { withTimezone: true }).defaultNow(),
  // Intent-execution linkage (nullable — ActionAgent chat path writes rows
  // without an intent context).
  intentId: uuid('intent_id').references(() => ccIntents.id, { onDelete: 'set null' }),
  attempt: integer('attempt').notNull().default(1),
  idempotencyKey: text('idempotency_key'),
}, (table) => ({
  dateIdx: index('idx_cc_actions_log_date').on(table.executedAt),
  intentExecutedIdx: index('idx_cc_actions_log_intent_executed').on(
    table.intentId,
    table.executedAt.desc(),
  ),
  intentIdempotencyUq: uniqueIndex('uq_cc_actions_log_intent_idempotency')
    .on(table.intentId, table.idempotencyKey)
    .where(sql`intent_id IS NOT NULL AND idempotency_key IS NOT NULL`),
}));

// ── Cash Flow Projections ─────────────────────────────────────
export const ccCashflowProjections = pgTable('cc_cashflow_projections', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectionDate: date('projection_date').notNull(),
  projectedInflow: numeric('projected_inflow', { precision: 12, scale: 2 }).default('0'),
  projectedOutflow: numeric('projected_outflow', { precision: 12, scale: 2 }).default('0'),
  projectedBalance: numeric('projected_balance', { precision: 12, scale: 2 }).default('0'),
  obligations: jsonb('obligations'),
  confidence: numeric('confidence', { precision: 3, scale: 2 }),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  dateIdx: index('idx_cc_cashflow_date').on(table.projectionDate),
}));

// ── Decision Feedback ────────────────────────────────────────
export const ccDecisionFeedback = pgTable('cc_decision_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  recommendationId: uuid('recommendation_id').references(() => ccRecommendations.id),
  obligationId: uuid('obligation_id').references(() => ccObligations.id),
  decision: text('decision').notNull(),
  originalAction: text('original_action'),
  modifiedAction: text('modified_action'),
  confidenceAtDecision: numeric('confidence_at_decision', { precision: 3, scale: 2 }),
  outcomeStatus: text('outcome_status'),
  outcomeRecordedAt: timestamp('outcome_recorded_at', { withTimezone: true }),
  sessionId: uuid('session_id'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  recIdx: index('idx_cc_decision_feedback_rec').on(table.recommendationId),
  obIdx: index('idx_cc_decision_feedback_ob').on(table.obligationId),
  createdIdx: index('idx_cc_decision_feedback_created').on(table.createdAt),
}));

// ── Revenue Sources ──────────────────────────────────────────
export const ccRevenueSources = pgTable('cc_revenue_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull(),
  sourceId: text('source_id'),
  description: text('description').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  recurrence: text('recurrence'),
  recurrenceDay: integer('recurrence_day'),
  nextExpectedDate: date('next_expected_date'),
  confidence: numeric('confidence', { precision: 3, scale: 2 }).default('0.50'),
  verifiedBy: text('verified_by'),
  contractRef: text('contract_ref'),
  accountId: uuid('account_id').references(() => ccAccounts.id),
  status: text('status').default('active'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  nextIdx: index('idx_cc_revenue_sources_next').on(table.nextExpectedDate),
  statusIdx: index('idx_cc_revenue_sources_status').on(table.status),
}));

// ── Payment Plans ────────────────────────────────────────────
export const ccPaymentPlans = pgTable('cc_payment_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  planType: text('plan_type').notNull(),
  horizonDays: integer('horizon_days').default(90),
  startingBalance: numeric('starting_balance', { precision: 12, scale: 2 }),
  endingBalance: numeric('ending_balance', { precision: 12, scale: 2 }),
  lowestBalance: numeric('lowest_balance', { precision: 12, scale: 2 }),
  lowestBalanceDate: date('lowest_balance_date'),
  totalInflows: numeric('total_inflows', { precision: 12, scale: 2 }),
  totalOutflows: numeric('total_outflows', { precision: 12, scale: 2 }),
  totalLateFeesAvoided: numeric('total_late_fees_avoided', { precision: 12, scale: 2 }).default('0'),
  totalLateFeesRisked: numeric('total_late_fees_risked', { precision: 12, scale: 2 }).default('0'),
  schedule: jsonb('schedule').notNull(),
  warnings: jsonb('warnings').default([]),
  status: text('status').default('draft'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  statusIdx: index('idx_cc_payment_plans_status').on(table.status),
}));

// ── Sync Log ──────────────────────────────────────────────────
export const ccSyncLog = pgTable('cc_sync_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  chittyId: varchar('chitty_id', { length: 64 }),
  source: text('source').notNull(),
  syncType: text('sync_type').notNull(),
  status: text('status').notNull(),
  recordsSynced: integer('records_synced').default(0),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

// ── Tasks ────────────────────────────────────────────────────
export const ccTasks = pgTable('cc_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalId: text('external_id').unique().notNull(),
  notionPageId: text('notion_page_id').unique(),
  title: text('title').notNull(),
  description: text('description'),
  taskType: text('task_type').notNull().default('general'),
  source: text('source').notNull().default('notion'),
  priority: integer('priority').default(5),
  backendStatus: text('backend_status').notNull().default('queued'),
  assignedTo: text('assigned_to'),
  dueDate: date('due_date'),
  verificationType: text('verification_type').notNull().default('soft'),
  verificationArtifact: text('verification_artifact'),
  verificationNotes: text('verification_notes'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  spawnedRecommendationId: uuid('spawned_recommendation_id').references(() => ccRecommendations.id),
  ledgerRecordId: text('ledger_record_id'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  statusIdx: index('idx_cc_tasks_status').on(table.backendStatus),
  externalIdIdx: index('idx_cc_tasks_external_id').on(table.externalId),
  notionPageIdIdx: index('idx_cc_tasks_notion_page_id').on(table.notionPageId),
  dueDateIdx: index('idx_cc_tasks_due_date').on(table.dueDate),
  priorityIdx: index('idx_cc_tasks_priority').on(table.priority),
  typeIdx: index('idx_cc_tasks_type').on(table.taskType),
}));

// ── Scrape Jobs ─────────────────────────────────────────────
export const ccScrapeJobs = pgTable('cc_scrape_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  chittyId: varchar('chitty_id', { length: 64 }),
  jobType: varchar('job_type', { length: 50 }).notNull(),
  target: jsonb('target').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('queued'),
  attempt: integer('attempt').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  result: jsonb('result'),
  errorMessage: text('error_message'),
  parentJobId: uuid('parent_job_id'),
  cronSource: varchar('cron_source', { length: 30 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  statusIdx: index('idx_cc_scrape_jobs_status').on(table.status, table.scheduledAt),
  typeIdx: index('idx_cc_scrape_jobs_type').on(table.jobType),
  chittyIdx: index('idx_cc_scrape_jobs_chitty').on(table.chittyId),
}));

// ── Email Connections (migration 0009) ──────────────────────
export const ccEmailConnections = pgTable('cc_email_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  emailAddress: text('email_address').notNull(),
  displayName: text('display_name'),
  connectRef: text('connect_ref'),
  namespace: text('namespace'),
  status: text('status').default('pending'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  errorMessage: text('error_message'),
  config: jsonb('config').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  emailUserIdx: index('idx_cc_email_conn_email_user').on(table.emailAddress, table.userId),
  userIdx: index('idx_cc_email_conn_user').on(table.userId),
  namespaceIdx: index('idx_cc_email_conn_namespace').on(table.namespace),
}));

// ── User Namespaces (migration 0009) ────────────────────────
export const ccUserNamespaces = pgTable('cc_user_namespaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().unique(),
  namespace: text('namespace').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ─────────────────────────────────────────────────────────────
// Meta-orchestrator: Goal → Plan → Intent ladder
// ADR-001 — chittycanon://docs/architecture/chittycommand/ADR-001
// ─────────────────────────────────────────────────────────────

// ── Goals (top of ladder) ────────────────────────────────────
// A Goal is a long-horizon outcome the operator wants achieved.
// Owned by a ChittyID actor (P-Synthetic for command, P-Natural for nb).
export const ccGoals = pgTable('cc_goals', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerChittyId: varchar('owner_chitty_id', { length: 64 }).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  // 'open' | 'planning' | 'active' | 'achieved' | 'abandoned'
  status: text('status').notNull().default('open'),
  priority: integer('priority').notNull().default(5),
  // Soft deadline; goals can outlive any single plan
  targetDate: timestamp('target_date', { withTimezone: true }),
  achievedAt: timestamp('achieved_at', { withTimezone: true }),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  ownerIdx: index('idx_cc_goals_owner').on(table.ownerChittyId),
  statusIdx: index('idx_cc_goals_status').on(table.status),
  priorityIdx: index('idx_cc_goals_priority').on(table.priority),
}));

// ── Plans (middle of ladder) ─────────────────────────────────
// A Plan is a concrete strategy to advance one Goal. A goal may have
// multiple plans over time (replans, alternative strategies).
export const ccPlans = pgTable('cc_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  goalId: uuid('goal_id').references(() => ccGoals.id, { onDelete: 'cascade' }).notNull(),
  title: text('title').notNull(),
  rationale: text('rationale'),
  // 'draft' | 'active' | 'superseded' | 'completed' | 'abandoned'
  status: text('status').notNull().default('draft'),
  // If this plan replaces a previous one, point to it
  supersedesPlanId: uuid('supersedes_plan_id'),
  // Author — usually a ChittyID for the planning agent
  authoredBy: varchar('authored_by', { length: 64 }),
  // Sovereignty assessment at the time the plan was authored
  // { decision: 'autonomous'|'requires_human'|'blocked', trustScore: number, reasoning: string }
  sovereigntyAssessment: jsonb('sovereignty_assessment'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  goalIdx: index('idx_cc_plans_goal').on(table.goalId),
  statusIdx: index('idx_cc_plans_status').on(table.status),
  // fixes codex-p2 PR#101 finding-4 — backs composite FK from cc_intents
  idGoalUnique: unique('cc_plans_id_goal_id_unique').on(table.id, table.goalId),
}));

// ── Intents (bottom of ladder — executable units) ────────────
// An Intent is a discrete action the meta-orchestrator routes for
// execution. Below this sits the existing task queue + ActionAgent.
export const ccIntents = pgTable('cc_intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  // fixes codex-p2 PR#101 finding-4 — plan_id FK is now composite (plan_id,
  // goal_id) -> cc_plans(id, goal_id) via the table-level foreignKey() below.
  // goalId keeps its standalone FK to cc_goals so orphan goals still cascade.
  planId: uuid('plan_id').notNull(),
  goalId: uuid('goal_id').references(() => ccGoals.id, { onDelete: 'cascade' }).notNull(),
  // What kind of intent: 'payment' | 'message' | 'status_update' | 'investigate' | etc.
  intentType: text('intent_type').notNull(),
  // Channel the intent should be fanned out through (matches channel registry).
  // null = let the orchestrator pick.
  targetChannel: text('target_channel'),
  // Free-form structured payload — the contract is per intent_type.
  payload: jsonb('payload').notNull().default({}),
  // 'pending' | 'claimed' | 'running' | 'done' | 'failed' | 'blocked_human'
  status: text('status').notNull().default('pending'),
  priority: integer('priority').notNull().default(5),
  // Sovereignty gate decision (frozen at intent enqueue time)
  // { decision, trustScore, reasoning, assessed_at }
  sovereigntyAssessment: jsonb('sovereignty_assessment'),
  // If the gate said requires_human, who/what is blocking
  humanGateReason: text('human_gate_reason'),
  // Link to the underlying task once dispatched
  dispatchedTaskId: text('dispatched_task_id'),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // Free-form error from the executor
  errorMessage: text('error_message'),
  // fixes codex-p2 PR#101 finding-1 — bookkeeping for reclaimStuckIntents()
  reclaimCount: integer('reclaim_count').notNull().default(0),
  // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
  // privilege ∈ {privileged, pii, hoa_evidentiary, public}
  privilege: text('privilege').notNull().default('public'),
  // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
  // space ∈ {business, legalink}
  space: text('space').notNull().default('business'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  planIdx: index('idx_cc_intents_plan').on(table.planId),
  goalIdx: index('idx_cc_intents_goal').on(table.goalId),
  statusIdx: index('idx_cc_intents_status').on(table.status),
  priorityIdx: index('idx_cc_intents_priority').on(table.priority),
  scheduledIdx: index('idx_cc_intents_scheduled').on(table.scheduledFor),
  // @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING
  privilegeIdx: index('idx_cc_intents_privilege').on(table.privilege, table.status),
  spaceIdx: index('idx_cc_intents_space').on(table.space, table.status),
  // fixes codex-p2 PR#101 finding-4 — composite FK so intent.goal_id MUST
  // match its plan's goal_id. Backed by UNIQUE(id, goal_id) on cc_plans.
  planGoalFk: foreignKey({
    name: 'cc_intents_plan_goal_cc_plans_fk',
    columns: [table.planId, table.goalId],
    foreignColumns: [ccPlans.id, ccPlans.goalId],
  }).onDelete('cascade'),
}));

// ─────────────────────────────────────────────────────────────
// Cluster daemon: node lease / leader election
// Mirrors chittyentity workers/shared/agent-tasks.ts task_leases shape.
// ADR-001 — chittycanon://docs/architecture/chittycommand/ADR-001
// ─────────────────────────────────────────────────────────────

// ── Node Leases ──────────────────────────────────────────────
// One row per cluster role. Leader election = atomic UPDATE...RETURNING
// on the matching role row. Heartbeat extends lease_expires_at.
// nodeId is the per-node ChittyID (Location type, format VV-G-LLL-SSSS-L-YM-C-X).
export const ccNodeLeases = pgTable('cc_node_leases', {
  // The role being elected. Foundation PR uses 'meta-orchestrator-leader'.
  role: text('role').primaryKey(),
  // ChittyID of the node currently holding the lease, or null when free.
  nodeId: varchar('node_id', { length: 64 }),
  // Free-form descriptor (hostname, region) for ops.
  nodeDescriptor: text('node_descriptor'),
  // Process/session id; allows the same node host to take/release across restarts.
  sessionId: text('session_id'),
  // Lease tracking — mirrors task_leases columns
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  nodeIdx: index('idx_cc_node_leases_node').on(table.nodeId),
  expiresIdx: index('idx_cc_node_leases_expires').on(table.leaseExpiresAt),
}));

// ─────────────────────────────────────────────────────────────
// Vendor spend control (migration 0019)
// Recurring org/operational vendors (GitHub, Cloudflare, Anthropic, OpenAI,
// Neon, chittysecrets, …). Risk scoring lives in src/lib/vendor-risk.ts; the
// payment_status='failed'|'limited' signal is the autopay-bounce alarm.
// ─────────────────────────────────────────────────────────────
export const ccVendors = pgTable('cc_vendors', {
  id: uuid('id').primaryKey().defaultRandom(),
  vendorName: text('vendor_name').notNull().unique(),
  category: text('category').default('other'),
  billingCycle: text('billing_cycle'),
  expectedAmount: numeric('expected_amount', { precision: 12, scale: 2 }),
  currency: text('currency').default('USD'),
  nextBillDate: date('next_bill_date'),
  autoPay: boolean('auto_pay').default(false),
  paymentStatus: text('payment_status').default('unknown'),
  paymentMethod: text('payment_method'),
  spendingLimit: numeric('spending_limit', { precision: 12, scale: 2 }),
  mtdSpend: numeric('mtd_spend', { precision: 12, scale: 2 }).default('0'),
  budgetLimit: numeric('budget_limit', { precision: 12, scale: 2 }),
  status: text('status').default('active'),
  owner: text('owner'),
  accountId: uuid('account_id').references(() => ccAccounts.id),
  riskScore: integer('risk_score'),
  lastChargeAt: timestamp('last_charge_at', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  categoryIdx: index('idx_cc_vendors_category').on(table.category),
  statusIdx: index('idx_cc_vendors_status').on(table.status),
  nextBillIdx: index('idx_cc_vendors_next_bill').on(table.nextBillDate),
  riskIdx: index('idx_cc_vendors_risk').on(table.riskScore),
}));
