---
uri: chittycanon://docs/ops/summary/chittycommand
namespace: chittycanon://docs/ops
type: architecture
version: 1.0.0
status: DRAFT
registered_with: chittycanon://core/services/canon
title: "ChittyCommand"
certifier: chittycanon://core/services/chittycertify
visibility: PUBLIC
context_brief: chittycontext://persistent-brief
discovery_refs:
  - chittycanon://gov/governance
  - chittycanon://docs/tech/spec/context-schema
  - chittycanon://specs/chittydna-session-governance
---

# ChittyCommand

> `chittycanon://core/services/chittycommand` | Tier 2 (Platform) with Tier-5 dashboard surface | command.chitty.cc

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

## What It Does

Unified life management dashboard that ingests data from 15+ financial, legal, and administrative sources, scores urgency with AI, recommends actions, and executes them via APIs, email, or browser automation.

## Architecture

> **Constraint**: All ChittyCommand UI components must explicitly render their canonical provenance, including the Owning Service, Source Table, and Canonical ID. Any data mutation must be routed through the Ch1tty pilot layer to the appropriate bedrock service.

Cloudflare Worker at command.chitty.cc with Neon PostgreSQL via Hyperdrive, R2 for document storage, and KV for sync state. Cron-triggered data ingestion from Mercury, Plaid, ChittyFinance, ChittyScrape, and more. React SPA frontend at app.command.chitty.cc. MCP server for Claude-driven queries.

### Stack
- **Runtime**: Cloudflare Workers + Hono
- **Frontend**: React SPA (Cloudflare Pages at app.command.chitty.cc)
- **Database**: Neon PostgreSQL (via Hyperdrive, cc_* tables)
- **Storage**: R2 for documents, KV for sync state and auth tokens
- **AI**: Urgency scoring engine

### Data Sources
| Category | Sources |
|----------|---------|
| Financial (auto-sync) | Mercury, Stripe, Plaid, ChittyFinance |
| Direct API | ChittyBooks, ChittyAssets, ChittyCharge, ChittyLedger, ChittyEvidence |
| Scrape (via ChittyScrape) | Mr. Cooper mortgage, Cook County property tax, Court docket |
| Email Parse | ComEd, Peoples Gas, Xfinity, Citi, Home Depot, Lowe's |

### Cron Schedule
| Schedule | Purpose |
|----------|---------|
| Daily 6 AM CT | Plaid + ChittyFinance sync |
| Daily 7 AM CT | Court docket check |
| Weekly Mon 8 AM CT | Utility scrapers |
| Monthly 1st 9 AM CT | Mortgage, property tax |

## Three Aspects (TY VY RY)

Source: `chittycanon://gov/governance#three-aspects`

