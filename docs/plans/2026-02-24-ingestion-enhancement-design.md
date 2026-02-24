# ChittyCommand Ingestion Enhancement Design

## Goal

Expand ChittyCommand's data ingestion pipeline to scrape login-based bill portals, monitor courts across all jurisdictions where businesses operate, and ingest business governance data from ChittyGov. ChittyRouter becomes the unified ingestion gateway mediating all scrape and sync requests.

## Architecture

### Service Roles

| Service | Role in Pipeline |
|---------|-----------------|
| **ChittyCommand** | Orchestrator — cron triggers, stores results, urgency scoring, dashboard |
| **ChittyRouter** | Unified ingestion gateway — routes scrape requests, classifies inbound emails, dispatches to backends, handles retries |
| **ChittyScrape** | Browser automation — login-based portal scraping, court system searches, screenshot/PDF capture |
| **ChittyConnect** | Credential management — portal credentials via 1Password, service token issuance, ephemeral credential delivery |
| **ChittyGov** | Governance data source — compliance dates, registered agents, entity filings, process server tracking |
| **ChittyLedger** | Evidence pipeline — any scraped artifact can be elevated to evidence with chain of custody (not everything is evidence, but anything could be) |

### Data Flow

```
TRIGGERS
  Email arrives → ChittyRouter AI classifies → dispatches scrape
  Cron fires   → ChittyCommand → ChittyRouter /route/scrape
  Manual       → ChittyCommand UI → ChittyRouter /route/scrape

CREDENTIAL FLOW (zero-trust, ephemeral)
  ChittyRouter receives scrape request
    → fetches credentials from ChittyConnect /api/credentials/{portalRef}
    → ChittyConnect retrieves from 1Password (op run)
    → credentials passed in-memory to ChittyScrape (never persisted)
    → ChittyScrape uses credentials for browser session
    → credentials discarded after scrape completes

SCRAPE EXECUTION
  ChittyScrape runs browser automation
    → returns { data: structured_json, artifacts: [screenshot, pdf, html] }

STORAGE & PROCESSING
  ChittyCommand receives results
    → structured data → cc_obligations, cc_legal_deadlines, cc_properties
    → artifacts → R2 (document storage)
    → metadata → cc_documents (with r2_key, parsing_status)
    → urgency scoring → cc_obligations.urgency_score updated
    → recommendations → cc_recommendations (AI triage)

EVIDENCE PIPELINE (on-demand, not automatic)
  Any stored document can be elevated to evidence:
    → ChittyConnect /api/v1/evidence/ingest → ChittyLedger
    → chain of custody tracking via ledger/record-action
    → existing bridge routes handle this (already built)
```

### ChittyRouter Enhancement

New routes added to ChittyRouter:

```
POST /route/scrape          — General scrape dispatch
  { target: "peoples_gas", params: { account_id: "..." } }
  → fetches creds from ChittyConnect
  → dispatches to ChittyScrape
  → returns structured results

POST /route/court-search    — Multi-jurisdiction court search
  { names: ["Nicholas Arias", "IT CAN BE LLC", ...], jurisdictions: ["cook_county", "ndil", ...] }
  → dispatches to ChittyScrape court search endpoints
  → returns aggregated results

POST /route/compliance-sync — ChittyGov compliance data pull
  { entities: ["it-can-be-llc", "aribia-llc"], data_types: ["deadlines", "agents", "filings"] }
  → calls ChittyGov API directly
  → returns compliance data

POST /route/email-classify  — AI email classification (extends existing)
  → existing triage-agent classifies email as bill/court/compliance
  → triggers appropriate scrape via /route/scrape
```

AI agent enhancement: `scrape-dispatch-agent` — registered in ChittyRouter's agent orchestrator, classifies forwarded emails and determines which portal to scrape.

Retry/circuit breaker: ChittyRouter tracks scrape target health. If ChittyScrape fails for a target, retries with backoff, marks source as degraded in status endpoint.

---

## Phase 1: Bill Portal Scraping

### New Scrape Targets

| Portal | Auth Type | Data Extracted | Frequency |
|--------|-----------|---------------|-----------|
| Peoples Gas | Login | Balance, due date, usage history, payment history | Monthly |
| ComEd | Login | Balance, due date, usage/kWh, payment history | Monthly |
| HOA portals (per property) | Login (varies) | Assessments, special assessments, violations, meeting dates | Monthly |
| Xfinity | Login | Balance, plan, credits/charges breakdown | Monthly |
| Citi Credit Card | Login | Statement balance, minimum due, transactions, due date | Monthly |
| Home Depot Credit | Login | Balance, due date, recent transactions | Monthly |
| Lowe's Credit | Login | Balance, due date, recent transactions | Monthly |

