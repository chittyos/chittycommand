# ChittyCommand AI Search & Intelligence System

## Overview

ChittyCommand uses a three-tier intelligence pipeline to ingest financial data from 15+ sources, score urgency, match transactions to obligations, project cash flow, and generate prioritized action recommendations. There is no traditional keyword search — the system operates as an **autonomous triage engine** that surfaces what matters most.

## Architecture

```
Data Sources (15+)
  │
  ▼
┌─────────────────────────────────────────┐
│  Tier 1: Deterministic Scoring          │
│  src/lib/urgency.ts                     │
│  - Time pressure (days until due)       │
│  - Category severity weights            │
│  - Late fee impact                      │
│  - Auto-pay discount                    │
│  - Status adjustments                   │
│  → Output: 0–100 urgency score          │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│  Tier 2: Rule-Based Intelligence        │
│  src/lib/triage.ts                      │
│  src/lib/matcher.ts                     │
│  src/lib/projections.ts                 │
│  - Transaction→obligation matching      │
│  - Recommendation generation            │
│  - Cash flow projection (90 days)       │
│  - Dispute action scheduling            │
│  - Legal deadline alerting              │
│  → Output: cc_recommendations rows      │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│  Tier 3: AI-Enhanced (Future)           │
│  - Workers AI document classification   │
│  - Natural language query via MCP       │
│  - Anomaly detection on transactions    │
└─────────────────────────────────────────┘
```

## Components

### 1. Urgency Scoring Engine (`src/lib/urgency.ts`)

Deterministic 0–100 scoring with four urgency levels:

| Level    | Score Range | Meaning                         |
|----------|-------------|----------------------------------|
| critical | 70–100      | Pay/act immediately              |
| high     | 50–69       | Needs attention this week        |
| medium   | 30–49       | Coming up, plan for it           |
| low      | 0–29        | Low priority or auto-handled     |

**Scoring factors:**

- **Time pressure** (0–50 pts): Severely overdue (+50), overdue >1 week (+45), overdue (+40), due today (+35), due in 3 days (+30), due in 7 days (+20), due in 14 days (+10)
- **Category severity** (5–30 pts): Legal (30), mortgage (25), federal/property tax (20), utility/insurance (15), HOA (12), credit card/loan (10), subscription (5)
- **Late fee impact** (0–15 pts): >$50 fee (+15), >$25 fee (+10), any fee (+5)
- **Auto-pay discount** (-25 pts): Already handled automatically
- **Status adjustments**: Paid (-50), disputed (-10)

### 2. Transaction Matcher (`src/lib/matcher.ts`)

Fuzzy matching engine that links bank transactions to obligations. Runs daily after data sync.

**Matching algorithm:**

Each transaction-obligation pair gets a weighted confidence score:
- **Name similarity** (50% weight): Token-based matching between transaction description/counterparty and obligation payee. Counterparty field preferred (more reliable than raw descriptions).
- **Amount proximity** (35% weight): Exact match = 1.0, within 5% = 0.95, within 20% = 0.7, within 50% = 0.3
- **Date proximity** (15% weight): Within 3 days = 1.0, within 7 days = 0.8, within 14 days = 0.5, within 30 days = 0.3

Threshold: **confidence > 60%** to match. Best match wins per obligation (no double-matching).

**On match:** Transaction gets linked (`obligation_id` set), obligation flips to `paid`, action logged to `cc_actions_log`.

### 3. AI Triage Engine (`src/lib/triage.ts`)

Orchestrates the full intelligence pipeline via `runTriage()`. Generates recommendations in `cc_recommendations`.

**Pipeline steps:**
1. Score all active obligations via urgency engine
2. Flip past-due `pending` obligations to `overdue`
3. Compute 30-day cash position (cash vs. upcoming obligations)
4. Load open disputes and upcoming legal deadlines
5. Expire stale recommendations (>7 days old)
6. Generate new recommendations (deduped by title)

**Recommendation types:**

| Type       | Trigger                                  | Priority | Action              |
|------------|------------------------------------------|----------|---------------------|
| `payment`  | Critical urgency + not auto-pay          | 1        | `pay_now`           |
| `negotiate`| High urgency + negotiable + >$100        | 3        | `negotiate`         |
| `defer`    | Cash-tight + medium urgency + deferrable | 5        | `defer`             |
| `strategy` | Credit card minimum vs. full balance     | 4        | `pay_minimum`       |
| `dispute`  | Open dispute with next action defined    | 2–4      | `execute_action`    |
| `legal`    | Deadline within 14 days                  | 1–2      | `prepare_legal`     |
| `warning`  | 30-day cash shortfall detected           | 1        | `review_cashflow`   |

### 4. Cash Flow Projections (`src/lib/projections.ts`)

90-day forward-looking projection via `generateProjections()`:

- **Starting balance**: Sum of checking + savings accounts
- **Outflows**: All pending/overdue obligations projected by recurrence (one-time, monthly, quarterly, annual)
- **Inflows**: 3-month rolling average of historical monthly income, spread daily
- **Confidence decay**: 90% for 0–30 days, 70% for 30–60 days, 50% for 60–90 days

