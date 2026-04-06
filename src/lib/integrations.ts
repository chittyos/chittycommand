import type { Env } from '../index';

/**
 * Service integration clients for the ChittyOS ecosystem.
 * Each client is a thin wrapper that calls the upstream service API.
 * All calls are fire-and-forget safe — failures are logged but don't break the caller.
 */

/** Distinguishes "no data" from "service error" for array-returning methods */
export interface ServiceArrayResult<T> {
  data: T[];
  error?: string;
  status?: number;
}

// ── ChittyLedger ─────────────────────────────────────────────
// Audit trail: entries, chain verification, custody queries
// NOTE: Evidence/case operations live on ChittyEvidence, not ChittyLedger.

export interface LedgerEntryPayload {
  entityType: 'transaction' | 'evidence' | 'custody' | 'audit';
  entityId?: string;
  action: string;
  actor?: string;
  actorType?: 'user' | 'service' | 'system';
  metadata?: Record<string, unknown>;
  status?: 'pending' | 'confirmed' | 'rejected';
}

export function ledgerClient(env: Env) {
  const baseUrl = env.CHITTYLEDGER_URL;
  if (!baseUrl) return null;

  const headers: Record<string, string> = {
    'X-Source-Service': 'chittycommand',
  };
  if (env.CHITTYLEDGER_TOKEN) {
    headers['Authorization'] = `Bearer ${env.CHITTYLEDGER_TOKEN}`;
  }

  async function get<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, { headers });
      if (!res.ok) { const body = await res.text().catch(() => ''); console.error(`[ledger] GET ${path} failed: ${res.status} — ${body.slice(0, 500)}`); return null; }
      return await res.json() as T;
    } catch (err) { console.error(`[ledger] GET ${path} error:`, err); return null; }
  }

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) { const errBody = await res.text().catch(() => ''); console.error(`[ledger] POST ${path} failed: ${res.status} — ${errBody.slice(0, 500)}`); return null; }
      return await res.json() as T;
    } catch (err) { console.error(`[ledger] POST ${path} error:`, err); return null; }
  }

  return {
    /** Add an audit/custody/evidence entry to the ledger */
    addEntry: (entry: LedgerEntryPayload) =>
      post<{ id: string; sequenceNumber: number; hash: string }>('/entries', entry),

    /** Search ledger entries — returns { data, error? } to distinguish empty from failure */
    searchEntries: async (params: { entityType?: string; entityId?: string; actor?: string; status?: string; limit?: number }): Promise<ServiceArrayResult<Record<string, unknown>>> => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)] as [string, string])
      ).toString();
      const result = await get<Record<string, unknown>[]>(`/entries${qs ? `?${qs}` : ''}`);
      if (result === null) return { data: [], error: 'ChittyLedger unreachable or returned error' };
      return { data: result };
    },

    /** Get chain of custody for an entity — returns { data, error? } to distinguish empty from failure */
    getChainOfCustody: async (entityId: string): Promise<ServiceArrayResult<Record<string, unknown>>> => {
      const result = await get<Record<string, unknown>[]>(`/custody/${encodeURIComponent(entityId)}`);
      if (result === null) return { data: [], error: 'ChittyLedger unreachable or returned error' };
      return { data: result };
    },

    /** Verify ledger chain integrity */
    verifyChain: () => get<{ valid: boolean; errors: string[] }>('/verify'),

    /** Get ledger statistics */
    getStatistics: () => get<Record<string, unknown>>('/statistics'),
  };
}

// ── ChittyEvidence ──────────────────────────────────────────
// Evidence platform: documents, facts, entities, legal architecture

export interface EvidenceFact {
  id: string;
  fact_text: string;
  fact_date?: string;
  fact_type?: string;
  confidence?: number;
  source_quote?: string;
  verification_status?: string;
  document_id?: string;
  fact_number?: number;
  case_id?: string;
  // ChittyEvidence returns entity_type (not type) and amount_value (not value)
  // @canon: chittycanon://gov/governance#core-types — entity_type is canonical P/L/T/E/A
  entities?: Array<{ id: string; name: string; entity_type: string; role: string; confidence: number }>;
  amounts?: Array<{ id: string; fact_id: string; amount_value: number; currency: string; description: string; confidence: number }>;
}

