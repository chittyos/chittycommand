import { getToken, logout } from './auth';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const AUTH_BASE = import.meta.env.VITE_AUTH_URL || '/auth';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    logout();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** Auth API (not behind /api prefix) */
export const authApi = {
  login: async (email: string, password: string) => {
    const res = await fetch(`${AUTH_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Login failed' }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    return res.json() as Promise<{ token: string; user_id: string; scopes: string[] }>;
  },
  me: async () => {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${AUTH_BASE}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Token invalid');
    return res.json() as Promise<{ user_id: string; scopes: string[] }>;
  },
};

// ── Email Connection Types ──────────────────────────────────

export interface EmailConnection {
  id: string;
  user_id: string;
  provider: 'gmail' | 'outlook' | 'forwarding';
  email_address: string;
  display_name: string | null;
  connect_ref: string | null;
  namespace: string | null;
  status: string;
  last_synced_at: string | null;
  error_message: string | null;
  config: Record<string, unknown>;
  created_at: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const api = {
  // Dashboard
  getDashboard: () => request<DashboardData>('/dashboard'),

  // Obligations
  getObligations: (params?: { status?: string; category?: string }) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return request<Obligation[]>(`/obligations${qs ? '?' + qs : ''}`);
  },
  getCalendar: (start: string, end: string) =>
    request<Obligation[]>(`/obligations/calendar?start=${start}&end=${end}`),
  createObligation: (data: Partial<Obligation>) =>
    request<Obligation>('/obligations', { method: 'POST', body: JSON.stringify(data) }),
  markPaid: (id: string) =>
    request<Obligation>(`/obligations/${id}/pay`, { method: 'POST' }),
  recalculateUrgency: () =>
    request<{ updated: number }>('/obligations/recalculate-urgency', { method: 'POST' }),

  // Accounts
  getAccounts: () => request<Account[]>('/accounts'),
  getAccount: (id: string) => request<Account & { transactions: Transaction[] }>(`/accounts/${id}`),

  // Disputes
  getDisputes: (status?: string) =>
    request<Dispute[]>(`/disputes${status ? '?status=' + status : ''}`),
  getDispute: (id: string) =>
    request<Dispute & { correspondence: Correspondence[]; documents: Document[] }>(`/disputes/${id}`),
  addCorrespondence: (disputeId: string, data: Partial<Correspondence>) =>
    request<Correspondence>(`/disputes/${disputeId}/correspondence`, { method: 'POST', body: JSON.stringify(data) }),

  // Legal
  getLegalDeadlines: () => request<LegalDeadline[]>('/legal'),

  // Recommendations
  getRecommendations: () => request<Recommendation[]>('/recommendations'),
  actOnRecommendation: (id: string, data: { action_taken: string }) =>
    request<Recommendation>(`/recommendations/${id}/act`, { method: 'POST', body: JSON.stringify(data) }),
  dismissRecommendation: (id: string) =>
    request<Recommendation>(`/recommendations/${id}/dismiss`, { method: 'POST' }),
  generateRecommendations: () =>
    request<{ obligations_scored: number; recommendations_created: number; overdue_flipped: number; cash_position: { total_cash: number; total_due_30d: number; surplus: number } }>('/recommendations/generate', { method: 'POST' }),

  // Documents
  uploadDocument: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE}/documents/upload`, { method: 'POST', body: formData });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  },
  getDocumentGaps: () => request<GapsResult>('/documents/gaps'),
  uploadBatch: async (files: File[]) => {
    const formData = new FormData();
    for (const file of files) formData.append('files', file);
    const res = await fetch(`${API_BASE}/documents/upload/batch`, { method: 'POST', body: formData });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json() as Promise<BatchUploadResult>;
  },

  // Sync
  getSyncStatus: () => request<SyncStatus[]>('/sync/status'),
  triggerSync: (source: string) =>
    request<{ message: string }>(`/sync/trigger/${source}`, { method: 'POST' }),

  // Bridge: Plaid
  getPlaidLinkToken: () =>
    request<{ link_token: string; expiration: string }>('/bridge/plaid/link-token', { method: 'POST' }),
  exchangePlaidToken: (publicToken: string) =>
    request<{ item_id: string; accounts_linked: number }>('/bridge/plaid/exchange-token', { method: 'POST', body: JSON.stringify({ public_token: publicToken }) }),
  syncPlaidTransactions: () =>
    request<{ items_checked: number; accounts: number; transactions_added: number }>('/bridge/plaid/sync-transactions', { method: 'POST' }),
  syncPlaidBalances: () =>
    request<{ items_checked: number; accounts_updated: number }>('/bridge/plaid/sync-balances', { method: 'POST' }),

  // Bridge: Cross-service
  getBridgeStatus: () =>
    request<{ services: ServiceStatus[]; healthy: number; total: number }>('/bridge/status'),
  syncFinanceAccounts: () =>
    request<{ fetched: number; created: number; updated: number }>('/bridge/finance/sync-accounts', { method: 'POST' }),
  syncFinanceTransactions: () =>
    request<{ accounts_checked: number; transactions_imported: number }>('/bridge/finance/sync-transactions', { method: 'POST' }),
  syncLedgerDocuments: () =>
    request<{ total: number; synced: number }>('/bridge/ledger/sync-documents', { method: 'POST' }),
  syncLedgerDisputes: () =>
    request<{ total: number; synced: number }>('/bridge/ledger/sync-disputes', { method: 'POST' }),

  // Cash Flow
  getCashflowProjections: () =>
    request<CashflowProjection[]>('/cashflow/projections'),
  generateCashflowProjections: () =>
    request<ProjectionResult>('/cashflow/generate', { method: 'POST' }),
  runCashflowScenario: (deferIds: string[]) =>
    request<ScenarioResult>('/cashflow/scenario', { method: 'POST', body: JSON.stringify({ defer_obligation_ids: deferIds }) }),

  // Sync: matching
  runTransactionMatch: () =>
    request<MatchResult>('/sync/match', { method: 'POST' }),

  // Action Queue
  getQueue: (limit?: number) =>
    request<QueueItem[]>(`/queue${limit ? '?limit=' + limit : ''}`),
  decideQueue: (id: string, decision: 'approved' | 'rejected' | 'deferred', sessionId?: string) =>
    request<{ decided: string; decision: string; next: { id: string; title: string } | null }>(
      `/queue/${id}/decide`,
      { method: 'POST', body: JSON.stringify({ decision, session_id: sessionId }) },
    ),
  getQueueStats: (sessionId?: string) =>
    request<QueueStats>(`/queue/stats${sessionId ? '?session_id=' + sessionId : ''}`),
  getQueueHistory: (limit?: number) =>
    request<DecisionHistory[]>(`/queue/history${limit ? '?limit=' + limit : ''}`),

  // Payment Plan
  getPaymentPlan: () =>
    request<PaymentPlan | null>('/payment-plan'),
  generatePaymentPlan: (options: { strategy: string; horizon_days?: number }) =>
    request<PaymentPlan & { id: string }>('/payment-plan/generate', { method: 'POST', body: JSON.stringify(options) }),
  simulatePaymentPlan: (options: { strategy: string; defer_ids?: string[]; pay_early_ids?: string[]; custom_amounts?: Record<string, number> }) =>
    request<PaymentPlan>('/payment-plan/simulate', { method: 'POST', body: JSON.stringify(options) }),
  getPlanSchedule: (id: string) =>
    request<PaymentPlan>(`/payment-plan/${id}/schedule`),
  activatePlan: (id: string) =>
    request<PaymentPlan>(`/payment-plan/${id}/activate`, { method: 'POST' }),

  // Revenue
  getRevenueSources: () =>
    request<{ sources: RevenueSource[]; summary: { count: number; total_monthly: number; weighted_monthly: number } }>('/revenue'),
  discoverRevenue: () =>
    request<{ sources_discovered: number; sources_updated: number; total_monthly_expected: number }>('/revenue/discover', { method: 'POST' }),
  addRevenueSource: (data: Partial<RevenueSource>) =>
    request<RevenueSource>('/revenue', { method: 'POST', body: JSON.stringify(data) }),
  updateRevenueSource: (id: string, data: Partial<RevenueSource>) =>
    request<RevenueSource>(`/revenue/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // Email Connections
  getEmailConnections: () =>
    request<{ connections: EmailConnection[]; namespace: string | null }>('/email-connections'),

  claimNamespace: (namespace: string) =>
    request<{ namespace: string }>('/email-connections/namespace', {
      method: 'POST', body: JSON.stringify({ namespace }),
    }),

  addForwardingConnection: (email_address: string, display_name?: string) =>
    request<EmailConnection>('/email-connections', {
      method: 'POST',
      body: JSON.stringify({ provider: 'forwarding', email_address, display_name }),
    }),

  initiateGmailOAuth: () =>
    request<{ auth_url: string }>('/email-connections/gmail', { method: 'POST' }),

  completeGmailOAuth: (data: { connect_ref: string; email_address: string; display_name?: string }) =>
    request<EmailConnection>('/email-connections/gmail/callback', {
      method: 'POST', body: JSON.stringify(data),
    }),

  disconnectEmail: (id: string) =>
    request<EmailConnection>(`/email-connections/${id}`, { method: 'DELETE' }),

  syncEmailConnection: (id: string) =>
    request<{ status: string }>(`/email-connections/${id}/sync`, { method: 'POST' }),

  chatStream: async function* (
    messages: ChatMessage[],
    context?: { page?: string; item_id?: string },
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const token = getToken();
    const res = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messages, context }),
      signal,
    });

    if (res.status === 401) {
      logout();
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';

    function* parseSSELines(lines: string[]) {
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error('[chatStream] gateway error in stream:', parsed.error);
            yield `\n\n[Error: ${parsed.error.message || 'AI service error'}]`;
            return;
          }
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          console.warn('[chatStream] malformed SSE chunk:', data.slice(0, 200));
        }
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        yield* parseSSELines(lines);
      }

      if (buffer.trim()) {
        yield* parseSSELines([buffer]);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new Error(`Connection to AI service lost. ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      reader.releaseLock();
    }
  },
};

