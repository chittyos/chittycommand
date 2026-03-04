# GitHub Copilot Instructions — ChittyCommand

## Project Overview

ChittyCommand is a unified life management and action dashboard for the ChittyOS ecosystem. It ingests data from 15+ financial, legal, and administrative sources, scores urgency with AI, recommends actions, and executes them via APIs, email, or browser automation.

- **Repo:** `CHITTYOS/chittycommand`
- **Deploy:** Cloudflare Workers at `command.chitty.cc`
- **Stack:** Hono (TypeScript), React + Tailwind (frontend), Neon PostgreSQL via Hyperdrive, Cloudflare R2/KV
- **Canonical URI:** `chittycanon://core/services/chittycommand` | Tier 5

## Common Commands

```bash
npm run dev          # Start Hono dev server (wrangler dev)
npm run build        # Typecheck (tsc --noEmit)
npm run test         # Run Vitest tests
npm run deploy       # Deploy to Cloudflare Workers
npm run ui:dev       # Start React frontend (localhost:5173)
npm run ui:build     # Build frontend for Cloudflare Pages
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Run Drizzle migrations
```

Secrets are managed via `wrangler secret put` — **never hardcode** them:

```bash
wrangler secret put PLAID_CLIENT_ID
wrangler secret put PLAID_SECRET
wrangler secret put DATABASE_URL
```

## Architecture

Single Cloudflare Worker serving API + scheduled cron jobs. Frontend is a separate React SPA (Cloudflare Pages) at `app.command.chitty.cc`.

### Key Files

- `src/index.ts` — Hono app entry point, route mounting, CORS, error handler
- `src/middleware/auth.ts` — Three auth middlewares: `authMiddleware`, `bridgeAuthMiddleware`, `mcpAuthMiddleware`
- `src/db/schema.ts` — Drizzle ORM schema (all tables prefixed `cc_`)
- `src/lib/cron.ts` — Cron sync orchestrator
- `src/lib/integrations.ts` — Service clients (Mercury, Plaid, ChittyScrape, etc.)
- `src/lib/urgency.ts` — Deterministic urgency scoring (0–100)
- `src/lib/validators.ts` — Zod schemas for all request validation
- `src/routes/` — Route handlers (one file per domain)
- `src/routes/bridge/` — Inter-service bridge routes
- `src/routes/mcp.ts` — MCP server (28 tools for Claude integration)
- `migrations/` — SQL migration files (0001–0007)
- `ui/` — React frontend (Vite + Tailwind)

## Code Conventions

### TypeScript

- Strict mode is enabled (`"strict": true`). No `any` unless explicitly cast.
- Target: `ES2022`. Module resolution: `bundler`.
- All Hono apps/routes are typed: `new Hono<{ Bindings: Env; Variables: AuthVariables }>()`.
- Import `AuthVariables` from `src/middleware/auth.ts` for route-level context variables.
- Use `c.set('userId', ...)` and `c.get('userId')` for auth context in middleware and handlers.

### Database (Drizzle ORM)

- All tables are prefixed `cc_` (e.g., `cc_accounts`, `cc_obligations`).
- Use `uuid` PKs with `.defaultRandom()`.
- Always include `createdAt` and `updatedAt` timestamps with `{ withTimezone: true }`.
- Add `index()` on columns used in WHERE/ORDER BY clauses.
- Monetary values use `numeric` with `{ precision: 12, scale: 2 }`.
- Use `jsonb` for flexible metadata fields, default to `{}` or `[]`.
- Import `getDb` from `src/lib/db.ts` to get a database connection.

### Validation (Zod)

- Define all Zod schemas in `src/lib/validators.ts`.
- Use `@hono/zod-validator` with `zValidator('json', schema)` for request body validation.
- Validate query params with `zValidator('query', schema)`.
- Date strings must match `/^\d{4}-\d{2}-\d{2}$/` (YYYY-MM-DD).
- UUID fields use `z.string().uuid()`.

### Routing (Hono)

- Create one route file per domain in `src/routes/`.
- Export a named `const xxxRoutes = new Hono()` from each file.
- Mount routes in `src/index.ts` using `app.route('/api/xxx', xxxRoutes)`.
- Apply auth middleware at mount time in `src/index.ts`, not inside route files.
- Always return `c.json(...)` — never return raw strings or untyped responses.

### Error Handling

- Use the global error handler in `src/index.ts` for unhandled errors — it returns `{ error: 'Internal Server Error' }`, never leaking internals.
- Return `c.json({ error: '...' }, 4xx)` for expected client errors.
- Catch fetch errors in try/catch; fall through gracefully rather than bubbling errors.

