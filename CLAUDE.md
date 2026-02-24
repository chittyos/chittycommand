# CLAUDE.md

## Project Overview

ChittyCommand is a unified life management and action dashboard for the ChittyOS ecosystem. It ingests data from 15+ financial, legal, and administrative sources, scores urgency with AI, recommends actions, and executes them via APIs, email, or browser automation.

**Repo:** `CHITTYOS/chittycommand`
**Deploy:** Cloudflare Workers at `command.chitty.cc`
**Stack:** Hono TypeScript, React + Tailwind, Neon PostgreSQL (via Hyperdrive), Cloudflare R2/KV
**Canonical URI:** `chittycanon://core/services/chittycommand` | Tier 5

## Common Commands

```bash
npm run dev          # Start Hono dev server (wrangler dev)
npm run deploy       # Deploy to Cloudflare Workers
npm run ui:dev       # Start React frontend dev server (localhost:5173)
npm run ui:build     # Build frontend for Pages
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Run Drizzle migrations
```

Secrets are managed via wrangler (never hardcode):
```bash
wrangler secret put PLAID_CLIENT_ID
wrangler secret put PLAID_SECRET
wrangler secret put DATABASE_URL
```

## Architecture

Single Cloudflare Worker (`chittycommand`) serving API + cron. Frontend is a separate React SPA at `app.command.chitty.cc` (Cloudflare Pages).

### Data Sources

**Via ChittyFinance (auto-sync):** Mercury, Wave Accounting, Stripe, Plaid
**Direct API:** ChittyBooks, ChittyAssets, ChittyCharge, ChittyLedger
**Via ChittyScrape (bridge):** Mr. Cooper mortgage, Cook County property tax, Court docket
**Email Parse:** ComEd, Peoples Gas, Xfinity, Citi, Home Depot, Lowe's
**Manual:** IRS quarterly, HOA fees, Personal loans
**Historical Only:** DoorLoop (sunset, data archived)

### Auth Flow

Three auth layers in `src/middleware/auth.ts`:
1. **`authMiddleware`** (`/api/*`) — KV token lookup, then ChittyAuth fallback
2. **`bridgeAuthMiddleware`** (`/api/bridge/*`) — Service token OR user token
3. **`mcpAuthMiddleware`** (`/mcp/*`) — Shared service token from KV (bypassed in dev)

### Cron Schedule

Defined in `wrangler.toml`, dispatched via `src/lib/cron.ts`:
- `0 12 * * *` — Daily 6 AM CT: Plaid + ChittyFinance sync
- `0 13 * * *` — Daily 7 AM CT: Court docket check
- `0 14 * * 1` — Weekly Mon 8 AM CT: Utility scrapers
- `0 15 1 * *` — Monthly 1st 9 AM CT: Mortgage, property tax

### Database

Neon PostgreSQL via Hyperdrive binding. All tables prefixed `cc_`. Schema in `src/db/schema.ts`, SQL migrations in `migrations/` (0001-0007).

### Action Execution

Three modes:
1. **API** — Mercury transfers, Stripe payments via bridge routes
2. **Claude in Chrome** — Browser automation for portals without APIs
3. **Email** — Dispute letters, follow-ups via Cloudflare Email Workers

## Key Files

- `src/index.ts` — Hono entry point, route mounting, health/status endpoints
- `src/middleware/auth.ts` — Auth middleware (user, bridge, MCP)
- `src/lib/cron.ts` — Cron sync orchestrator (all data sources)
- `src/lib/integrations.ts` — Service clients (Mercury, Plaid, ChittyScrape, etc.)
- `src/lib/urgency.ts` — Deterministic urgency scoring engine
- `src/lib/validators.ts` — Zod schemas for request validation
- `src/routes/bridge.ts` — Inter-service bridge (scrape, ledger, finance, Plaid)
- `src/routes/mcp.ts` — MCP server for Claude integration
- `src/routes/dashboard.ts` — Dashboard summary with urgency scoring
- `src/db/schema.ts` — Drizzle schema for all cc_* tables
- `migrations/` — SQL migration files (0001-0007)
- `ui/` — React frontend (Vite + Tailwind)

## Security

- Credentials via 1Password (`op run`) — never expose in terminal output
- Secrets via `wrangler secret put` — never in `[vars]`
- R2 for document storage (zero egress)
- CORS restricted to `app.command.chitty.cc`, `command.mychitty.com`, `chittycommand-ui.pages.dev`, `localhost:5173`
- Service tokens stored in KV: `bridge:service_token`, `mcp:service_token`, `scrape:service_token`
