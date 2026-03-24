---
uri: chittycanon://docs/ops/policy/chittycommand-charter
namespace: chittycanon://docs/ops
type: policy
version: 1.0.0
status: DRAFT
registered_with: chittycanon://core/services/canon
title: "ChittyCommand Charter"
certifier: chittycanon://core/services/chittycertify
visibility: PUBLIC
context_brief: chittycontext://persistent-brief
discovery_refs:
  - chittycanon://gov/governance
  - chittycanon://docs/tech/spec/context-schema
  - chittycanon://specs/chittydna-session-governance
---

# ChittyCommand Charter

<!-- chitty:discovery-links:start -->
## Persistent Context

- **Working memory brief**: [docs/PERSISTENT_BRIEF.md](docs/PERSISTENT_BRIEF.md)
- **Canonical governance**: `chittycanon://gov/governance`
- **TY/VY/RY framework**: `chittycanon://gov/governance#three-aspects-framework`
- **Context model**: `chittycanon://docs/tech/spec/context-schema`
- **Session governance genes**: `chittycanon://specs/chittydna-session-governance`
- **Governance DNA / earned authority**: `chittycanon://gov/governance#written-to-chittydna`

This section is a persistent discovery hint for humans and agents. It is not an authority source.
<!-- chitty:discovery-links:end -->

## Classification
- **Canonical URI**: `chittycanon://core/services/chittycommand`
- **Tier**: 5 (Application)
- **Organization**: CHITTYOS
- **Domain**: command.chitty.cc

## Mission

Provide a unified life management and action dashboard that ingests data from 15+ financial, legal, and administrative sources, scores urgency with AI, recommends actions, and executes them via APIs, email, or browser automation.

## Scope

### IS Responsible For
- Ingesting financial data (Mercury, Stripe, Plaid, ChittyFinance, ChittyBooks)
- Ingesting legal data (court dockets, deadlines, dispute status)
- Ingesting property data (property tax, mortgage, HOA)
- Ingesting utility data (ComEd, Peoples Gas, Xfinity)
- AI-powered urgency scoring and action recommendations
- Action execution via API calls, email, or browser automation
- Document storage in R2 for receipts, letters, and evidence
- Cron-scheduled data sync across all sources
- Bridge API for inter-service data exchange (ChittyScrape, ChittyLedger)
- Proxy passthrough for ChittySchema validation, ChittyCert verification, ChittyRegister requirements
- MCP server for Claude-driven queries (48 tools across 12 domains)
- Case timeline aggregation from ChittyEvidence, ChittyLedger, and local DB
- Litigation support (fact synthesis, drafting, QC) via ChittyConnect prompts or AI Gateway fallback
- Scrape job dispatch with retry, dead-letter, and fan-out to downstream agents

### IS NOT Responsible For
- Identity generation (ChittyID)
- Token provisioning (ChittyAuth)
- Service registration (ChittyRegister)
- Browser automation execution (ChittyScrape)
- Bookkeeping transactions (ChittyBooks)
- Asset tracking (ChittyAssets)
- Financial aggregation (ChittyFinance)
- Billing and invoicing (ChittyCharge)

## Dependencies

| Type | Service | Purpose |
|------|---------|---------|
| Upstream | ChittyAuth | User authentication, token validation |
| Upstream | ChittyFinance | Financial data aggregation |
| Upstream | ChittyBooks | Bookkeeping entries |
| Upstream | ChittyAssets | Asset tracking data |
| Upstream | ChittyCharge | Billing data |
| Upstream | ChittyScrape | Browser-based scraping for portals without APIs |
| Upstream | ChittyLedger | Evidence and document ledger sync |
| Upstream | ChittyEvidence | Evidence facts, documents, entities for case timelines |
| Upstream | ChittyConnect | Inter-service connectivity and discovery |
| Upstream | ChittyRouter | Unified ingestion gateway (scrape, email routing) |
| Upstream | ChittySchema | Canonical schema validation and drift detection |
| Upstream | ChittyCert | Certificate verification |
| Upstream | ChittyRegister | Service registration, beacon, compliance |
| Upstream | ChittyChat | Project/task data API |
| Platform | Cloudflare Workers | Compute runtime |
| Platform | Cloudflare R2 | Document storage |
| Platform | Cloudflare KV | Sync state, auth tokens, service tokens |
| Database | Neon PostgreSQL (via Hyperdrive) | Primary data store (cc_* tables) |

## API Contract

**Base URL**: https://command.chitty.cc