export interface EvidenceDocument {
  id: string;
  file_name: string;
  document_type?: string;
  processing_status: string;
  created_at: string;
  content_hash?: string;
}

export function evidenceClient(env: Env) {
  const baseUrl = env.CHITTYEVIDENCE_URL;
  if (!baseUrl) return null;

  const headers: Record<string, string> = { 'X-Source-Service': 'chittycommand' };
  if (env.CHITTYEVIDENCE_TOKEN) {
    headers['Authorization'] = `Bearer ${env.CHITTYEVIDENCE_TOKEN}`;
  }

  async function get<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, { headers });
      if (!res.ok) { const body = await res.text().catch(() => ''); console.error(`[evidence] GET ${path} failed: ${res.status} — ${body.slice(0, 500)}`); return null; }
      return await res.json() as T;
    } catch (err) {
      console.error(`[evidence] GET ${path} error:`, err);
      return null;
    }
  }

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const errBody = await res.text().catch(() => ''); console.error(`[evidence] POST ${path} failed: ${res.status} — ${errBody.slice(0, 500)}`); return null; }
      return await res.json() as T;
    } catch (err) {
      console.error(`[evidence] POST ${path} error:`, err);
      return null;
    }
  }

  return {
    /** Submit a document to the evidence pipeline */
    submitDocument: (payload: { filename: string; fileType: string; fileSize?: string; description?: string; evidenceTier?: string; caseId?: string }) =>
      post<{ id: string; submission_id?: string }>('/collect', {
        file_name: payload.filename,
        document_type: payload.fileType,
        file_size: payload.fileSize,
        description: payload.description,
        evidence_tier: payload.evidenceTier,
        case_id: payload.caseId,
      }),

    /** Record a chain-of-custody event on a document */
    addCustodyEntry: (documentId: string, entry: { action: string; performedBy: string; location?: string; notes?: string }) =>
      post<Record<string, unknown>>(`/legal/documents/${encodeURIComponent(documentId)}/custody`, entry),

    /** Get enriched facts for a case (facts + entities + amounts) */
    getEnrichedFacts: (caseId: string) =>
      get<EvidenceFact[]>(`/facts/cases/${encodeURIComponent(caseId)}/enriched`),

    /** Get statement of facts for a case */
    getStatementOfFacts: (caseId: string) =>
      get<Record<string, unknown>[]>(`/legal/cases/${encodeURIComponent(caseId)}/facts`),

    /** Get facts by date range */
    getFactsByDateRange: (caseId: string, startDate: string, endDate: string) =>
      get<EvidenceFact[]>(`/facts/cases/${encodeURIComponent(caseId)}/date-range?startDate=${startDate}&endDate=${endDate}`),

    /** Get facts by type */
    getFactsByType: (caseId: string, factType: string) =>
      get<EvidenceFact[]>(`/facts/cases/${encodeURIComponent(caseId)}/type/${encodeURIComponent(factType)}`),

    /** Get pending facts awaiting review */
    getPendingFacts: (caseId?: string, limit = 50) =>
      get<EvidenceFact[]>(`/facts/pending?${new URLSearchParams({ ...(caseId ? { caseId } : {}), limit: String(limit) })}`),

    /** Search documents (POST /search) */
    searchDocuments: (query: string) =>
      post<EvidenceDocument[]>('/search', { query }),

    /** Get documents by case ID */
    getDocumentsByCase: (caseId: string) =>
      get<EvidenceDocument[]>(`/legal/cases/${encodeURIComponent(caseId)}/documents`),

    /** Get entities — entity_type is canonical P/L/T/E/A @canon: chittycanon://gov/governance#core-types */
    getEntities: () =>
      get<Array<{ id: string; name: string; entity_type: string }>>('/entities'),

    /** Get fact conflicts for a case (via statement of facts has_conflict flag) */
    getContradictions: (caseId: string) =>
      get<Record<string, unknown>[]>(`/legal/cases/${encodeURIComponent(caseId)}/facts?conflicts_only=true`),
  };
}