// ── Types ─────────────────────────────────────────────────────

export interface DashboardData {
  summary: {
    total_cash: string;
    total_credit_owed: string;
    total_mortgage: string;
    total_loans: string;
    account_count: string;
  };
  obligations: {
    overdue_count: string;
    due_this_week: string;
    due_this_month: string;
    total_due_30d: string;
    urgent: Obligation[];
  };
  disputes: Dispute[];
  deadlines: LegalDeadline[];
  recommendations: Recommendation[];
}

export interface Account {
  id: string;
  source: string;
  account_name: string;
  account_type: string;
  institution: string;
  current_balance: string | null;
  credit_limit: string | null;
  interest_rate: string | null;
  last_synced_at: string | null;
}

export interface Obligation {
  id: string;
  account_id: string | null;
  category: string;
  subcategory: string | null;
  payee: string;
  amount_due: string | null;
  amount_minimum: string | null;
  due_date: string;
  recurrence: string | null;
  status: string;
  auto_pay: boolean;
  negotiable: boolean;
  urgency_score: number | null;
  action_type: string | null;
}

export interface Transaction {
  id: string;
  amount: string;
  direction: string;
  description: string;
  tx_date: string;
}

export interface Dispute {
  id: string;
  title: string;
  counterparty: string;
  dispute_type: string;
  amount_claimed: string | null;
  amount_at_stake: string | null;
  status: string;
  priority: number;
  description: string | null;
  next_action: string | null;
  next_action_date: string | null;
}

