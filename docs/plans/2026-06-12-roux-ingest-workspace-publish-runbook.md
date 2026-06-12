# Roux Ingest — Workspace Studio publishing runbook (DRAFT / UNCONFIRMED)

> **Status: DRAFT — review artifact, NOT a tested runbook.**
>
> This document was assembled from a repo-derived inventory. **No part of the
> Google-side state below was verified against live Google infrastructure** —
> there is no `gam`, `gcloud`, or Google service-account credential available in
> the environment where this was produced, and the connected Google MCP tools
> are end-user Gmail/Calendar/Drive scopes that cannot enumerate service
> accounts, Marketplace/Add-on listings, or domain-wide delegation grants.
>
> Every value marked `<<PLACEHOLDER: …>>` is **unconfirmed** and must be
> supplied/verified by an operator before anything is run. Do **not** invent
> identifiers, and do **not** copy values out of the test suite — the JWT test
> fixtures are TEST CONSTANTS, not production values.

## Scope of this document

The "Roux Ingest" step is a **Google Workspace Studio custom step** served by
the `chittycommand` Cloudflare Worker. A Gemini-orchestrated Flow routes a Gmail
message → JWT-verified → ChittyRoux privilege/space classification → triage
intent. This runbook covers what is required on the **Google publishing side**
(service account, OAuth client, Marketplace/Add-on listing, domain-wide
delegation) to publish the step so Workspace operators can drop it into a Flow.

It is an **HTTP-mode Workspace Add-on** (no Apps Script project) — see
`src/routes/workspace-studio.ts:5-7`. That fact drives the GAM/Console boundary
below.

## A) Can the Google side be read live? No.

A live Google-side read was **not possible** from the environment that produced
this document. Evidence:

- `command -v gam gamadv-xtd3 gcloud` → none found. `gam version` /
  `gcloud version` → "command not found".
- No Google credentials present: no `~/.gam/`, no `oauth2.txt`,
  `oauth2service.json`, or `client_secrets.json`; `GOOGLE_APPLICATION_CREDENTIALS`
  unset.
- Connected Google MCP tools are end-user Gmail/Calendar/Drive OAuth scopes —
  they cannot enumerate service accounts, Marketplace/Add-on apps, or
  domain-wide delegation.

Therefore the inventory in section B is **repo-derived** (the code is the
contract), and the GAM sequence in section C **could not be dry-run or
validated** — treat it as a review artifact.

## B) Google-side contract (derived from worker code)

The worker enforces the following on inbound Google-signed tokens. These are the
requirements the Google publishing side must satisfy.

