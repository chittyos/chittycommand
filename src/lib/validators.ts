import { z } from 'zod';

// ── Accounts ──────────────────────────────────────────────────

export const createAccountSchema = z.object({
  source: z.string().min(1).max(100),
  source_id: z.string().max(255).optional(),
  account_name: z.string().min(1).max(255),
  account_type: z.enum(['checking', 'savings', 'credit_card', 'store_credit', 'mortgage', 'loan']),
  institution: z.string().min(1).max(255),
  current_balance: z.number().optional(),
  credit_limit: z.number().optional(),
  interest_rate: z.number().min(0).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateAccountSchema = z.object({
  current_balance: z.number().optional(),
  credit_limit: z.number().optional(),
  interest_rate: z.number().min(0).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  last_synced_at: z.string().datetime().optional(),
});

// ── Obligations ───────────────────────────────────────────────

export const createObligationSchema = z.object({
  account_id: z.string().uuid().optional(),
  category: z.string().min(1).max(100),
  subcategory: z.string().max(100).optional(),
  payee: z.string().min(1).max(255),
  amount_due: z.number().min(0).optional(),
  amount_minimum: z.number().min(0).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  recurrence: z.enum(['monthly', 'quarterly', 'annual', 'one_time']).optional(),
  recurrence_day: z.number().int().min(1).max(31).optional(),
  status: z.enum(['pending', 'paid', 'overdue', 'disputed', 'deferred']).optional(),
  auto_pay: z.boolean().optional(),
  negotiable: z.boolean().optional(),
  late_fee: z.number().min(0).optional(),
  grace_period_days: z.number().int().min(0).optional(),
  action_type: z.string().max(100).optional(),
  action_payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateObligationSchema = z.object({
  amount_due: z.number().min(0).optional(),
  amount_minimum: z.number().min(0).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['pending', 'paid', 'overdue', 'disputed', 'deferred']).optional(),
  auto_pay: z.boolean().optional(),
});

// ── Disputes ──────────────────────────────────────────────────

export const createDisputeSchema = z.object({
  title: z.string().min(1).max(500),
  counterparty: z.string().min(1).max(255),
  dispute_type: z.string().min(1).max(100),
  amount_claimed: z.number().min(0).optional(),
  amount_at_stake: z.number().min(0).optional(),
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  description: z.string().max(5000).optional(),
  next_action: z.string().max(1000).optional(),
  next_action_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  resolution_target: z.string().max(1000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateDisputeSchema = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  next_action: z.string().max(1000).optional(),
  next_action_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  description: z.string().max(5000).optional(),
});

export const createCorrespondenceSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  channel: z.enum(['email', 'phone', 'mail', 'portal', 'in_person']),
  subject: z.string().max(500).optional(),
  content: z.string().max(10000).optional(),
  attachments: z.array(z.record(z.string(), z.unknown())).optional(),
});

// ── Legal Deadlines ───────────────────────────────────────────

export const createLegalDeadlineSchema = z.object({
  case_ref: z.string().min(1).max(255),
  case_system: z.string().max(100).optional(),
  deadline_type: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  deadline_date: z.string().datetime(),
  status: z.enum(['upcoming', 'completed', 'missed']).optional(),
  urgency_score: z.number().int().min(0).max(100).optional(),
  evidence_db_ref: z.string().max(255).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateLegalDeadlineSchema = z.object({
  status: z.enum(['upcoming', 'completed', 'missed']).optional(),
  deadline_date: z.string().datetime().optional(),
  urgency_score: z.number().int().min(0).max(100).optional(),
});

// ── Recommendations ───────────────────────────────────────────

export const actOnRecommendationSchema = z.object({
  action_taken: z.string().min(1).max(1000).optional(),
});

// ── Bridge: Ledger ───────────────────────────────────────────

export const recordActionSchema = z.object({
  evidence_id: z.string().min(1).max(255),
  action: z.string().min(1).max(255),
  notes: z.string().max(2000).optional(),
});

// ── Bridge: Plaid ────────────────────────────────────────────

export const exchangeTokenSchema = z.object({
  public_token: z.string().min(1),
});