## Auth Patterns

Three auth layers — **do not bypass or modify without security review**:

1. **`authMiddleware`** (`/api/*`) — KV token lookup, then ChittyAuth fallback. Sets `userId` and `scopes`.
2. **`bridgeAuthMiddleware`** (`/api/bridge/*`) — KV service token (`bridge:service_token`) OR user token.
3. **`mcpAuthMiddleware`** (`/mcp/*`) — ChittyAuth token first, KV service token fallback (`mcp:service_token`). Bypassed in non-production environments.

Access auth context in handlers via `c.get('userId')` and `c.get('scopes')`.

## Security Requirements

- **Never hardcode** secrets, tokens, API keys, or credentials anywhere in source code.
- All secrets go through `wrangler secret put` — never in `[vars]` in `wrangler.toml`.
- KV service tokens: `bridge:service_token`, `mcp:service_token`, `scrape:service_token`.
- CORS is restricted to approved origins: `app.command.chitty.cc`, `command.mychitty.com`, `chittycommand-ui.pages.dev`, `localhost:5173`.
- Credentials use 1Password (`op run`) in local development — never expose in terminal output or logs.
- Error responses must **not** leak internal error messages, stack traces, or sensitive data.
- All user input must be validated with Zod before use.
- Use `X-Source-Service: chittycommand` header on all outbound service calls.

## Environment Bindings (Cloudflare Workers)

Available via `c.env` in route handlers and middleware:

| Binding | Type | Purpose |
|---------|------|---------|
| `HYPERDRIVE` | Hyperdrive | Neon PostgreSQL connection |
| `DOCUMENTS` | R2Bucket | Document storage |
| `COMMAND_KV` | KVNamespace | Auth tokens, sync state, service tokens |
| `AI` | Ai | Cloudflare AI Gateway |
| `ENVIRONMENT` | string | `"production"` or `"development"` |
| `CHITTYAUTH_URL` | string | ChittyAuth service URL |
| `CHITTYLEDGER_URL` | string | ChittyLedger service URL |
| `CHITTYFINANCE_URL` | string | ChittyFinance service URL |
| `CHITTYSCRAPE_URL` | string | ChittyScrape service URL |
| `CHITTYCONNECT_URL` | string | ChittyConnect service URL |
| `PLAID_CLIENT_ID` | string (secret) | Plaid API key |
| `PLAID_SECRET` | string (secret) | Plaid API secret |

Always check if optional URL bindings are present before using them (e.g., `if (c.env.CHITTYAUTH_URL)`).

## Cron Schedule

Defined in `wrangler.toml` and dispatched via `src/lib/cron.ts`:

| Schedule | Purpose |
|----------|---------|
| `0 12 * * *` | Daily 6 AM CT: Plaid + ChittyFinance sync |
| `0 13 * * *` | Daily 7 AM CT: Court docket check |
| `0 14 * * 1` | Weekly Mon 8 AM CT: Utility scrapers |
| `0 15 1 * *` | Monthly 1st 9 AM CT: Mortgage, property tax |

## MCP Server

The `/mcp` route exposes 28 tools across 8 domains for Claude integration. Tools return structured JSON: `content: [{ type: "json", json: ... }]`. Auth is handled by `mcpAuthMiddleware`. See `src/routes/mcp.ts` for tool definitions.

## Testing

Tests use Vitest. Run with `npm run test`. Test files live alongside source in `src/` or in a `__tests__` directory. The test configuration is in `vitest.config.ts`.

## PR and Review Policy

- One concern area per PR (security, feature, refactor, schema change, governance).
- Every PR must include: scope, risk/blast radius, test evidence, rollback plan, and migration impact.
- Do not bundle governance/ruleset changes with unrelated app logic.
- Resolve must-fix review comments (security, correctness, compliance, merge blockers) before merge.
- Do not weaken auth, CORS, or governance controls.
- Schema changes (`src/db/schema.ts`) require a new SQL migration in `migrations/`.

## ChittyOS Ecosystem Context

ChittyCommand is a **Tier 5 Application** — a consumer of upstream data, not a source of truth. It delegates to:

- **ChittyAuth** — identity and token validation
- **ChittyFinance** — financial data aggregation
- **ChittyScrape** — browser automation for portals without APIs
- **ChittyLedger** — evidence and document ledger
- **ChittyConnect** — inter-service discovery and connectivity
- **ChittySchema** — canonical schema validation
- **ChittyRegister** — service registration and beacon heartbeats
