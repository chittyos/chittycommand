import type { Env } from '../index';

/**
 * Service integration clients for the ChittyOS ecosystem.
 * Each client is a thin wrapper that calls the upstream service API.
 * All calls are fire-and-forget safe — failures are logged but don't break the caller.
 */

// ── ChittyLedger ─────────────────────────────────────────────
// Evidence pipeline: documents → evidence, disputes → cases, actions → custody log

export interface LedgerEvidencePayload {
  filename: string;
  fileType: string;
  fileSize?: string;
  description?: string;
  evidenceTier: string;
  caseId?: string;
}

export interface LedgerCustodyEntry {
  evidenceId: string;
  action: string;
  performedBy: string;
  location?: string;
  notes?: string;
}

export function ledgerClient(env: Env) {
  const baseUrl = env.CHITTYLEDGER_URL;
  if (!baseUrl) return null;

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Source-Service': 'chittycommand' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`[ledger] ${path} failed: ${res.status}`);
        return null;
      }
      return await res.json() as T;
    } catch (err) {
      console.error(`[ledger] ${path} error:`, err);
      return null;
    }
  }

  return {
    /** Push a document into ChittyLedger as evidence */
    createEvidence: (payload: LedgerEvidencePayload) =>
      post<{ id: string }>('/api/evidence', payload),

    /** Record a chain-of-custody event */
    addCustodyEntry: (entry: LedgerCustodyEntry) =>
      post('/api/evidence/' + entry.evidenceId + '/custody', entry),

    /** Create or link a case in ChittyLedger */
    createCase: (payload: { caseNumber: string; title: string; caseType: string; description?: string }) =>
      post<{ id: string }>('/api/cases', payload),

    /** Get evidence by case */
    getEvidenceByCase: async (caseId: string): Promise<Record<string, unknown>[]> => {
      try {
        const qs = new URLSearchParams({ caseId }).toString();
        const res = await fetch(`${baseUrl}/api/evidence?${qs}`, {
          headers: { 'X-Source-Service': 'chittycommand' },
        });
        if (!res.ok) return [];
        return await res.json() as Record<string, unknown>[];
      } catch { return []; }
    },
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
      if (!res.ok) return null;
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
        console.error(`[charge] ${path} failed: ${res.status}`);
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

  return {
    /** Discover a service URL by name */
    discover: async (serviceName: string): Promise<string | null> => {
      try {
        const res = await fetch(`${baseUrl}/api/discover/${serviceName}`, {
          headers: { 'X-Source-Service': 'chittycommand' },
        });
        if (!res.ok) return null;
        const data = await res.json() as { url: string };
        return data.url;
      } catch { return null; }
    },
  };
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
        console.error(`[mercury] ${path} failed: ${res.status}`);
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
        if (!res.ok) return null;
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
          console.error(`[books] record-transaction failed: ${res.status}`);
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
      if (!res.ok) return null;
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
        console.error(`[assets] ${path} failed: ${res.status}`);
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
        console.error(`[scrape] ${path} failed: ${res.status}`);
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