Output: starting/ending balance, total inflows/outflows, lowest balance date (cash crunch warning).

## Data Flow

### Cron Schedule (`wrangler.toml` triggers)

| Cron            | Time (CT) | Pipeline                                    |
|-----------------|-----------|---------------------------------------------|
| `0 12 * * *`    | 6 AM daily| Plaid sync, ChittyFinance sync, matcher, triage, projections |
| `0 13 * * *`    | 7 AM daily| Court docket check                          |
| `0 14 * * 1`    | 8 AM Mon  | Utility scrapers                            |
| `0 15 1 * *`    | 9 AM 1st  | Mortgage, property tax                      |

### Daily Pipeline (`src/lib/cron.ts`)

```
1. Plaid sync       → Update account balances + ingest new transactions
2. ChittyFinance    → Sync Mercury/Wave/Stripe accounts + transactions
3. Matcher          → Auto-link transactions to obligations, mark paid
4. Triage           → Score urgency, generate recommendations
5. Projections      → Generate 90-day cash flow forecast
```

Each phase is independently fault-tolerant — a failure in one doesn't prevent subsequent phases.

## API Endpoints

### REST API (authenticated via ChittyAuth)

| Method | Path                              | Description                      |
|--------|-----------------------------------|----------------------------------|
| GET    | `/api/recommendations`            | List active recommendations      |
| POST   | `/api/recommendations/generate`   | Trigger triage engine manually   |
| POST   | `/api/recommendations/:id/act`    | Mark recommendation as acted on  |
| POST   | `/api/recommendations/:id/dismiss`| Dismiss a recommendation         |
| GET    | `/api/dashboard`                  | Aggregated view: accounts, obligations, disputes, deadlines, recommendations |
| GET    | `/api/cashflow`                   | Cash flow projections            |

### MCP Server (JSON-RPC 2.0 at `/mcp`)

Six tools exposed for Claude Code sessions:

| Tool                      | Description                                                     |
|---------------------------|-----------------------------------------------------------------|
| `query_obligations`       | Filter obligations by status, category, min urgency             |
| `query_accounts`          | List accounts by type with balances and sync status             |
| `query_disputes`          | Active disputes with amounts and next actions                   |
| `get_recommendations`     | AI triage recommendations filtered by priority/type             |
| `get_cash_position`       | Financial snapshot: cash, credit, mortgage, 30-day outlook      |
| `get_cashflow_projections`| 90-day projections with confidence scores                       |

## Database Tables

All tables prefixed `cc_` in Neon PostgreSQL:

| Table                      | Role                                          |
|----------------------------|-----------------------------------------------|
| `cc_accounts`              | Bank, credit, mortgage, loan accounts         |
| `cc_obligations`           | Bills, payments, taxes with urgency scores    |
| `cc_transactions`          | Ingested transactions linked to accounts      |
| `cc_recommendations`       | AI-generated action recommendations           |
| `cc_cashflow_projections`  | 90-day daily projection snapshots             |
| `cc_disputes`              | Active disputes (Xfinity, HOA, Fox Rental)    |
| `cc_dispute_correspondence`| Correspondence per dispute                    |
| `cc_legal_deadlines`       | Court/legal deadlines with reminder schedules |
| `cc_documents`             | Uploaded docs stored in R2                    |
| `cc_actions_log`           | Audit trail of all automated/manual actions   |
| `cc_sync_log`              | Sync history per source                       |
| `cc_properties`            | Property records (address, HOA, tax PIN)      |

## Data Sources

| Source          | Sync Method  | Data Type                |
|-----------------|-------------|--------------------------|
| Mercury         | API (Plaid) | Checking, transactions   |
| Wave            | API         | Invoicing, payments      |
| Stripe          | API         | Payment processing       |
| TurboTenant     | API         | Rental income            |
| ChittyFinance   | API         | Aggregated accounts      |
| ChittyRental    | API         | Property management      |
| Plaid           | API         | Bank linking + tx sync   |
| ComEd           | Email parse | Utility bills            |
| Peoples Gas     | Email parse | Utility bills            |
| Xfinity         | Email parse | Internet/cable bills     |
| Citi            | Email parse | Credit card statements   |
| Home Depot      | Email parse | Store credit             |
| Lowe's          | Email parse | Store credit             |
| Mr. Cooper      | Scraper     | Mortgage payments        |
| Cook County     | Scraper     | Property tax             |
| Court docket    | Scraper     | Legal deadlines          |
| IRS             | Manual      | Quarterly tax estimates  |
| HOA             | Manual      | Monthly HOA fees         |
| DoorLoop        | Historical  | Archived rental data     |

## Action Execution

Three execution modes for acting on recommendations:

1. **API** — Direct service calls: Mercury transfers (via Plaid), Stripe payments, ChittyCharge holds/captures
2. **Claude in Chrome** — Browser automation for portals without APIs (Mr. Cooper, ComEd, Cook County)
3. **Email** — Dispute letters and follow-ups via Cloudflare Email Workers