| Aspect | Abbrev | Answer |
|--------|--------|--------|
| **Identity** | TY | Unified life management dashboard — ingests financial, legal, and administrative data from 15+ sources, scores urgency, recommends and executes actions |
| **Connectivity** | VY | Cron-scheduled syncs (Plaid, Mercury, court dockets, utilities); bridge API to ChittyScrape, ChittyLedger, ChittyFinance; MCP server for Claude-driven queries; action execution via API, email, or browser automation |
| **Authority** | RY | Tier 2 (Platform) with Tier-5 dashboard surface — sovereign meta-orchestrator that enforces trust gates on intent execution, dispatches actions across registered executors and channels, and ingests from 15+ upstreams. Source of truth for: intent ladder (`cc_intents`), executor registry, sovereignty assessments, cluster node leases. Still delegates: identity to ChittyID, browser scraping to ChittyScrape, financial aggregation to ChittyFinance, forever-context storage to ChittyConnect (ContextConsciousness + MemoryCloude). _Canonical source: [CHARTER.md](CHARTER.md#three-aspects-ty-vy-ry)._ |

## ChittyOS Ecosystem

### Certification
- **Badge**: --
- **Certifier**: ChittyCertify (`chittycanon://core/services/chittycertify`)
- **Last Certified**: --

### ChittyDNA
- **ChittyID**: --
- **DNA Hash**: --
- **Lineage**: root (life management)

### Ecosystem Position

- **Upstream**: ChittyAuth, ChittyTrust, ChittyID, ChittyConnect (ContextConsciousness + MemoryCloude + sensitive-intent secret brokerage), chittyagent-orchestrator (routing + channel fanout), chittyagent-tasks (queue + lease pattern), chittyagent-ch1tty (MCP portal/OAuth), ChittyFinance, ChittyBooks, ChittyAssets, ChittyCharge, ChittyScrape, ChittyLedger, ChittyEvidence, ChittyRouter, ChittySchema, ChittyCert, ChittyRegister, ChittyChat.
- **Downstream / sub-channels**: ChittyServ cluster nodes (`chittymini-01..06`, `chittyserv-vm`) — each runs a supervised `daemon/` process and registers as an L-type sub-channel via `agent.chitty.cc/api/v1/channels`. ActionAgent (chat surface) and dashboard SPA at `app.command.chitty.cc` are sibling consumers of the same `meta/executors/*` registry.

### Dependencies

See [CHARTER.md](CHARTER.md) (Dependencies section) — canonical source for the full dependency graph.

### Endpoints
| Path | Method | Auth | Purpose |
|------|--------|------|---------|
| `/health` | GET | No | Health check |
| `/api/v1/status` | GET | No | Service metadata |
| `/api/v1/canon` | GET | No | Canon info and registry status |
| `/api/v1/schema` | GET | No | Lightweight schema references |
| `/api/v1/beacon` | GET | No | Last beacon timestamp/status |
| `/api/v1/whoami` | GET | Bearer | Identity: subject and scopes |
| `/api/v1/context` | GET/POST | Bearer | Get/Set persona, label, and tags |
| `/api/v1/context/global` | GET/POST | Bearer (admin) | Get/Set global context for shared clients |
| `/api/v1/connect/status` | GET | Bearer | Check ChittyConnect health |
| `/api/v1/connect/discover` | POST | Bearer | Resolve service URL via ChittyConnect |
| `/api/v1/ledger/evidence` | GET | Bearer | List evidence for a case_id via ChittyLedger |
| `/api/v1/ledger/record-custody` | POST | Bearer | Record custody entry for an evidence_id |
| `/api/v1/cert/verify` | POST | No | Verify a ChittyCert certificate ID |
| `/api/v1/cert/:id` | GET | No | Get certificate details by ID |
| `/api/dashboard/summary` | GET | Bearer | Dashboard summary with urgency scores |
| `/api/accounts` | GET/POST | Bearer | Financial account management |
| `/api/obligations` | GET/POST | Bearer | Bills, debts, recurring obligations |
| `/api/disputes` | GET/POST | Bearer | Active dispute management |
| `/api/legal` | GET/POST | Bearer | Legal deadlines and case data |
| `/api/recommendations` | GET | Bearer | AI action recommendations |
| `/api/cashflow` | GET | Bearer | Cash flow analysis and projections |
| `/api/queue` | GET/POST | Bearer | Swipe-based action queue |
| `/api/payment-plan` | GET/POST | Bearer | Payment plan management |
| `/api/revenue` | GET | Bearer | Revenue tracking |
| `/api/email-connections` | GET/POST | Bearer | Email connection management |
| `/api/chat` | POST | Bearer | AI chat interface |
| `/auth/*` | Various | No | Login/verify flows |
| `/api/bridge/*` | Various | Service | Inter-service bridge routes |
| `/api/bridge/credentials/get` | POST | Service | Allowlisted credential proxy via ChittyConnect |
| `/api/v1/timeline/:caseId` | GET | Bearer | Unified case timeline (facts, deadlines, disputes, docs) |
| `/api/v1/litigation/synthesize` | POST | Bearer | AI fact synthesis from raw notes |
| `/api/v1/litigation/synthesize-from-case` | POST | Bearer | AI fact synthesis from ChittyEvidence |
| `/api/v1/litigation/draft` | POST | Bearer | AI email drafting from synthesized facts |
| `/api/v1/litigation/qc` | POST | Bearer | AI risk scan of draft vs source notes |
| `/api/v1/jobs` | GET/POST | Bearer | Scrape job queue management |
| `/api/v1/jobs/:id` | GET | Bearer | Scrape job details |
| `/api/v1/jobs/:id/retry` | POST | Bearer | Retry failed scrape job |
| `/api/v1/jobs/dead-letters` | GET | Bearer | Dead letter queue |
| `/api/v1/intents/:id/execute` | POST | Bearer | Dispatch a queued Intent through the executor registry (sovereignty re-checked at executor entry) |
| `/mcp/*` | Various | Service | MCP server (50 tools across 12 domains) |

## Document Triad

This badge is part of a synchronized documentation triad. Changes to shared fields must propagate.

| Field | Canonical Source | Also In |
|-------|-----------------|---------|
| Canonical URI | CHARTER.md (Classification) | CHITTY.md (blockquote) |
| Tier | CHARTER.md (Classification) | CHITTY.md (blockquote) |
| Domain | CHARTER.md (Classification) | CHITTY.md (blockquote), CLAUDE.md (header) |
| Endpoints | CHARTER.md (API Contract) | CHITTY.md (Endpoints table), CLAUDE.md (API section) |
| Dependencies | CHARTER.md (Dependencies) | CLAUDE.md (Architecture) |
| Certification badge | CHITTY.md (Certification) | CHARTER.md frontmatter `status` |

**Related docs**: [CHARTER.md](CHARTER.md) (charter/policy) | [CLAUDE.md](CLAUDE.md) (developer guide)