export interface Correspondence {
  id: string;
  direction: string;
  channel: string;
  subject: string | null;
  content: string | null;
  sent_at: string;
}

export interface LegalDeadline {
  id: string;
  case_ref: string;
  title: string;
  deadline_date: string;
  deadline_type: string;
  status: string;
  urgency_score: number | null;
}

export interface Recommendation {
  id: string;
  rec_type: string;
  priority: number;
  title: string;
  reasoning: string;
  action_type: string | null;
  obligation_payee?: string;
  dispute_title?: string;
}

export interface SyncStatus {
  source: string;
  status: string;
  records_synced: number;
  started_at: string;
  completed_at: string | null;
}

export interface Document {
  id: string;
  doc_type: string;
  filename: string | null;
  processing_status: string;
  created_at: string;
}

export interface BatchUploadResult {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  results: { filename: string; status: 'ok' | 'skipped' | 'error'; error?: string }[];
}

export interface DocumentGap {
  payee: string;
  category: string;
  recurrence: string | null;
  has_document: boolean;
  last_upload: string | null;
}

export interface GapsResult {
  total_payees: number;
  covered: number;
  missing: number;
  gaps: DocumentGap[];
}

export interface ServiceStatus {
  name: string;
  status: string;
  code?: number;
  error?: string;
}

