# ChittyScrape + ChittyFinance Liability Support Design

**Date:** 2026-02-23
**Status:** Approved
**Scope:** ChittyScrape service, ChittyFinance liability accounts, ChittyCommand orchestration refactor

## Architectural Context

ChittyCommand is the **dashboard and orchestrator** — it reads from service apps, runs its own analytics (urgency scoring, projections, recommendations), and orchestrates actions. It does NOT own raw financial data.

Service apps own their data:
- **ChittyFinance** — all financial data: bank accounts, transactions, liabilities (mortgages, tax bills)
- **ChittyLedger** — evidence, legal documents, chain of custody
- **ChittyScrape** — browser automation, stateless, returns JSON

```
Data Sources → Service Apps (Finance, Ledger, Scrape)
                        ↕ read + write
                  ChittyCommand (dashboard + orchestrator)
                        → rollups, urgency, projections, actions
```

### What ChittyCommand Owns (Neon)
- Obligations (scored, with urgency — Command's value-add)
- Recommendations (AI-generated action items)
- Actions log (executed actions)
- Cash flow projections (derived analytics)
- Disputes (multi-service coordination)
- Properties (metadata, not financial balances)

### What ChittyCommand Reads From
- ChittyFinance: account balances, transactions, liabilities
- ChittyLedger: evidence, legal deadlines
- ChittyScrape: triggered scrapes (on-demand)

## ChittyScrape Service

### Overview

**ChittyScrape** (`scrape.chitty.cc`) — standalone Cloudflare Worker with Browser Rendering binding. Stateless scraper service. Returns structured JSON. No database.

### Endpoints

| Endpoint | Method | Input | Output |
|----------|--------|-------|--------|
| `POST /api/scrape/mr-cooper` | POST | `{property: "addison"}` | Full mortgage details |
| `POST /api/scrape/cook-county-tax` | POST | `{pin: "14-21-111-008-1006"}` | Tax bill per PIN |
| `POST /api/scrape/court-docket` | POST | `{caseNumber: "2024D007847"}` | Full docket history |
| `GET /health` | GET | — | Standard health |

### Auth
- Service token in KV (`scrape:service_token`)
- Callers pass `Authorization: Bearer <token>`

### Credentials
- Mr. Cooper login: 1Password → ChittyScrape KV (`mrcooper:username`, `mrcooper:password`)
- Court docket and Cook County tax: public pages, no login

### Scrape Targets

#### Mr. Cooper (Addison only)
- **URL:** mrcooper.com portal login
- **Data:** Current balance, monthly payment, escrow balance, interest rate, payoff amount, payment history (last 12 months)
- **Output:** `{balance, monthlyPayment, escrowBalance, interestRate, payoffAmount, paymentHistory: [{date, amount, principal, interest, escrow}]}`
- **Frequency:** Monthly 1st (via `monthly_check` cron)

#### Cook County Property Tax (4 PINs)
- **URL:** cookcountytreasurer.com
- **PINs:**
  - `14-21-111-008-1006` — 541 W Addison St #3S
  - `14-28-122-017-1180` — 550 W Surf St C-211
  - `14-28-122-017-1091` — 559 W Surf St C-504
  - `14-16-300-032-1238` — 4343 N Clarendon Ave #1610
- **Data:** Tax year, 1st installment (amount, due date, paid?), 2nd installment (amount, due date, paid?), total tax, exemptions
- **Output:** `{pin, taxYear, installments: [{number, amount, dueDate, status}], totalTax, exemptions}`
- **Frequency:** Monthly 1st (via `monthly_check` cron)

#### Cook County Court Docket
- **URL:** circuitclerk.cookcountyil.gov
- **Case:** 2024D007847 (Arias v. Bianchi)
- **Data:** Full docket history — all entries with dates, descriptions, judge, next hearing
- **Output:** `{caseNumber, parties, judge, status, entries: [{date, description, filedBy}], nextHearing}`
- **Frequency:** Daily (via `court_docket` cron)

### Infrastructure

```toml
# wrangler.toml for chittyscrape
name = "chittyscrape"
main = "src/index.ts"
compatibility_date = "2026-01-15"
compatibility_flags = ["nodejs_compat"]
routes = [{ pattern = "scrape.chitty.cc", custom_domain = true }]

[browser]
binding = "BROWSER"

[[kv_namespaces]]
binding = "SCRAPE_KV"

[[tail_consumers]]
service = "chittytrack"
```

### Error Handling
- Each scrape returns `{success: boolean, data?: ..., error?: string, screenshot?: string}`
- Browser session failures (CAPTCHA, site down) return error — Claude in Chrome is manual fallback
- Timeout: 25 seconds per scrape (Worker limit)

## ChittyFinance Liability Support

### Current State
- ChittyFinance is a full-stack app on Replit (`chittyapps/chittyfinance`)
- Neon PostgreSQL with multi-tenant architecture
- Account types: `checking`, `savings`, `credit`, `investment`
- **Missing:** liability account types (mortgage, loan, tax_liability)
- **Issue:** API returning 1101 errors on some endpoints

### Required Changes

#### 1. Add Liability Account Types
Extend the `accounts.type` field to include: `mortgage`, `loan`, `tax_liability`

#### 2. Add Liability-Specific Fields
```sql
ALTER TABLE accounts ADD COLUMN liability_details jsonb;
-- For mortgage: {interestRate, escrowBalance, payoffAmount, maturityDate, lender}
-- For tax: {taxYear, pin, installments, exemptions}
```

#### 3. New API Endpoints (or extend existing)
```
POST /api/accounts          — accept liability types
GET  /api/accounts?type=mortgage  — filter by type
POST /api/accounts/:id/sync — update balance/details from external source
```

#### 4. Stabilize API
- Fix 1101 errors (Worker exception)
- Ensure `/api/accounts`, `/api/transactions`, `/api/summary` work reliably

## Data Flow

### Scrape → Finance (liabilities)
```
ChittyScrape scrapes Mr. Cooper → POST ChittyFinance /api/accounts/:id/sync
  {balance: 180000, liability_details: {interestRate: 3.5, escrow: 1200, ...}}

ChittyScrape scrapes Cook County → POST ChittyFinance /api/accounts/:id/sync
  {balance: 8500, liability_details: {taxYear: 2025, pin: "14-21-...", installments: [...]}}
```

### Scrape → Ledger (court docket)
```
ChittyScrape scrapes court docket → POST ChittyLedger /api/legal-deadlines/sync
  {caseNumber: "2024D007847", entries: [...], nextHearing: "2026-04-15"}
```

### Command Reads
```
ChittyCommand reads ChittyFinance → dashboard shows all accounts (bank + liabilities)
ChittyCommand reads ChittyLedger → dashboard shows legal deadlines
ChittyCommand runs its own triage → urgency scores, recommendations
```

## Properties (4 total)

| Property | PIN | Unit | Mr. Cooper? | HOA |
|----------|-----|------|-------------|-----|
| 541 W Addison St | `14-21-111-008-1006` | #3S | Yes (USAA origin) | HOA - 541 W Addison |
| 550 W Surf St | `14-28-122-017-1180` | C-211 | No | Commodore Green Briar |
| 559 W Surf St | `14-28-122-017-1091` | C-504 | No (SoFi origin) | Commodore Green Briar |
| 4343 N Clarendon Ave | `14-16-300-032-1238` | #1610 | No | TBD |

## Build Sequence

### Phase 1: Fix ChittyFinance
1. Clone `chittyapps/chittyfinance`
2. Fix API stability (1101 errors)
3. Add liability account types + fields
4. Add/extend sync endpoints
5. Deploy, verify endpoints work
6. Seed liability accounts for all 4 properties

### Phase 2: Build ChittyScrape
1. Scaffold new `CHITTYOS/chittyscrape` repo
2. Implement court docket scraper (public, simplest)
3. Implement Cook County tax scraper (public, 4 PINs)
4. Implement Mr. Cooper scraper (login required)
5. Add service auth
6. Deploy to `scrape.chitty.cc`

### Phase 3: Wire Everything
1. ChittyScrape pushes results to ChittyFinance (liabilities) and ChittyLedger (docket)
2. ChittyCommand cron triggers scrapes via ChittyScrape API
3. ChittyCommand reads from ChittyFinance for dashboard
4. Update ChittyCommand seed data: add missing properties (Surf 211, Clarendon) with PINs

### Phase 4: ChittyCommand Refactor (future)
1. Remove `cc_accounts` / `cc_transactions` local storage
2. Replace with live reads from ChittyFinance
3. Keep: obligations, recommendations, actions_log, projections, disputes (Command's domain)
4. Mercury integration moves from Command to Finance

## Files Modified

### New Repo: `CHITTYOS/chittyscrape`
| File | Purpose |
|------|---------|
| `src/index.ts` | Hono entry, auth, health |
| `src/scrapers/mr-cooper.ts` | Mr. Cooper portal scraper |
| `src/scrapers/cook-county-tax.ts` | Property tax scraper |
| `src/scrapers/court-docket.ts` | Court docket scraper |
| `wrangler.toml` | Browser Rendering, KV, cron |
| `package.json` | hono, @cloudflare/puppeteer |

### Modified: `chittyapps/chittyfinance`
| File | Change |
|------|--------|
| `database/system.schema.ts` | Add liability types + fields |
| `server/routes.ts` | Add/extend liability endpoints |
| API stability fixes | Fix 1101 errors |

### Modified: `CHITTYOS/chittycommand`
| File | Change |
|------|--------|
| `src/routes/bridge.ts` | Add scrape trigger routes |
| `src/lib/cron.ts` | Wire cron to scrape triggers |
| `src/index.ts` | Add CHITTYSCRAPE_URL to Env |
| `wrangler.toml` | Add CHITTYSCRAPE_URL var |
| `migrations/` | Add missing properties + PINs |