### ChittyScrape Enhancement

Generic `PortalScraper` base class:
- Login flow (username/password, handles common MFA patterns)
- Session management (cookie jar, timeout handling)
- Screenshot capture at key steps (login, dashboard, statement)
- PDF download when available (statements, invoices)
- Structured data extraction via page selectors

Per-portal adapters extend the base:
- `PeoplesGasScraper` — mypeoplesgas.com
- `ComEdScraper` — comed.com/MyAccount
- `HOAScraper` — per-property portal (configurable URL + selectors)
- `XfinityScraper` — xfinity.com/billing
- `CitiScraper` — citicards.com
- `HomeDepotScraper` — homedepot.com/myaccount
- `LowesScraper` — lowes.com/mylowes

### Output Schema (per scrape)

```typescript
interface ScrapeResult {
  target: string;              // "peoples_gas"
  scraped_at: string;          // ISO timestamp
  success: boolean;
  data: {
    balance?: number;
    due_date?: string;
    minimum_due?: number;
    statement_date?: string;
    usage?: { period: string; amount: number; unit: string }[];
    payments?: { date: string; amount: number }[];
    charges?: { description: string; amount: number }[];
    [key: string]: unknown;    // portal-specific fields
  };
  artifacts: {
    type: "screenshot" | "pdf" | "html";
    key: string;               // R2 storage key
    step: string;              // "login", "dashboard", "statement"
  }[];
  error?: string;
}
```

### ChittyCommand Cron Addition

```typescript
// In src/lib/cron.ts schedule:
'0 14 * * 1': 'utility_scrape',    // 8 AM CT Monday (already reserved)
'0 14 1 * *': 'credit_scrape',     // 8 AM CT 1st of month
'0 15 1 * *': 'hoa_scrape',        // 9 AM CT 1st of month
```

All scrape triggers go through ChittyRouter, not ChittyScrape directly.

### Credential Storage (ChittyConnect + 1Password)

Portal credentials stored in 1Password under vault `ChittyOS-Portals`:
- `portal:peoples_gas` → { username, password }
- `portal:comed` → { username, password }
- `portal:xfinity` → { username, password }
- `portal:citi` → { username, password }
- `portal:home_depot` → { username, password }
- `portal:lowes` → { username, password }
- `portal:hoa:{property_pin}` → { url, username, password }

ChittyConnect exposes: `GET /api/credentials/portal/{target}` — returns credentials ephemerally (not cached, not logged).

---

## Phase 2: Multi-Jurisdiction Court Monitoring

### Search Scope

**Names to monitor:**
- Nicholas Arias (personal)
- All business entity names from ChittyGov (IT CAN BE LLC, ARIBIA LLC, etc.)

**Court systems:**
- Cook County Circuit Court (existing — extend from single case to name search)
- Other IL counties where businesses operate or properties are held
- Northern District of Illinois (federal)
- Any state where businesses are registered (from ChittyGov entity data)

### ChittyScrape Court Enhancement

Current: Single case lookup (`POST /api/scrape/court-docket` with hardcoded case number)

Enhanced:
```
POST /api/scrape/court-search
{
  names: ["Nicholas Arias", "IT CAN BE LLC", "ARIBIA LLC"],
  jurisdictions: [
    { system: "cook_county_circuit", type: "name_search" },
    { system: "il_ndil_pacer", type: "party_search" },
    { system: "il_secretary_of_state", type: "entity_search" },
    { system: "wy_secretary_of_state", type: "entity_search" }
  ]
}
```

Returns: list of cases/filings found, with deduplication against known cases.

### New Database Support

```sql
-- New table: cc_court_watches
CREATE TABLE cc_court_watches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_name TEXT NOT NULL,          -- "Nicholas Arias" or "IT CAN BE LLC"
  jurisdiction TEXT NOT NULL,          -- "cook_county_circuit"
  last_searched_at TIMESTAMP,
  results_count INTEGER DEFAULT 0,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT now()
);

-- New table: cc_court_cases (extends beyond single hardcoded case)
CREATE TABLE cc_court_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number TEXT NOT NULL,
  court_system TEXT NOT NULL,          -- "cook_county_circuit", "ndil"
  case_title TEXT,
  parties JSONB,                       -- [{name, role: "plaintiff"|"defendant"}]
  judge TEXT,
  status TEXT,                         -- "open", "closed", "appeal"
  filed_date TIMESTAMP,
  last_activity_date TIMESTAMP,
  next_hearing_date TIMESTAMP,
  watch_id UUID REFERENCES cc_court_watches(id),
  urgency_score INTEGER,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
```