| Requirement | Value / pattern | Source |
|---|---|---|
| JWT signing alg | RS256 | `src/lib/workspace-jwt.ts:14,114` |
| JWKS source URL | `https://www.googleapis.com/oauth2/v3/certs` (default; `GCP_JWKS_URL` overrides for tests only) | `workspace-jwt.ts:15,32,59` |
| Allowed `iss` | `https://accounts.google.com` **or** `accounts.google.com` | `workspace-jwt.ts:36,130-138` |
| `systemIdToken.aud` | the **full endpoint URL Google invoked** (NOT the client ID) — pinned to `https://command.chitty.cc/workspace/studio/roux-ingest/execute` | `workspace-jwt.ts:147-169`; `workspace-auth.ts:85`; test `…ingest.spec.ts:132,158-169` |
| `systemIdToken.email` | MUST equal `env.CHITTYROUX_GCP_SA_EMAIL` (the marketplace service account) | `workspace-jwt.ts:164,172-178` |
| `userIdToken.aud` | MUST equal `env.CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_ID` (the add-on's OAuth client ID) | `workspace-jwt.ts:191-199`; test `:182-202` |
| `userIdToken.email` | end-user email; required non-empty; becomes intent owner anchor | `workspace-jwt.ts:202-205`; `workspace-studio.ts:196` |
| JWKS `kid` | none pinned; resolved dynamically from Google's certs (nothing to register) | `workspace-jwt.ts` |

### Identifier values — NOT in the repo (placeholders)

| Identifier | Status | Note |
|---|---|---|
| Marketplace service account email (`CHITTYROUX_GCP_SA_EMAIL` value) | `<<PLACEHOLDER>>` | Test fixture `chittyclaw@chittyops.iam.gserviceaccount.com` (`…ingest.spec.ts:37`) is a TEST CONSTANT — not production. |
| Add-on OAuth client ID (`CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_ID` value) | `<<PLACEHOLDER>>` | Test fixture `443939537625-…apps.googleusercontent.com` (`…ingest.spec.ts:38`) is a TEST CONSTANT — not production. |
| Service account numeric OAuth2 `client_id` (for DWD) | `<<PLACEHOLDER>>` | Distinct from the add-on OAuth client ID; this is the SA's "Unique ID" shown in Cloud Console. |
| GCP project ID | `<<PLACEHOLDER>>` | Not in repo. |
| Workspace customer ID | `<<PLACEHOLDER>>` | Not in repo. |
| OAuth scope list for DWD | `<<PLACEHOLDER — see scope caveat>>` | **The repo enumerates NO scopes for this add-on.** See caveat below. |

### Scope caveat (important)

The add-on **never enumerates any OAuth scopes**. It receives `userOAuthToken`
opaquely (`workspace-auth.ts:68`) and forwards it to chittystorage, which fetches
Gmail attachments downstream (`users.messages.attachments.get`,
`workspace-studio.ts:261,302-325`). A Gmail-read scope is therefore **inferred**,
not a repo fact. The `gmail.readonly` references found under `docs/plans/*email*`
belong to a **different feature** (ChittyRouter dynamic-email OAuth on
`router.chitty.cc`), **not** this add-on. Do not copy that scope blindly — the
operator must confirm the actual scope set.

### Bindings the worker reads (names only)

All `CHITTYROUX_*` + `REGISTERED_CHANNELS_JSON` are `secret_text` (deploy-safe;
**not** in `wrangler.jsonc [vars]`). Do not move them to `[vars]` — doing so
would convert them to plain-text on next deploy and overwrite the working
secrets.

| Binding | Declared | Consumed | Purpose |
|---|---|---|---|
| `CHITTYROUX_GCP_SA_EMAIL` | `src/index.ts:77` | `workspace-jwt.ts:164` | Pin `systemIdToken.email` to the marketplace SA |
| `CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_ID` | `src/index.ts:78` | `workspace-jwt.ts:195` | Pin `userIdToken.aud` to the add-on OAuth client ID |
| `CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_SECRET` | `src/index.ts:79` | (unused in verified paths) | Reserved — confirm before relying on it |
| `REGISTERED_CHANNELS_JSON` | `src/index.ts:80` | `src/lib/channel-registry.ts:56` | Channel allowlist; default channel `chitty:channel:workspace-studio-gmail` must be present, `status:'active'`, capability `gmail.ingest` |
| `GCP_JWKS_URL` | `src/index.ts:81` | `workspace-jwt.ts:59` | Test-only JWKS override; unset in prod → Google default |

### Step endpoints the worker already serves

Mounted at `app.route('/workspace/studio/roux-ingest', …)` (`src/index.ts:189`):

- `POST /workspace/studio/roux-ingest/config` — returns a **bare Card proto** (no
  `renderActions` wrapper); config inputs `chittycommand_url`,
  `default_privilege`; **no auth** (`workspace-studio.ts:44-84`).
- `POST /workspace/studio/roux-ingest/execute` — auth-gated; returns
  `hostAppAction.workflowAction.returnOutputVariablesAction.outputVariables[]` on
  success, `returnElementErrorAction` on failure (`workspace-studio.ts:88,396-459`).

Full production URLs:
- `https://command.chitty.cc/workspace/studio/roux-ingest/config`
- `https://command.chitty.cc/workspace/studio/roux-ingest/execute`

## C) Drafted GAM publish sequence (FOR REVIEW — not runnable as-is)

```bash
#!/usr/bin/env bash
# Roux Ingest — Workspace Studio custom-step publish sequence (DRAFT).
# HTTP-mode Workspace Add-on; no Apps Script project (workspace-studio.ts:5-7).
#
# ── HONESTY BOUNDARY ──────────────────────────────────────────────────────
# GAM (standard) and GAMADV-XTD3 manage Google *Admin/Directory* objects and
# domain-wide delegation. They DO NOT create GCP projects, service accounts,
# OAuth clients, OAuth consent screens, or Workspace Marketplace/Add-on SDK
# listings. Those are Google Cloud Console / Admin Console (Apps > Marketplace
# apps) actions. The ONLY step GAM truly owns here is the domain-wide
# delegation grant (Step 4) and its read-back verification (Step 5).
# Everything above it is Console work, listed so the operator sees the chain.
#
# All <<PLACEHOLDER ...>> values are UNCONFIRMED. Do not invent them.

set -euo pipefail

# ── Placeholders to resolve BEFORE running anything ───────────────────────
SA_EMAIL="<<PLACEHOLDER: marketplace SA email — must equal prod CHITTYROUX_GCP_SA_EMAIL secret>>"
OAUTH_CLIENT_ID="<<PLACEHOLDER: add-on OAuth client ID — must equal prod CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_ID secret>>"
# DWD uses the OAuth2 *client_id* of the service account (its numeric "Unique ID"
# in Cloud Console), DISTINCT from the add-on OAuth client ID above.
SA_CLIENT_ID="<<PLACEHOLDER: service account OAuth2 client_id (numeric unique id) for DWD>>"

# ── STEP 0 (CONSOLE, not GAM): GCP project + service account ───────────────
#   - Confirm/create the GCP project that owns the add-on.
#   - Confirm SA_EMAIL exists and MATCHES the worker's CHITTYROUX_GCP_SA_EMAIL,
#     else the systemIdToken email check fails (workspace-jwt.ts:172-178).
#       gcloud iam service-accounts list --project <<PLACEHOLDER: gcp project id>>
#     (gcloud is NOT installed where this draft was produced.)

# ── STEP 1 (CONSOLE, not GAM): OAuth client + consent screen ───────────────
#   - Confirm OAuth 2.0 Client ID = OAUTH_CLIENT_ID (userIdToken.aud,
#     workspace-jwt.ts:195). Configure the OAuth consent screen.

# ── STEP 2 (CONSOLE, not GAM): Workspace Add-on / Marketplace SDK listing ──
#   - Enable "Google Workspace Add-ons API" + (if listing) "Google Workspace
#     Marketplace SDK".
#   - Register the HTTP add-on deployment pointing at:
#       config:  https://command.chitty.cc/workspace/studio/roux-ingest/config
#       execute: https://command.chitty.cc/workspace/studio/roux-ingest/execute
#   - Declare the Workspace Studio custom step so authors can add it to a Flow.

# ── STEP 3 (Admin Console UI): install/allowlist the Marketplace app ───────
#   Admin Console > Apps > Google Workspace Marketplace apps > install
#   domain-wide (or to an OU). GAM has NO verified subcommand to install a
#   Marketplace app — do this in the UI.

# ── STEP 4 (GAM — the one step GAM owns): domain-wide delegation ───────────
#   SCOPE CAVEAT: the repo enumerates NO scopes for this add-on. The scope list
#   below is a PLACEHOLDER the operator MUST confirm. A Gmail-read scope is
#   INFERRED from the downstream attachment fetch (users.messages.attachments.get,
#   workspace-studio.ts:306) — it is inference, NOT repo fact.
gam create domain-wide-delegation \
    clientid "${SA_CLIENT_ID}" \
    scopes "<<PLACEHOLDER: confirm scope list — e.g. https://www.googleapis.com/auth/gmail.readonly>>"
#   (If the delegation already exists, `gam update domain-wide-delegation
#    clientid ... scopes ...` REPLACES the scope set.)

# ── STEP 5 (GAM, read-only): verify the delegation landed ──────────────────
gam print domain-wide-delegation
gam show domain-wide-delegation clientid "${SA_CLIENT_ID}"
#   (Verb spelling differs across GAM builds — GAMADV-XTD3 supports
#    print/show domain-wide-delegation; older standard GAM may use
#    `gam print serviceaccounts` / `gam oauth show`. Confirm against your binary.)

# ── STEP 6 (read-only, non-GAM): live smoke once published ─────────────────
#   curl -s https://command.chitty.cc/workspace/studio/roux-ingest/config | jq .
#   (config needs no auth — workspace-studio.ts:51-52 — so a 200 + card JSON
#    confirms the worker side. execute needs a real Google-signed token and
#    cannot be smoke-tested without Google invoking it.)
```

## D) Open questions / identifiers to confirm before running anything

1. **Service account email** (prod `CHITTYROUX_GCP_SA_EMAIL`) — not in repo; test
   fixture is a TEST CONSTANT.
2. **Add-on OAuth client ID** (prod `CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_ID`) —
   not in repo; test fixture is a TEST CONSTANT.
3. **SA numeric OAuth2 `client_id` for DWD** — distinct from #2; not derivable
   from repo.
4. **OAuth scope list for the DWD grant** — repo enumerates none; Gmail-read is
   inferred only. Do not copy `gmail.readonly` from the unrelated ChittyRouter
   docs.
5. **GCP project ID** and **Workspace customer ID** — not in repo.
6. **JWKS `kid`** — none pinned (dynamic resolution); no action, noted for
   completeness.
7. **`CHITTYROUX_MARKETPLACE_OAUTH_CLIENT_SECRET`** — declared but unused in
   verified paths; confirm whether an unwired token-exchange path needs it before
   publishing.
8. **GAM verb spelling** — confirm `domain-wide-delegation` subcommands against
   the actual installed GAM/GAMADV-XTD3 binary. GAM cannot install the
   Marketplace app (Step 3) — that is Admin Console UI.

**Whole-draft caveat:** none of section C could be validated where it was
produced (no `gam`/`gcloud`/credentials). Treat it as a review artifact, not a
tested runbook.