// ── ChittyFinance ────────────────────────────────────────────
// Mercury, Wave, Stripe transaction ingestion

export interface FinanceAccount {
  id: string;
  name: string;
  type: string;
  institution: string;
  balance: number;
  currency: string;
}

export interface FinanceTransaction {
  id: string;
  account_id: string;
  amount: number;
  direction: 'inflow' | 'outflow';
  description: string;
  date: string;
  category?: string;
  counterparty?: string;
}

export function financeClient(env: Env) {
  const baseUrl = env.CHITTYFINANCE_URL;
  if (!baseUrl) return null;

  async function get<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { 'X-Source-Service': 'chittycommand' },
      });
      if (!res.ok) { const body = await res.text().catch(() => ''); console.error(`[finance] GET ${path} failed: ${res.status} — ${body.slice(0, 500)}`); return null; }
      return await res.json() as T;
    } catch (err) {
      console.error(`[finance] ${path} error:`, err);
      return null;
    }
  }

  return {
    /** Fetch all accounts from Mercury/Wave/Stripe */
    getAccounts: () => get<FinanceAccount[]>('/api/accounts'),

    /** Fetch recent transactions for an account */
    getTransactions: (accountId: string, since?: string) => {
      const qs = since ? `?${new URLSearchParams({ since }).toString()}` : '';
      return get<FinanceTransaction[]>(`/api/accounts/${encodeURIComponent(accountId)}/transactions${qs}`);
    },

    /** Fetch aggregate summary */
    getSummary: () => get<{ total_cash: number; total_owed: number; net: number }>('/api/summary'),
  };
}

// ── ChittyCharge / ChittyTransact ────────────────────────────
// Payment execution: holds, captures, payouts

export interface ChargeHoldPayload {
  amount: number;
  currency?: string;
  description: string;
  metadata?: Record<string, string>;
}

export interface ChargeResult {
  id: string;
  status: string;
  amount: number;
  stripe_payment_intent_id?: string;
}

export function chargeClient(env: Env) {
  const baseUrl = env.CHITTYCHARGE_URL;
  if (!baseUrl) return null;

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`[charge] POST ${path} failed: ${res.status} — ${errBody.slice(0, 500)}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[charge] ${path} error:`, err);
      return null;
    }
  }

  return {
    /** Create an authorization hold */
    createHold: (payload: ChargeHoldPayload) =>
      post<ChargeResult>('/api/holds', payload),

    /** Capture a hold (full or partial) */
    captureHold: (holdId: string, amount?: number) =>
      post<ChargeResult>(`/api/holds/${holdId}/capture`, { amount }),

    /** Release a hold */
    releaseHold: (holdId: string) =>
      post<ChargeResult>(`/api/holds/${holdId}/release`, {}),
  };
}

// ── Plaid ────────────────────────────────────────────────────
// Bank account linking and transaction sync via Plaid API

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  balances: {
    available: number | null;
    current: number | null;
    iso_currency_code: string | null;
  };
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name: string | null;
  category: string[] | null;
  pending: boolean;
}

