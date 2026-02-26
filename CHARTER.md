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
---

# ChittyCommand Charter

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
- MCP server for Claude-driven dashboard queries

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
| Upstream | ChittyConnect | Inter-service connectivity |
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
| `/api/dashboard/summary` | GET | Bearer | Dashboard summary with urgency scores |
| `/api/accounts` | GET/POST | Bearer | Financial account management |
| `/api/obligations` | GET/POST | Bearer | Bills, debts, recurring obligations |
| `/api/disputes` | GET/POST | Bearer | Active dispute management |
| `/api/legal` | GET/POST | Bearer | Legal deadlines and case data |
| `/api/documents` | GET/POST | Bearer | R2 document management |
| `/api/recommendations` | GET | Bearer | AI action recommendations |
| `/api/sync` | POST | Bearer | Manual data sync trigger |
| `/api/cashflow` | GET | Bearer | Cash flow analysis |
| `/api/bridge/*` | Various | Service/Bearer | Inter-service bridge routes |
| `/mcp/*` | Various | Service | MCP server for Claude integration |

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
*Charter Version: 1.0.0 | Last Updated: 2026-02-23*
