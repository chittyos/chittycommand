# Mercury + ChittyBooks Live Data Integration Design

**Date:** 2026-02-23
**Status:** Approved
**Approach:** Direct Mercury API client + ChittyBooks client + bridge routes

## Context

ChittyCommand is deployed and healthy at `command.chitty.cc`. The API, intelligence engines, UI, and database are fully implemented. The next priority is wiring live financial data from Mercury, which has 7+ orgs (one token per org, Aribia LLC Mgmt has 2 accounts, rest have 1 each, plus a personal account).

## Token Management

- **Source of truth:** 1Password, accessed via ChittyConnect (`connect.chitty.cc`)
- **Runtime storage:** `COMMAND_KV` (same pattern as Plaid access tokens)
- **Org registry:** KV key `mercury:orgs` stores a JSON array of org configs:
  ```json
  [
    {"slug": "aribia-mgmt", "opRef": "op://vault/mercury-aribia-mgmt/token"},
    {"slug": "aribia-1050", "opRef": "op://vault/mercury-aribia-1050/token"},
    {"slug": "personal", "opRef": "op://vault/mercury-personal/token"}
  ]
  ```
- **Cached tokens:** KV key `mercury:token:{slug}` holds the bearer token
- **Refresh:** A `/api/bridge/mercury/refresh-tokens` endpoint calls ChittyConnect for each org, writes tokens to KV. Cron calls this as its first step.

## Mercury Client

Added to `src/lib/integrations.ts` as `mercuryClient(token)`:

- `getAccounts()` — `GET /api/v1/accounts` returns all accounts for the org
- `getTransactions(accountId, params)` — `GET /api/v1/account/{id}/transactions` with pagination, date filters

Mercury API: `https://api.mercury.com/api/v1`, bearer token auth.

## Sync Pipeline

### Account Sync (`/api/bridge/mercury/sync-accounts`)

1. Read org list from KV (`mercury:orgs`)
2. For each org, read cached token from KV (`mercury:token:{slug}`)
3. Call `getAccounts()` for each org
4. Upsert into `cc_accounts`:
   - `source = 'mercury'`
   - `source_id = mercury_account_id`
   - `metadata = { mercury_org: slug, mercury_account_type: ... }`
5. Update `current_balance` + `last_synced_at` on existing rows

### Transaction Sync (`/api/bridge/mercury/sync-transactions`)

1. Get all `cc_accounts` where `source = 'mercury'`
2. Group by `metadata.mercury_org` to match tokens
3. For each account, call `getTransactions()` with incremental cursor (KV `mercury:cursor:{account_id}`)
4. Upsert into `cc_transactions`:
   - `source = 'mercury'`
   - `source_id = mercury_transaction_id`
   - Map Mercury `kind` (credit/debit) to `direction` (inflow/outflow)
5. After all transactions land, trigger existing transaction matcher

### Cron Integration

Daily 6 AM CT cron (`0 12 * * *`) updated order:

1. Refresh Mercury tokens from ChittyConnect
2. Sync Mercury accounts
3. Sync Mercury transactions
4. Plaid sync (existing)
5. Transaction matching (existing)
6. AI triage (existing)
7. Cash flow projections (existing)

## Error Handling

- Each org syncs independently; expired token logs error, continues to next
- All sync results logged to `cc_sync_log`
- ChittyConnect unavailable during refresh: cached KV tokens still work

## Files Modified

| File | Change |
|------|--------|
| `src/lib/integrations.ts` | Add `mercuryClient(token)` |
| `src/routes/bridge.ts` | Add Mercury section: refresh-tokens, sync-accounts, sync-transactions |
| `src/lib/cron.ts` | Add Mercury sync steps before Plaid in daily cron |

## ChittyFinance Path (Future Aggregation Layer)

The direct Mercury client provides immediate data. ChittyFinance (`finance.chitty.cc`) remains the intended long-term aggregation layer for Mercury + Wave + Stripe.

### Coexistence Strategy

- Both paths write to `cc_accounts` / `cc_transactions` with different `source` values:
  - Direct: `source = 'mercury'`
  - Via ChittyFinance: `source = 'chittyfinance'`
- The existing `financeClient()` in `integrations.ts` and bridge routes (`/finance/sync-accounts`, `/finance/sync-transactions`) already work and remain unchanged
- When ChittyFinance is deployed and pulling Mercury data, its accounts will appear alongside direct Mercury accounts
- **Dedup rule:** If an account exists with `source = 'mercury'` AND `source = 'chittyfinance'` for the same underlying Mercury account, the transaction matcher and dashboard prefer the direct Mercury source (fresher data, no proxy lag)

### Migration Path

Once ChittyFinance is stable and aggregating all sources:
1. Mark direct Mercury accounts as `metadata.migration_status = 'chittyfinance_available'`
2. Verify ChittyFinance data matches direct data
3. Optionally disable the direct Mercury sync via KV flag (`mercury:direct_sync_enabled = false`)
4. Direct Mercury client stays in code as a fallback

## ChittyBooks Integration

ChittyBooks (`chittybooks.chitty.cc`) is the bookkeeping/accounting service. Flask app with REST API. Currently not deployed but repo exists at `chittyapps/chittybooks`.

### Purpose in ChittyCommand

ChittyBooks enables **action execution** — when ChittyCommand recommends a payment or records a transaction, it can push that to ChittyBooks for proper bookkeeping (double-entry accounting, categorization, audit trail).

### ChittyBooks API

- `GET /api/summary` — financial summary with AI insights
- `GET /api/transactions` — list all transactions
- `POST /api/transaction` — add transaction (`{type, description, amount}`)
- `GET /health` — health check

### ChittyBooks Client

Added to `src/lib/integrations.ts` as `booksClient(env)`:

- `getSummary()` — fetch financial summary
- `getTransactions()` — list transactions
- `recordTransaction(type, description, amount)` — push a transaction for bookkeeping

Uses `CHITTYBOOKS_URL` env var (like other service URLs).

### Bridge Routes

- `POST /api/bridge/books/record-transaction` — record a payment/expense in ChittyBooks
- `POST /api/bridge/books/sync-summary` — pull ChittyBooks summary into dashboard
- `GET /api/bridge/books/status` — check if ChittyBooks is reachable

### Action Execution Flow

When a recommendation is acted on (e.g., "Pay ComEd bill"):
1. ChittyCommand executes the payment (via Mercury API or ChittyCharge)
2. ChittyCommand records the transaction in ChittyBooks for bookkeeping
3. ChittyCommand logs the action in `cc_actions_log`

## Files Modified

| File | Change |
|------|--------|
| `src/lib/integrations.ts` | Add `mercuryClient(token)` + `booksClient(env)` |
| `src/routes/bridge.ts` | Add Mercury + ChittyBooks sections |
| `src/lib/cron.ts` | Add Mercury sync steps before Plaid in daily cron |
| `src/index.ts` | Add `CHITTYBOOKS_URL` to Env type |
| `wrangler.toml` | Add `CHITTYBOOKS_URL` env var |

## No Changes Needed

- Database schema — Mercury data fits existing `cc_accounts` + `cc_transactions` tables
- Bridge routes already mounted in `src/index.ts`