export function plaidClient(env: Env) {
  const clientId = env.PLAID_CLIENT_ID;
  const secret = env.PLAID_SECRET;
  const plaidEnv = env.PLAID_ENV || 'sandbox';
  if (!clientId || !secret) return null;

  const baseUrl = `https://${plaidEnv}.plaid.com`;

  async function post<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, secret, ...body }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as Record<string, unknown>;
        console.error(`[plaid] ${path} failed: ${res.status}`, err);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[plaid] ${path} error:`, err);
      return null;
    }
  }

  return {
    /** Create a link token for the frontend to initialize Plaid Link */
    createLinkToken: (userId: string) =>
      post<{ link_token: string; expiration: string }>('/link/token/create', {
        user: { client_user_id: userId },
        client_name: 'ChittyCommand',
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
      }),

    /** Exchange a public_token from Plaid Link for a persistent access_token */
    exchangePublicToken: (publicToken: string) =>
      post<{ access_token: string; item_id: string }>('/item/public_token/exchange', {
        public_token: publicToken,
      }),

    /** Fetch accounts for a linked item */
    getAccounts: (accessToken: string) =>
      post<{ accounts: PlaidAccount[] }>('/accounts/get', {
        access_token: accessToken,
      }),

    /** Sync transactions incrementally using cursor-based pagination */
    syncTransactions: (accessToken: string, cursor?: string) =>
      post<{
        added: PlaidTransaction[];
        modified: PlaidTransaction[];
        removed: { transaction_id: string }[];
        next_cursor: string;
        has_more: boolean;
      }>('/transactions/sync', {
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
      }),

    /** Get current balances */
    getBalances: (accessToken: string) =>
      post<{ accounts: PlaidAccount[] }>('/accounts/balance/get', {
        access_token: accessToken,
      }),
  };
}

// ── ChittyConnect ────────────────────────────────────────────
// Credential management and service discovery

export function connectClient(env: Env) {
  const baseUrl = env.CHITTYCONNECT_URL;
  if (!baseUrl) return null;

  async function connectPost<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Source-Service': 'chittycommand',
      };
      if (env.CHITTY_CONNECT_TOKEN) {
        headers['Authorization'] = `Bearer ${env.CHITTY_CONNECT_TOKEN}`;
      }
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`[connect] POST ${path} failed: ${res.status} — ${errBody.slice(0, 500)}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[connect] POST ${path} error:`, err);
      return null;
    }
  }

  return {
    /** Discover a service URL by name */
    discover: async (serviceName: string): Promise<string | null> => {
      const key = `connect:discover:${encodeURIComponent(serviceName)}`;
      // KV cache (5 minutes)
      try {
        const cached = await env.COMMAND_KV.get(key);
        if (cached) {
          try {
            const obj = JSON.parse(cached) as { url?: string };
            if (obj?.url) return obj.url;
          } catch (err) { console.warn('[connect/discover] KV cache parse failed:', err); }
        }
      } catch (err) { console.warn('[connect/discover] KV read failed:', err); }

      try {
        const res = await fetch(`${baseUrl}/api/discover/${encodeURIComponent(serviceName)}`, {
          headers: { 'X-Source-Service': 'chittycommand' },
        });
        if (!res.ok) { const body = await res.text().catch(() => ''); console.error(`[connect/discover] ${serviceName} failed: ${res.status} — ${body.slice(0, 500)}`); return null; }
        const data = await res.json() as { url: string };
        // Store in KV with TTL
        try { await env.COMMAND_KV.put(key, JSON.stringify({ url: data.url }), { expirationTtl: 300 }); } catch (err) { console.warn('[connect/discover] KV write failed:', err); }
        return data.url;
      } catch (err) { console.error('[connect/discover] fetch error:', err); return null; }
    },

    // ── Prompt Registry (ContextConsciousness) ─────────────────
    /** Resolve a prompt: compose base + layers, apply env gating */
    resolvePrompt: (promptId: string, environment: string, variables?: Record<string, string>, additionalLayers?: string[]) =>
      connectPost<PromptResolveResponse>('/api/v1/context/prompts/resolve', {
        promptId,
        environment,
        variables,
        additionalLayers,
        consumerService: 'chittycommand',
      }),

    /** Execute a prompt: resolve + dispatch to agent, return AI result */
    executePrompt: (promptId: string, environment: string, input: Record<string, unknown>, opts?: { additionalLayers?: string[] }) =>
      connectPost<PromptExecuteResponse>('/api/v1/context/prompts/execute', {
        promptId,
        environment,
        input,
        additionalLayers: opts?.additionalLayers,
        consumerService: 'chittycommand',
      }),
  };
}

export interface PromptResolveResponse {
  systemPrompt: string;
  aiEnabled: boolean;
  version: number;
  resolvedLayers: string[];
  fallbackMode: string | null;
}

export interface PromptExecuteResponse {
  result: string;
  promptVersion: number;
  resolvedLayers: string[];
  executedBy: string;
  latencyMs: number;
  executionId: number;
  aiEnabled: boolean;
}

// ── Mercury ─────────────────────────────────────────────────
// Direct Mercury API for multi-entity banking

export interface MercuryAccount {
  id: string;
  name: string;
  status: string;
  type: string;
  routingNumber: string;
  accountNumber: string;
  currentBalance: number;
  availableBalance: number;
  kind: string;
}

export interface MercuryTransaction {
  id: string;
  amount: number;
  bankDescription: string | null;
  counterpartyId: string;
  counterpartyName: string;
  counterpartyNickname: string | null;
  createdAt: string;
  dashboardLink: string;
  details: Record<string, unknown> | null;
  estimatedDeliveryDate: string;
  externalMemo: string | null;
  kind: string;
  note: string | null;
  postedAt: string | null;
  status: string;
}

export function mercuryClient(token: string) {
  const baseUrl = 'https://api.mercury.com/api/v1';

  async function get<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[mercury] GET ${path} failed: ${res.status} — ${body.slice(0, 500)}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[mercury] ${path} error:`, err);
      return null;
    }
  }

  return {
    getAccounts: () => get<{ accounts: MercuryAccount[] }>('/accounts'),

    getTransactions: (accountId: string, params?: { offset?: number; limit?: number; start?: string; end?: string }) => {
      const qs = params ? '?' + new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)] as [string, string])
      ).toString() : '';
      return get<{ transactions: MercuryTransaction[] }>(`/account/${accountId}/transactions${qs}`);
    },
  };
}

