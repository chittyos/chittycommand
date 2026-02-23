# CLAUDE.md

## Project Overview

ChittyCommand is a unified life management and action dashboard for the ChittyOS ecosystem. It ingests data from 15+ financial, legal, and administrative sources, scores urgency with AI, recommends actions, and executes them via APIs, email, or browser automation.

**Repo:** `CHITTYOS/chittycommand`
**Deploy:** Cloudflare Workers + Pages at `command.chitty.cc`
**Stack:** Hono TypeScript, React + Shadcn UI, Neon PostgreSQL, Cloudflare R2

## Common Commands

```bash
npm run dev          # Start Hono dev server (wrangler dev)
npm run deploy       # Deploy to Cloudflare Workers
npm run ui:dev       # Start React frontend dev server
npm run ui:build     # Build frontend for Pages
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Run Drizzle migrations
```

## Architecture

### Workers

| Worker | Domain | Role |
|--------|--------|------|
| command-api | command.chitty.cc | Core API, CRUD, action execution |
| command-ingest | Cron-triggered | Data ingestion from all sources |
| command-ai | Internal | AI triage, urgency scoring, recommendations |
| command-ui | app.command.chitty.cc | React SPA (Cloudflare Pages) |

### Data Sources

**API Sources (auto-sync):** Mercury, Wave, Stripe, TurboTenant, ChittyRental/ChittyFinance
**Email Parse:** ComEd, Peoples Gas, Xfinity, Citi, Home Depot, Lowe's
**Scraper:** Mr. Cooper, Cook County property tax, Court docket
**Manual:** IRS quarterly, HOA fees, Personal loans
**Historical Only:** DoorLoop (sunset, data archived)

### Database

Neon PostgreSQL with `cc_` prefixed tables. Schema in `src/db/schema.ts`, SQL migrations in `migrations/`.

### Action Execution

Three modes:
1. **API** — Mercury transfers, Stripe payments, TurboTenant/ChittyRental
2. **Claude in Chrome** — Browser automation for portals without APIs
3. **Email** — Dispute letters, follow-ups via Cloudflare Email Workers

## Active Disputes

1. **Xfinity** — Pricing/credit dispute (priority 2)
2. **Commodore Green Briar Landmark Condo Association** — HOA dispute (priority 3)
3. **Fox Rental** — $14K+ reclaim (priority 1)

## Key Files

- `src/index.ts` — Hono API entry point
- `src/db/schema.ts` — Drizzle schema for all tables
- `src/lib/urgency.ts` — Deterministic urgency scoring engine
- `src/routes/` — API route handlers
- `migrations/` — SQL migration files
- `ui/` — React frontend

## Security

- Credentials via 1Password (`op run`)
- No hardcoded secrets
- R2 for document storage (zero egress)
- CORS restricted to `app.command.chitty.cc` and localhost