### Core Endpoints
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/health` | GET | No | Health check |
| `/api/v1/status` | GET | No | Service metadata |
| `/api/v1/canon` | GET | No | Canon info and registry status |
| `/api/v1/schema` | GET | No | Lightweight schema references |
| `/api/v1/beacon` | GET | No | Last beacon timestamp/status |
| `/api/v1/cert/verify` | POST | No | Verify a ChittyCert certificate |
| `/api/v1/cert/:id` | GET | No | Get certificate details |
| `/api/v1/whoami` | GET | Bearer | Identity: subject and scopes |
| `/api/v1/context` | GET/POST | Bearer | Get/Set persona, label, and tags |
| `/api/v1/connect/status` | GET | Bearer | ChittyConnect health |
| `/api/v1/connect/discover` | POST | Bearer | Resolve service URL via ChittyConnect |
| `/api/v1/ledger/evidence` | GET | Bearer | List evidence for a case via ChittyLedger |
| `/api/v1/ledger/record-custody` | POST | Bearer | Record custody entry |
| `/api/dashboard/summary` | GET | Bearer | Dashboard summary with urgency scores |
| `/api/accounts` | GET/POST | Bearer | Financial account management |
| `/api/obligations` | GET/POST | Bearer | Bills, debts, recurring obligations |
| `/api/disputes` | GET/POST | Bearer | Active dispute management |
| `/api/legal` | GET/POST | Bearer | Legal deadlines and case data |
| `/api/documents` | GET/POST | Bearer | R2 document management |
| `/api/recommendations` | GET | Bearer | AI action recommendations |
| `/api/sync` | POST | Bearer | Manual data sync trigger |
| `/api/cashflow` | GET | Bearer | Cash flow analysis |
| `/api/v1/timeline/:caseId` | GET | Bearer | Unified case timeline (facts, deadlines, disputes, docs) |
| `/api/v1/litigation/synthesize` | POST | Bearer | AI fact synthesis from raw notes |
| `/api/v1/litigation/synthesize-from-case` | POST | Bearer | AI fact synthesis auto-pulled from ChittyEvidence |
| `/api/v1/litigation/draft` | POST | Bearer | AI email drafting from synthesized facts |
| `/api/v1/litigation/qc` | POST | Bearer | AI risk scan of draft vs source notes |
| `/api/v1/jobs` | GET/POST | Bearer | Scrape job queue management |
| `/api/v1/jobs/:id` | GET | Bearer | Scrape job details |
| `/api/v1/jobs/:id/retry` | POST | Bearer | Retry failed scrape job |
| `/api/v1/jobs/dead-letters` | GET | Bearer | Dead letter queue |
| `/api/bridge/*` | Various | Service/Bearer | Inter-service bridge routes |
| `/mcp/*` | Various | Service | MCP server (48 tools across 12 domains) |

### Cron Schedule
| Schedule | Purpose |
|----------|---------|
| Daily 6 AM CT | Plaid + ChittyFinance sync |
| Daily 7 AM CT | Court docket check |
| Weekly Mon 8 AM CT | Utility scrapers |
| Monthly 1st 9 AM CT | Mortgage, property tax |

## Ownership

| Role | Owner |
|------|-------|
| Service Owner | ChittyOS |
| Technical Lead | @chittyos-infrastructure |
| Contact | chittycommand@chitty.cc |

## Three Aspects (TY VY RY)

Source: `chittycanon://gov/governance#three-aspects`

| Aspect | Abbrev | Question | ChittyCommand Answer |
|--------|--------|----------|--------------------|
| **Identity** | TY | What IS it? | Unified life management dashboard — ingests financial, legal, and administrative data from 15+ sources, scores urgency, recommends and executes actions |
| **Connectivity** | VY | How does it ACT? | Cron-scheduled syncs (Plaid, Mercury, court dockets, utilities); bridge API to ChittyScrape, ChittyLedger, ChittyFinance; MCP server for Claude-driven queries; action execution via API, email, or browser automation |
| **Authority** | RY | Where does it SIT? | Tier 5 Application — consumer of upstream data, not source of truth; delegates scraping to ChittyScrape, identity to ChittyID, financials to ChittyFinance |

## Document Triad

This charter is part of a synchronized documentation triad. Changes to shared fields must propagate.

| Field | Canonical Source | Also In |
|-------|-----------------|---------|
| Canonical URI | CHARTER.md (Classification) | CHITTY.md (blockquote) |
| Tier | CHARTER.md (Classification) | CHITTY.md (blockquote) |
| Domain | CHARTER.md (Classification) | CHITTY.md (blockquote), CLAUDE.md (header) |
| Endpoints | CHARTER.md (API Contract) | CHITTY.md (Endpoints table), CLAUDE.md (API section) |
| Dependencies | CHARTER.md (Dependencies) | CLAUDE.md (Architecture) |
| Certification badge | CHITTY.md (Certification) | CHARTER.md frontmatter `status` |

**Related docs**: [CHITTY.md](CHITTY.md) (badge/one-pager) | [CLAUDE.md](CLAUDE.md) (developer guide)

## Compliance

- [x] Service registered in ChittyRegister (03-1-USA-3846-T-2602-0-57, pending_cert)
- [x] Health endpoint operational at /health
- [x] Status endpoint operational at /api/v1/status
- [x] CLAUDE.md development guide present
- [x] CHARTER.md present
- [x] CHITTY.md present

---
*Charter Version: 1.2.0 | Last Updated: 2026-03-24*
