# Email Account Connections — Design

## Context

ChittyRouter already has production-grade email infrastructure:
- Cloudflare Email Routing on `*@chitty.cc` with AI-powered triage
- Gmail API monitoring for 3 hardcoded accounts via OAuth + 1Password
- Token refresh via `gmail-token-manager.js`
- Address routing map in `cloudflare-email-handler.js` (hardcoded)
- `/email/urgent` endpoint consumed by ChittyCommand daily cron

**What's missing:** Users cannot self-service connect email accounts or manage them from the ChittyCommand dashboard. Everything is hardcoded.

## Goal

Let users connect email accounts to their ChittyCommand dashboard through three paths:
1. **Gmail OAuth** — click "Connect Gmail", authorize read-only access
2. **Email forwarding** — forward bills to `{username}@chitty.cc`
3. **Cloudflare Email Routing** — catch-all on `@chitty.cc` with dynamic user lookup

Support multiple Gmail accounts per user. Multi-user ready.

## Architecture: ChittyRouter-Centric (Approach A)

ChittyRouter owns all email connectivity. ChittyCommand manages connection metadata and triggers syncs.

```
Gmail OAuth:
  User → ChittyCommand UI → "Connect Gmail"
    → redirect to ChittyRouter /auth/gmail/connect?user_id=X
    → Google OAuth consent (gmail.readonly scope)
    → ChittyRouter stores token in ChittyConnect
    → returns connect_ref → saved to cc_email_connections
    → ChittyRouter polls Gmail API per connection on cron
    → parsed bills → /email/urgent?user_id=X

Email Forwarding / Cloudflare Routing:
  User forwards to nick@chitty.cc
    → Cloudflare Email Routing → ChittyRouter email worker
    → Worker looks up "nick" in KV namespace map → resolves user_id
    → AI triage + bill parsing → /email/urgent?user_id=X
```

## Data Model

### New table: `cc_email_connections`

```sql
CREATE TABLE cc_email_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,           -- 'gmail', 'outlook', 'forwarding'
  email_address TEXT NOT NULL,
  display_name TEXT,                -- "Work Gmail", "Personal"
  connect_ref TEXT,                 -- ChittyConnect credential ID (for OAuth)
  namespace TEXT,                   -- username portion of @chitty.cc address
  status TEXT DEFAULT 'pending',    -- 'pending', 'active', 'error', 'disconnected'
  last_synced_at TIMESTAMPTZ,
  error_message TEXT,
  config JSONB DEFAULT '{}',        -- labels to scan, filter rules, etc.
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_cc_email_connections_email ON cc_email_connections(email_address, user_id);
CREATE INDEX idx_cc_email_connections_namespace ON cc_email_connections(namespace);
```

### New table: `cc_user_namespaces`

```sql
CREATE TABLE cc_user_namespaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  namespace TEXT NOT NULL UNIQUE,    -- "nick" → nick@chitty.cc
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## ChittyRouter Changes

### 1. Dynamic Gmail account config
- Replace hardcoded 3-account list in `inbox-monitor.js` with KV-backed config
- Key: `gmail:accounts` → JSON array of `{email, connect_ref, user_id}`
- Token manager reads connect_ref → fetches OAuth token from ChittyConnect

### 2. New endpoint: `POST /auth/gmail/connect`
- Accepts `{user_id, redirect_uri}`
- Initiates Google OAuth flow (gmail.readonly scope)
- On callback: stores tokens in ChittyConnect, returns `connect_ref`
- Registers account in `gmail:accounts` KV

### 3. Per-user `/email/urgent`
- Add optional `?user_id=` query parameter
- Filter items by user attribution from email routing

### 4. Dynamic address routing
- Replace hardcoded `addressRoutes` map with KV lookup
- On email arrival: extract local part → look up in `email:namespace:{local}` KV → get user_id
- ChittyCommand syncs `cc_user_namespaces` to ChittyRouter KV on changes

## ChittyCommand Changes

### 1. Migration 0009
- Create `cc_email_connections` and `cc_user_namespaces` tables

### 2. API routes: `src/routes/email-connections.ts`
```
GET    /api/email-connections          — list user's connections
POST   /api/email-connections/gmail    — initiate Gmail OAuth (redirects to ChittyRouter)
POST   /api/email-connections          — register forwarding connection
DELETE /api/email-connections/:id      — disconnect an account
GET    /api/email-connections/callback — OAuth callback landing
POST   /api/email-connections/sync/:id — trigger manual sync for one connection
```

### 3. Settings UI updates
- "Email Accounts" section in Settings page
- "Connect Gmail" button → OAuth popup/redirect
- Forwarding address display: "Forward bills to nick@chitty.cc"
- Connection list with status, last sync, disconnect button
- Support adding multiple Gmail accounts with display names

### 4. Cron update
- `syncEmailParsedBills()` passes `user_id` to `/email/urgent?user_id=X`
- Or: pull all and attribute by email address match to cc_email_connections

## Credential Flow

```
Gmail OAuth tokens:
  Google → ChittyRouter → ChittyConnect (stores encrypted)
  ChittyRouter reads via connect_ref when polling Gmail API

Forwarding:
  No credentials needed — email arrives at Cloudflare, routed by address
```

Zero credentials stored in ChittyCommand or its database.

## Files Summary

### ChittyCommand (this repo)
| File | Action | Purpose |
|------|--------|---------|
| `migrations/0009_email_connections.sql` | New | Schema for email connections + namespaces |
| `src/routes/email-connections.ts` | New | CRUD + OAuth flow initiation |
| `src/lib/validators.ts` | Modify | Add Zod schemas for email connection endpoints |
| `src/index.ts` | Modify | Mount email-connections routes |
| `ui/src/pages/Settings.tsx` | Modify | Add email accounts management section |
| `ui/src/lib/api.ts` | Modify | Add email connection API methods |

### ChittyRouter (separate repo)
| File | Action | Purpose |
|------|--------|---------|
| `src/email/inbox-monitor.js` | Modify | Config-driven account list from KV |
| `src/email/gmail-token-manager.js` | Modify | Support dynamic account registration |
| `src/email/cloudflare-email-handler.js` | Modify | KV-based address routing |
| `src/unified-worker.js` | Modify | Add /auth/gmail/connect route |

## Implementation Order

1. Migration 0009 (cc_email_connections + cc_user_namespaces)
2. API routes for email connections (ChittyCommand)
3. Settings UI — email accounts section
4. ChittyRouter: dynamic account config + OAuth endpoint
5. ChittyRouter: dynamic address routing
6. Wire cron to pass user_id
7. Test end-to-end: Gmail OAuth + forwarding
