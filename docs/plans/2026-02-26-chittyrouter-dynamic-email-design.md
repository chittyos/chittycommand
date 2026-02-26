# ChittyRouter Dynamic Email Connections — Design

> **Note:** This design doc lives in the ChittyCommand repo for convenience. The implementation targets the ChittyRouter repo at `/Users/nb/Desktop/Projects/github.com/CHITTYOS/chittyrouter/`.

## Context

ChittyRouter is the AI-powered email gateway for ChittyOS (Tier 2, `router.chitty.cc`). It handles:
- Cloudflare Email Routing on `*@chitty.cc` with AI triage
- Gmail API monitoring for 3 hardcoded accounts via OAuth + 1Password
- Token refresh via `gmail-token-manager.js`
- Address routing map in `cloudflare-email-handler.js` (hardcoded)
- `/email/urgent` endpoint consumed by ChittyCommand daily cron

**Problem:** All Gmail accounts, email routing rules, and OAuth configs are hardcoded. ChittyCommand just shipped email connection management (migration 0009, API routes, Settings UI) but needs ChittyRouter to accept dynamic account registration and namespace-based routing.

## Goal

Make ChittyRouter's email pipeline dynamic so ChittyCommand can:
1. Register Gmail accounts via OAuth (multiple per user)
2. Map user namespaces (`nick@chitty.cc`) to user IDs for email routing
3. Trigger on-demand syncs for specific accounts
4. Filter `/email/urgent` by user

## Changes

### 1. `src/email/inbox-monitor.js` — KV-backed account list

Replace `getConfiguredInboxes()` hardcoded array (lines 73-78) with KV read:
- Read `gmail:accounts` from `AI_CACHE` KV → JSON array of account configs
- Each account: `{ name, email, user_id, connect_ref, type: 'gmail' }`
- Fallback to existing hardcoded list if KV is empty (backward-compatible)
- The `handleScheduledMonitoring` cron continues as-is, just iterating the dynamic list

### 2. `src/email/gmail-token-manager.js` — Dynamic account registration

Replace hardcoded `this.accounts` (lines 14-30) with KV-backed lookup:
- `getAccountConfig(name)` reads `gmail:account:{name}` from KV
- Fallback to hardcoded accounts for existing 3 if KV miss
- New method: `registerAccount(name, config)` writes to KV
- Token storage unchanged: `gmail_token_{name}` in KV with 1h TTL
- For dynamic accounts: fetch credentials from ChittyConnect via `connect_ref` instead of hardcoded `opPath`

### 3. `src/email/cloudflare-email-handler.js` — KV-based address routing

Replace hardcoded `this.addressRoutes` (lines 24-32) with two-tier lookup:
1. **System addresses** — keep hardcoded for `legal@`, `intake@`, `evidence@`, etc.
2. **User namespaces** — on email arrival, extract local part → check `email:namespace:{local}` in KV → resolve `user_id`
3. If namespace match: tag email with `user_id` through triage pipeline
4. If no match: fall through to system address routes, then catch-all

### 4. `src/unified-worker.js` — New endpoints

Add 4 new routes to the `RouteMultiplexer`:

**`POST /auth/gmail/connect`**
- Input: `{ user_id, callback_url }`
- Generates Google OAuth consent URL with `gmail.readonly` scope
- Returns: `{ auth_url }`

**`GET /auth/gmail/callback`**
- Handles Google OAuth redirect
- Exchanges code for tokens
- Stores tokens in ChittyConnect (via `connect_ref`)
- Registers account in `gmail:accounts` KV
- Redirects to `callback_url` with `connect_ref` + `email_address` params

**`POST /api/namespace-sync`**
- Input: `{ namespace, user_id }`
- Writes `email:namespace:{namespace}` → `{ user_id, created_at }` to KV
- Auth: service token from ChittyCommand

**`POST /email/sync`**
- Input: `{ connect_ref, user_id }`
- Triggers immediate Gmail fetch for that specific account
- Returns: `{ messages_fetched, urgent_count }`

### 5. Per-user `/email/urgent`

Modify existing `handleUrgentEmails` handler:
- Add optional `?user_id=` query parameter
- If present: filter `email_urgent_items` by user attribution
- If absent: return all (backward-compatible)

## KV Key Schema (all in existing `AI_CACHE` namespace)

| Key | Value | TTL |
|-----|-------|-----|
| `gmail:accounts` | JSON array of `{ name, email, user_id, connect_ref }` | none |
| `gmail:account:{name}` | Single account config object | none |
| `email:namespace:{local}` | `{ user_id, created_at }` | none |
| `gmail_token_{name}` | OAuth token data (existing) | 1h |

## Auth for new endpoints

- Service token check: `Authorization: Bearer {token}` validated against `env.CHITTYCONNECT_TOKEN`
- `X-Source-Service: chittycommand` header for audit trail
- OAuth callback is unauthenticated (Google redirects to it) but includes state parameter for CSRF protection

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/email/inbox-monitor.js` | Modify | KV-backed account list, fallback to hardcoded |
| `src/email/gmail-token-manager.js` | Modify | Dynamic account registration, ChittyConnect credential fetch |
| `src/email/cloudflare-email-handler.js` | Modify | KV namespace lookup for user routing |
| `src/unified-worker.js` | Modify | Add 4 new endpoints + per-user `/email/urgent` filter |

## Implementation Order

1. `gmail-token-manager.js` — dynamic account config from KV (backward-compatible)
2. `inbox-monitor.js` — KV-backed account list
3. `cloudflare-email-handler.js` — namespace-based routing
4. `unified-worker.js` — new endpoints
5. `unified-worker.js` — per-user `/email/urgent` filter
6. Deploy + test end-to-end with ChittyCommand
