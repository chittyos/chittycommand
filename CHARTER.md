---
uri: chittycanon://docs/ops/policy/chittycommand-charter
namespace: chittycanon://docs/ops
type: policy
version: 1.0.0
status: DRAFT
registered_with: chittycanon://core/services/canon
title: "ChittyCommand Charter"
certifier: chittycanon://core/foundation/mychitty-vault
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
- **Tier**: 2 (Platform) with Tier-5 dashboard surface
- **Organization**: CHITTYOS
- **Domain**: command.chitty.cc

Per [ADR-001](docs/architecture/ADR-001-meta-orchestrator-extension.md), ChittyCommand is reclassified from Tier 5 Application to **Tier 2 (Platform) with Tier-5 dashboard surface**. The platform tier covers the meta-orchestrator (`meta/`), executor registry, sovereignty gate, and cluster daemon (`daemon/`). The Tier-5 surface is the existing user-facing dashboard + ActionAgent + MCP at `command.chitty.cc`.

Deployment artifacts split across two runtimes (see Cluster Runtime section below):
- **Cloudflare Worker** (`src/`, `meta/` HTTP routes, dashboard, ActionAgent, MCP): the Tier-5 surface and the meta-orchestrator's request-handling plane run from the same Worker at `command.chitty.cc`.
- **Persistent daemon** (`daemon/`): the cluster leader / intent dispatcher does **not** run as a Worker. It is supervised as a launchd (macOS) / systemd (Linux) process on ChittyServ nodes and connects to the same Neon DB as the Worker.

The dashboard is one consumer of the platform among many.

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
| Upstream | ChittyConnect | Inter-service connectivity and discovery; **forever-context** read/write via ContextConsciousness + MemoryCloude; **sensitive-intent secret brokerage** path for all credential access (no inline secrets) |
| Upstream | ChittyRouter | Unified ingestion gateway (scrape, email routing) |
| Upstream | ChittySchema | Canonical schema validation and drift detection |
| Upstream | ChittyCert | Certificate verification |
| Upstream | ChittyRegister | Service registration, beacon, compliance |
| Upstream | ChittyChat | Project/task data API |
| Upstream | ChittyTrust | Sovereignty gate — trust score / autonomy assessment for actor + intent (`meta/sovereignty.ts`) |
| Upstream | ChittyID | Identity minting — service ChittyID (re-mint pending: P-Synthetic) and per-node L-type IDs for cluster nodes |
| Upstream | chittyagent-orchestrator | Intent routing + cross-channel fanout via `POST agent.chitty.cc/agent/message` |
| Upstream | chittyagent-tasks | Durable distributed task queue pattern reused for intent dispatch + `node_leases` (mirrors `task_leases`) |
| Upstream | chittyagent-ch1tty | MCP portal / OAuth gateway — `command` listed as upstream in `AGENT_MCP_UPSTREAMS` |
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
| `/api/v1/intents/:id/execute` | POST | Bearer | Dispatch a queued Intent through the executor registry (sovereignty re-checked at executor entry) |
| `/mcp/*` | Various | Service | MCP server (50 tools across 12 domains) |

### Executor Registry

Canonical URI namespace: `chittycanon://core/services/chittycommand/executors/{intent_type}`

Executors self-register at module load (side-effect imports from `meta/executors/index.ts`). The dispatcher (`meta/executors/dispatch.ts`) looks executors up by `intent_type`; absence is a wiring bug, not a runtime error. Per ADR-001, the sovereignty gate (`meta/sovereignty.ts`) is invoked at executor entry and re-reckoned if the persisted snapshot is older than the configured freshness window.

| `intent_type` | Canonical URI | Notes |
|---------------|---------------|-------|
| `update_obligation_status` | `chittycanon://core/services/chittycommand/executors/update_obligation_status` | Real Neon write to `cc_obligations`. Source: `meta/executors/update-obligation-status.ts` |