// ── ChittyBooks ─────────────────────────────────────────────
// Bookkeeping and accounting: push executed actions as ledger entries

export function booksClient(env: Env) {
  const baseUrl = env.CHITTYBOOKS_URL;
  if (!baseUrl) return null;

  return {
    getSummary: async (): Promise<Record<string, unknown> | null> => {
      try {
        const res = await fetch(`${baseUrl}/api/summary`, {
          headers: { 'X-Source-Service': 'chittycommand' },
        });
        if (!res.ok) { const body = await res.text().catch(() => ''); console.error(`[books] GET /api/summary failed: ${res.status} — ${body.slice(0, 500)}`); return null; }
        return await res.json() as Record<string, unknown>;
      } catch (err) {
        console.error('[books] summary error:', err);
        return null;
      }
    },

    recordTransaction: async (payload: { type: 'income' | 'expense'; description: string; amount: number }): Promise<Record<string, unknown> | null> => {
      try {
        const res = await fetch(`${baseUrl}/api/transaction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          console.error(`[books] POST /api/transaction failed: ${res.status} — ${errBody.slice(0, 500)}`);
          return null;
        }
        return await res.json() as Record<string, unknown>;
      } catch (err) {
        console.error('[books] record-transaction error:', err);
        return null;
      }
    },
  };
}

// ── ChittyAssets ────────────────────────────────────────────
// Asset management: property data, ownership proof, evidence ledger

export function assetsClient(env: Env) {
  const baseUrl = env.CHITTYASSETS_URL;
  if (!baseUrl) return null;

  async function get<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { 'X-Source-Service': 'chittycommand' },
      });
      if (!res.ok) { const body = await res.text().catch(() => ''); console.error(`[assets] GET ${path} failed: ${res.status} — ${body.slice(0, 500)}`); return null; }
      return await res.json() as T;
    } catch (err) {
      console.error(`[assets] ${path} error:`, err);
      return null;
    }
  }

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`[assets] POST ${path} failed: ${res.status} — ${errBody.slice(0, 500)}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[assets] ${path} error:`, err);
      return null;
    }
  }

  return {
    getAssets: () => get<Record<string, unknown>[]>('/api/assets'),
    getAsset: (assetId: string) => get<Record<string, unknown>>(`/api/assets/${encodeURIComponent(assetId)}`),
    submitEvidence: (payload: { evidenceType: string; data: Record<string, unknown>; metadata?: Record<string, unknown> }) =>
      post<{ chittyId: string; status: string; trustScore: number }>('/api/evidence-ledger/submit', payload),
    getServiceStatus: () => get<Record<string, unknown>[]>('/api/chitty/services'),
  };
}

// ── ChittyScrape ──────────────────────────────────────────────
// Browser automation for portals without APIs

export function scrapeClient(env: Env) {
  const baseUrl = env.CHITTYSCRAPE_URL;
  if (!baseUrl) return null;

  async function post<T>(path: string, body: unknown, token: string): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`[scrape] POST ${path} failed: ${res.status} — ${errBody.slice(0, 500)}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[scrape] ${path} error:`, err);
      return null;
    }
  }

  return {
    scrapeCourtDocket: (caseNumber: string, token: string) =>
      post<{ success: boolean; data?: any; error?: string }>('/api/scrape/court-docket', { caseNumber }, token),

    scrapeCookCountyTax: (pin: string, token: string) =>
      post<{ success: boolean; data?: any; error?: string }>('/api/scrape/cook-county-tax', { pin }, token),

    scrapeMrCooper: (property: string, token: string) =>
      post<{ success: boolean; data?: any; error?: string }>('/api/scrape/mr-cooper', { property }, token),
  };
}

// ── ChittyRouter ──────────────────────────────────────────────
// Unified ingestion gateway: routes scrape, email, and compliance requests

export interface RouterScrapeResponse {
  success: boolean;
  target: string;
  scraped_at?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export function routerClient(env: Env) {
  const baseUrl = env.CHITTYROUTER_URL;
  if (!baseUrl) return null;

  // Build auth headers — use scrape service token for router auth
  async function authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'X-Source-Service': 'chittycommand',
    };
    const token = await env.COMMAND_KV.get('scrape:service_token');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      console.warn('[router] No scrape:service_token in KV — requests will be unauthenticated');
    }
    return headers;
  }

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const headers = await authHeaders();
      headers['Content-Type'] = 'application/json';
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`[router] POST ${path} failed: ${res.status} — ${errBody.slice(0, 500)}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[router] ${path} error:`, err);
      return null;
    }
  }

  async function get<T>(path: string): Promise<T | null> {
    try {
      const headers = await authHeaders();
      const res = await fetch(`${baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[router] GET ${path} failed: ${res.status} — ${body.slice(0, 500)}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[router] ${path} error:`, err);
      return null;
    }
  }

  // ── chittyagent-scrape helpers (prefer dedicated agent, fall back to router) ──
  const scrapeAgentUrl = env.CHITTYAGENT_SCRAPE_URL;

  async function scrapePost<T>(path: string, body: unknown): Promise<T | null> {
    if (scrapeAgentUrl) {
      try {
        const headers = await authHeaders();
        headers['Content-Type'] = 'application/json';
        const res = await fetch(`${scrapeAgentUrl}${path}`, {
          method: 'POST', headers, body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        if (res.ok) return await res.json() as T;
        console.warn(`[scrape-agent] POST ${path} failed: ${res.status}, falling back to router`);
      } catch (err) {
        console.warn(`[scrape-agent] POST ${path} error, falling back to router:`, err);
      }
    }
    // Fallback: route through ChittyRouter (legacy path)
    return post<T>(`/agents/scrape${path.replace('/api/v1', '')}`, body);
  }

  async function scrapeGet<T>(path: string): Promise<T | null> {
    if (scrapeAgentUrl) {
      try {
        const headers = await authHeaders();
        const res = await fetch(`${scrapeAgentUrl}${path}`, {
          headers, signal: AbortSignal.timeout(10000),
        });
        if (res.ok) return await res.json() as T;
        console.warn(`[scrape-agent] GET ${path} failed: ${res.status}, falling back to router`);
      } catch (err) {
        console.warn(`[scrape-agent] GET ${path} error, falling back to router:`, err);
      }
    }
    return get<T>(`/agents/scrape${path.replace('/api/v1', '')}`);
  }

  return {
    scrapePortal: (target: string, params?: Record<string, unknown>) =>
      post<RouterScrapeResponse>('/route/scrape', { target, params }),

    getUrgentItems: () =>
      get<{ items: Record<string, unknown>[] }>('/email/urgent'),

    getEmailStatus: () =>
      get<Record<string, unknown>>('/email/status'),

    /** Classify a dispute via ChittyRouter TriageAgent
     * @canon chittycanon://gov/governance#core-types — disputes are Event (E) */
    classifyDispute: (payload: {
      entity_id: string;
      entity_type: 'event'; // @canon: chittycanon://gov/governance#core-types — disputes are Event (E)
      title: string;
      dispute_type: string;
      amount?: number;
      description?: string;
    }) =>
      post<{
        severity: number;
        priority: number;
        labels: string[];
        reasoning?: string;
      }>('/agents/triage/classify', payload),

    // ── ScrapeAgent proxy methods (chittyagent-scrape) ─────────
    /** Enqueue a scrape job on chittyagent-scrape */
    enqueueScrapeJob: (jobType: string, target: Record<string, unknown>, opts?: { chittyId?: string; maxAttempts?: number; cronSource?: string; jobId?: string }) =>
      scrapePost<{ id: string; status: string }>('/api/v1/enqueue', { job_type: jobType, target, chitty_id: opts?.chittyId, max_attempts: opts?.maxAttempts, cron_source: opts?.cronSource }),

    /** Get scrape job queue status */
    getScrapeJobStatus: (_jobId: string) =>
      scrapeGet<ScrapeJobResponse>('/api/v1/jobs'),

    /** List scrape jobs */
    listScrapeJobs: (filters?: { status?: string; jobType?: string; limit?: number; chittyId?: string; offset?: number }) => {
      const params = new URLSearchParams();
      if (filters?.limit) params.set('limit', String(filters.limit));
      const qs = params.toString();
      return scrapeGet<{ jobs: ScrapeJobResponse[]; total: number }>(`/api/v1/jobs${qs ? `?${qs}` : ''}`);
    },

    /** Retry not supported on task-based queue — re-enqueue instead */
    retryScrapeJob: (_jobId: string) =>
      Promise.resolve(null as { status: string } | null),

    /** Dead letters not directly exposed — query failed tasks */
    getScrapeDeadLetters: (_limit?: number) =>
      Promise.resolve(null as { jobs: ScrapeJobResponse[] } | null),

    /** Trigger queue processing on chittyagent-scrape */
    processScrapeQueue: () =>
      scrapePost<{ processed: number; succeeded: number; failed: number }>('/api/v1/process', {}),

    /** Get chittyagent-scrape health status */
    getScrapeStatus: () =>
      scrapeGet<Record<string, unknown>>('/health'),
  };
}

export interface ScrapeJobResponse {
  id: string;
  jobType: string;
  target: Record<string, unknown>;
  status: string;
  attempt: number;
  maxAttempts: number;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// ── Notion (write path) ───────────────────────────────────────
// Reading Notion is handled by syncNotionTasks() in cron.ts.
// This client covers the write path: creating task pages from disputes.

export interface NotionTaskPayload {
  title: string;
  description?: string;
  task_type: string;
  priority: number;
  due_date?: string;
  source: string;
  tags?: string[];
}

export interface NotionPageResult {
  page_id: string;
  url: string;
}

export function notionClient(env: Env) {
  if (!env.COMMAND_KV) return null;

  async function resolveCredentials(): Promise<{ token: string; dbId: string } | null> {
    const [token, dbId] = await Promise.all([
      env.COMMAND_KV.get('notion:task_agent_token'),
      env.COMMAND_KV.get('notion:dispute_database_id'),
    ]);
    if (!token || !dbId) return null;
    return { token, dbId };
  }

  return {
    createTask: async (payload: NotionTaskPayload): Promise<NotionPageResult | null> => {
      try {
        const creds = await resolveCredentials();
        if (!creds) {
          console.warn('[notion] Missing notion:task_agent_token or notion:dispute_database_id in KV');
          return null;
        }

        const properties: Record<string, unknown> = {
          'Title': {
            title: [{ type: 'text', text: { content: payload.title.slice(0, 2000) } }],
          },
          'Type': {
            select: { name: payload.task_type },
          },
          'Priority 1': {
            number: payload.priority,
          },
          'Source': {
            select: { name: payload.source },
          },
        };

        if (payload.description) {
          properties['Description'] = {
            rich_text: [{ type: 'text', text: { content: payload.description.slice(0, 2000) } }],
          };
        }

        if (payload.due_date) {
          properties['Due Date'] = { date: { start: payload.due_date } };
        }

        if (payload.tags?.length) {
          properties['Tags'] = {
            multi_select: payload.tags.map((t) => ({ name: t })),
          };
        }

        const res = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${creds.token}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            parent: { database_id: creds.dbId },
            properties,
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          console.error(`[notion] createTask failed: ${res.status} ${errBody}`);
          return null;
        }

        const page = await res.json() as { id: string; url: string };
        return { page_id: page.id, url: page.url };
      } catch (err) {
        console.error('[notion] createTask error:', err);
        return null;
      }
    },
  };
}

// ── ChittyGov ─────────────────────────────────────────────
// Corporate governance: compliance calendar, filing deadlines, monitors

export interface ComplianceFiling {
  filingId: string;
  entityId: number;
  entityName?: string;
  filingType: string;
  jurisdiction: string;
  dueDate: string;
  status: string;
  daysUntil: number;
  fee?: string;
  latePenalty?: string;
  authorityUrl?: string;
}

export interface ComplianceMonitor {
  monitorId: string;
  entityId?: number;
  entityName?: string;
  monitorType: string;
  scraperId?: string;
  scrapeInput?: Record<string, unknown>;
  checkFrequency: string;
  lastCheckedAt?: string;
  status: string;
}

export function govClient(env: Env) {
  const govUrl = env.CHITTYGOV_URL;
  if (!govUrl) return null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Source-Service': 'chittycommand',
  };
  if (env.CHITTYGOV_TOKEN) {
    headers['Authorization'] = `Bearer ${env.CHITTYGOV_TOKEN}`;
  }

  return {
    getComplianceCalendar: async (params?: { status?: string; days?: number; entityId?: string }): Promise<{ filings: ComplianceFiling[]; total: number } | null> => {
      try {
        const qs = new URLSearchParams();
        if (params?.status) qs.set('status', params.status);
        if (params?.days) qs.set('days', String(params.days));
        if (params?.entityId) qs.set('entity_id', params.entityId);
        const url = `${govUrl}/api/compliance/calendar${qs.toString() ? `?${qs}` : ''}`;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error(`[gov] getComplianceCalendar failed: ${res.status} — ${body.slice(0, 500)}`);
          return null;
        }
        return await res.json() as { filings: ComplianceFiling[]; total: number };
      } catch (err) {
        console.error('[gov] getComplianceCalendar error:', err);
        return null;
      }
    },

    verifyFiling: async (filingId: string, data?: { source?: string; data?: Record<string, unknown> }): Promise<boolean> => {
      try {
        const res = await fetch(`${govUrl}/api/compliance/verify/${encodeURIComponent(filingId)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(data || {}),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error(`[gov] verifyFiling failed: ${res.status} — ${body.slice(0, 500)}`);
        }
        return res.ok;
      } catch (err) {
        console.error('[gov] verifyFiling error:', err);
        return false;
      }
    },

    getMonitors: async (status?: string): Promise<{ monitors: ComplianceMonitor[]; total: number } | null> => {
      try {
        const qs = status ? `?status=${status}` : '';
        const res = await fetch(`${govUrl}/api/compliance/monitors${qs}`, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error(`[gov] getMonitors failed: ${res.status} — ${body.slice(0, 500)}`);
          return null;
        }
        return await res.json() as { monitors: ComplianceMonitor[]; total: number };
      } catch (err) {
        console.error('[gov] getMonitors error:', err);
        return null;
      }
    },
  };
}
