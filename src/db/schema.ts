import { pgTable, uuid, text, numeric, boolean, integer, date, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
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

// ── Disputes ──────────────────────────────────────────────────
export const ccDisputes = pgTable('cc_disputes', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  counterparty: text('counterparty').notNull(),
  disputeType: text('dispute_type').notNull(),
  amountClaimed: numeric('amount_claimed', { precision: 12, scale: 2 }),
  amountAtStake: numeric('amount_at_stake', { precision: 12, scale: 2 }),
  status: text('status').default('open'),
  priority: integer('priority').default(5),
  description: text('description'),
  nextAction: text('next_action'),
  nextActionDate: date('next_action_date'),
  resolutionTarget: text('resolution_target'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// ── Dispute Correspondence ────────────────────────────────────
export const ccDisputeCorrespondence = pgTable('cc_dispute_correspondence', {
  id: uuid('id').primaryKey().defaultRandom(),
  disputeId: uuid('dispute_id').references(() => ccDisputes.id, { onDelete: 'cascade' }),
  direction: text('direction').notNull(),
  channel: text('channel').notNull(),
  subject: text('subject'),
  content: text('content'),
  attachments: jsonb('attachments').default([]),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow(),
  metadata: jsonb('metadata').default({}),
}, (table) => ({
  disputeIdx: index('idx_cc_dispute_corr_dispute').on(table.disputeId),
}));

// ── Documents ─────────────────────────────────────────────────
export const ccDocuments = pgTable('cc_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  docType: text('doc_type').notNull(),
  source: text('source').notNull(),
  filename: text('filename'),
  r2Key: text('r2_key'),
  contentText: text('content_text'),
  parsedData: jsonb('parsed_data'),
  linkedObligationId: uuid('linked_obligation_id').references(() => ccObligations.id),
  linkedAccountId: uuid('linked_account_id').references(() => ccAccounts.id),
  linkedDisputeId: uuid('linked_dispute_id').references(() => ccDisputes.id),
  processingStatus: text('processing_status').default('pending'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ── Recommendations ───────────────────────────────────────────
export const ccRecommendations = pgTable('cc_recommendations', {
  id: uuid('id').primaryKey().defaultRandom(),
  obligationId: uuid('obligation_id').references(() => ccObligations.id),
  disputeId: uuid('dispute_id').references(() => ccDisputes.id),
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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  actedOnAt: timestamp('acted_on_at', { withTimezone: true }),
}, (table) => ({
  priorityIdx: index('idx_cc_recommendations_priority').on(table.priority),
  statusIdx: index('idx_cc_recommendations_status').on(table.status),
}));

// ── Actions Log ───────────────────────────────────────────────
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
}, (table) => ({
  dateIdx: index('idx_cc_actions_log_date').on(table.executedAt),
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

// ── Sync Log ──────────────────────────────────────────────────
export const ccSyncLog = pgTable('cc_sync_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: text('source').notNull(),
  syncType: text('sync_type').notNull(),
  status: text('status').notNull(),
  recordsSynced: integer('records_synced').default(0),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