Existing `cc_legal_deadlines` continues to track individual deadlines per case.

### Cron Schedule

```typescript
'0 13 * * *': 'court_search',    // 7 AM CT daily — search all monitored names
```

---

## Phase 3: ChittyGov Integration

### Data to Ingest

From ChittyGov API (`/api/entities`, `/api/compliance/*`):

| Data Type | Source | ChittyCommand Target |
|-----------|--------|---------------------|
| Compliance deadlines | Annual reports, franchise tax, SOS filings | cc_legal_deadlines (deadline_type: "compliance") |
| Registered agent info | Entity registrations per state | cc_court_watches metadata |
| Process server tracking | Service of process records | cc_legal_deadlines (deadline_type: "service") |
| Entity status | Good standing, dissolution risk | cc_recommendations |
| Authority expiration | Board resolutions, power of attorney | cc_legal_deadlines |
| COI deadlines | Conflict of interest cure dates | cc_legal_deadlines |

### Bridge Route

```typescript
// In ChittyCommand src/routes/bridge.ts
bridgeRoutes.post('/gov/sync-compliance', async (c) => {
  // Call ChittyGov API for all tracked entities
  // Upsert compliance deadlines into cc_legal_deadlines
  // Generate urgency scores
});

bridgeRoutes.post('/gov/sync-entities', async (c) => {
  // Pull entity metadata (registered agents, jurisdiction, status)
  // Update cc_court_watches with entity names for court monitoring
});
```

### ChittyCommand Env Addition

```
CHITTYGOV_URL=https://gov.chitty.cc
```

### Cron Schedule

```typescript
'0 16 * * 1': 'gov_compliance',  // 10 AM CT Monday — sync compliance deadlines
```

---

## Integration Summary

### ChittyRouter New Routes

| Route | Purpose | Backend |
|-------|---------|---------|
| `POST /route/scrape` | Dispatch portal scrape | ChittyScrape via ChittyConnect creds |
| `POST /route/court-search` | Multi-jurisdiction court search | ChittyScrape court endpoints |
| `POST /route/compliance-sync` | Pull governance data | ChittyGov API |
| `POST /route/email-classify` | AI classify + dispatch | Internal agent → above routes |

### ChittyScrape New Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/scrape/portal/{target}` | Generic portal scrape (receives creds) |
| `POST /api/scrape/court-search` | Multi-name, multi-jurisdiction search |

### ChittyConnect Enhancement

| Endpoint | Purpose |
|----------|---------|
| `GET /api/credentials/portal/{target}` | Ephemeral portal credential retrieval |

### ChittyCommand New Cron Jobs

| Schedule | Job | Via |
|----------|-----|-----|
| Monday 8 AM CT | `utility_scrape` | ChittyRouter → ChittyScrape |
| 1st of month 8 AM CT | `credit_scrape` | ChittyRouter → ChittyScrape |
| 1st of month 9 AM CT | `hoa_scrape` | ChittyRouter → ChittyScrape |
| Daily 7 AM CT | `court_search` | ChittyRouter → ChittyScrape |
| Monday 10 AM CT | `gov_compliance` | ChittyRouter → ChittyGov |

### New Database Tables

- `cc_court_watches` — monitored names + jurisdictions
- `cc_court_cases` — discovered cases across all jurisdictions

### Evidence Pipeline

No changes needed. Existing `ledger/sync-documents` and `ledger/record-action` bridge routes handle evidence elevation for any scraped artifact stored in `cc_documents`. Not everything is evidence, but anything could be.

---

## Build Sequence

1. **Phase 1a**: ChittyConnect portal credential endpoints + 1Password vault setup
2. **Phase 1b**: ChittyScrape portal adapters (Peoples Gas, ComEd first)
3. **Phase 1c**: ChittyRouter /route/scrape + scrape-dispatch-agent
4. **Phase 1d**: ChittyCommand cron wiring + cc_obligations upsert from scrape results
5. **Phase 1e**: Remaining portal adapters (HOA, Xfinity, Citi, Home Depot, Lowe's)
6. **Phase 2a**: ChittyScrape court-search endpoint (Cook County name search)
7. **Phase 2b**: cc_court_watches + cc_court_cases tables + migration
8. **Phase 2c**: Expand to NDIL, other jurisdictions
9. **Phase 2d**: ChittyCommand cron + urgency scoring for court findings
10. **Phase 3a**: ChittyGov API integration client in ChittyCommand
11. **Phase 3b**: Bridge routes for compliance sync
12. **Phase 3c**: Cron wiring + urgency scoring for governance deadlines