> **Future executors** (e.g. `mercury_payment` — 🔒 REAL-MONEY, will require fresh `autonomous` sovereignty assessment and an enforced USD 500 per-intent cap) are tracked in ADR-001 but are NOT yet registered in `meta/executors/index.ts`. They will be added in follow-up PRs and listed here at the same time the executor file is committed. This table is the authoritative list of currently-registered executors — do not document executors that do not exist.

### Cluster Runtime

Per [ADR-001](docs/architecture/ADR-001-meta-orchestrator-extension.md), the persistent cluster daemon (`daemon/`) is **not** a Cloudflare Worker. It runs as a supervised long-lived process on each ChittyServ cluster node:

- **Hosts**: `chittymini-01..06` (Mac Mini 2012 homelab) + `chittyserv-vm`
- **Supervision**: launchd on macOS Minis, systemd on Ubuntu Minis + VM
- **Leader election**: Float-free across cluster via Neon `node_leases` (atomic `UPDATE ... RETURNING`, mirrors `task_leases` shape)
- **Loop**: claim → execute (via the same `meta/executors/*` registry the Worker uses) → heartbeat → release
- **Neon-loss fallback**: Park the node (MVP) — avoids split-brain; LAN gossip is a follow-up

**Channel registration** for cluster nodes is explicitly **out of scope for the main ChittyRegister service payload**. Each node mints its own L-type ChittyID and registers as a **sub-channel** via `POST agent.chitty.cc/api/v1/channels` (per the ADR-001 preferred path). A future ChittyRegister submission for `chittycommand` must NOT attempt to model the cluster daemon as Worker compute, additional routes, or service bindings — the daemon is a peer execution surface to the Worker, not part of its deploy artifact.

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
| **Authority** | RY | Where does it SIT? | Tier 2 (Platform) with Tier-5 dashboard surface — sovereign meta-orchestrator that enforces trust gates on intent execution, dispatches actions across registered executors and channels, and ingests from 15+ upstreams. Source of truth for: intent ladder (`cc_intents`), executor registry, sovereignty assessments, cluster node leases. Still delegates: identity to ChittyID, browser scraping to ChittyScrape, financial aggregation to ChittyFinance, forever-context storage to ChittyConnect (ContextConsciousness + MemoryCloude). |

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

- [x] Service registered in ChittyRegister (03-1-USA-3846-T-2602-0-57, pending_cert) — ⚠️ **DEPRECATED PENDING RE-MINT** (see below)
- [x] Health endpoint operational at /health
- [x] Status endpoint operational at /api/v1/status (reflects Tier 2 + meta endpoints)
- [x] CLAUDE.md development guide present
- [x] CHARTER.md present
- [x] CHITTY.md present
- [ ] **ChittyID re-mint required (operator action, blocks Tier 2 ChittyCertify).** The currently registered ChittyID `03-1-USA-3846-T-2602-0-57` encodes type `T` (Thing). Per `chittycanon://gov/governance#core-types` and the global "actors with agency are always Person" rule, a sovereign meta-orchestrator that takes autonomous action (intent execution, sovereignty enforcement, channel fanout) is a **Person — Synthetic** (P-Synthetic), not a Thing. A new ChittyID must be minted as `VV-G-USA-NNNN-P-YM-S-X` (T-slot = `P`, subtype Synthetic) and the registry record updated. The existing T-type ID is retained for historical lookup only and must NOT be cited as the service identity in new code, telemetry, or downstream contracts after the re-mint. **Blocks**: formal ChittyCertify at Tier 2; sovereign-intent signing; ChittyTrust score binding for the service-as-actor.
- [ ] Real-dependency `/health` probes (db / chittyconnect / daemon-heartbeat) — tracked in a separate PR; not in this docs PR.
- [ ] Service-level `tail_consumers` wiring (`chittytrack`) — tracked in a separate observability PR; not in this docs PR.

---
*Charter Version: 1.3.0 | Last Updated: 2026-06-04*