export interface CashflowProjection {
  projection_date: string;
  projected_inflow: string;
  projected_outflow: string;
  projected_balance: string;
  obligations: string; // JSON string array
  confidence: string;
}

export interface ProjectionResult {
  starting_balance: number;
  ending_balance: number;
  total_inflows: number;
  total_outflows: number;
  days_projected: number;
  lowest_balance: number;
  lowest_balance_date: string;
}

export interface ScenarioResult {
  starting_balance: number;
  total_due_without_deferrals: number;
  total_deferred: number;
  projected_balance: number;
  original_balance: number;
  savings_from_deferral: number;
  deferred_items: { payee: string; amount: string; due_date: string }[];
}

export interface MatchResult {
  transactions_scanned: number;
  matches_found: number;
  obligations_marked_paid: number;
  matches: { transaction_id: string; obligation_id: string; payee: string; amount: number; confidence: number }[];
}

// ── Queue Types ──────────────────────────────────────────────

export interface QueueItem {
  id: string;
  rec_type: string;
  priority: number;
  title: string;
  reasoning: string;
  action_type: string | null;
  estimated_savings: string | null;
  obligation_id: string | null;
  dispute_id: string | null;
  confidence: number | null;
  live_confidence: number;
  suggested_amount: string | null;
  suggested_account_id: string | null;
  escalation_risk: string | null;
  scenario_impact: unknown;
  obligation_payee: string | null;
  obligation_amount: string | null;
  obligation_due_date: string | null;
  obligation_category: string | null;
  obligation_status: string | null;
  obligation_late_fee: string | null;
  obligation_grace_days: number | null;
  obligation_auto_pay: boolean | null;
  dispute_title: string | null;
  dispute_counterparty: string | null;
  dispute_amount: string | null;
}

export interface QueueStats {
  approved: number;
  rejected: number;
  deferred: number;
  modified: number;
  total: number;
  savings: number;
}

export interface DecisionHistory {
  id: string;
  decision: string;
  original_action: string | null;
  modified_action: string | null;
  outcome_status: string | null;
  created_at: string;
  title: string | null;
  rec_type: string | null;
  estimated_savings: string | null;
  obligation_payee: string | null;
}

// ── Payment Plan Types ──────────────────────────────────────

export interface ScheduleEntry {
  date: string;
  obligation_id: string;
  payee: string;
  amount: number;
  account_id: string | null;
  action: string;
  balance_after: number;
  grace_used: boolean;
  escalation_risk: string | null;
}

export interface PlanWarning {
  date: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface PaymentPlan {
  plan_type: string;
  horizon_days: number;
  starting_balance: number;
  ending_balance: number;
  lowest_balance: number;
  lowest_balance_date: string;
  total_inflows: number;
  total_outflows: number;
  total_late_fees_avoided: number;
  total_late_fees_risked: number;
  schedule: ScheduleEntry[] | string;
  warnings: PlanWarning[] | string;
  revenue_summary?: { source: string; monthly: number; confidence: number }[];
  status?: string;
  created_at?: string;
}

// ── Revenue Types ───────────────────────────────────────────

export interface RevenueSource {
  id: string;
  source: string;
  source_id: string | null;
  description: string;
  amount: string;
  recurrence: string | null;
  recurrence_day: number | null;
  next_expected_date: string | null;
  confidence: string;
  verified_by: string | null;
  contract_ref: string | null;
  account_id: string | null;
  status: string;
  account_name?: string;
  institution?: string;
}
