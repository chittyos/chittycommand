---
canonical_uri: chittycanon://docs/architecture/chittycommand/ADR-001
title: ADR-001 — Extend ChittyCommand into the Tier-2 meta-orchestrator
status: accepted
date: 2026-06-03
deciders: nb (operator), Claude Code (synthesis)
supersedes: none
---

# ADR-001 — Extend ChittyCommand into the Tier-2 meta-orchestrator

## Context

ChittyCommand exists today as a Tier-5 application: a unified life-management
dashboard with multi-source ingest, AI urgency scoring, and an ActionAgent that
executes payments/emails/status updates via a 43-tool MCP at `command.chitty.cc`.

A separate need was raised for a **meta-orchestrator with forever context** — the
persistent always-on coordinator that eventually becomes the operator's "digital
dupe with partial sovereignty in the digital plane." Three non-functional
requirements: (1) interface never down, (2) forever context never lost, (3) brain
never stalls.

Initial framing imagined a separate `chittyagent-command` service. Ecosystem
discovery (registry + compliance triads of orchestrator/tasks/ch1tty/connect +
chittyserv cluster) showed:

- The capability surface the meta-orchestrator needs (action execution, MCP,
  durable state, multi-source context, durable identity) **already lives inside
  ChittyCommand**.
- A new repo would split state, deploy, and MCP across two services that share
  the same conceptual job ("the thing in charge of your life").
- The genuine gaps are *layers*, not a separate service: a persistent supervised
  cluster daemon, cross-channel intent fanout, and sovereignty enforcement.

## Decision

**Extend `CHITTYOS/chittycommand` rather than create a new service.** Add two
internal subsystems and reclassify the service from Tier-5 application to
Tier-2 platform with a Tier-5 dashboard surface.

```
CHITTYOS/chittycommand
├── src/        existing worker (dashboard + ActionAgent + 43-tool MCP) — unchanged this PR
├── meta/       NEW — meta-orchestrator layer
│              intent ladder, sovereignty policy, cross-channel fanout, forever-context binding
├── daemon/     NEW — persistent cluster process
│              Node, supervised (launchd/systemd), Neon node_leases leader election
│              targets chittymini-01..06 + chittyserv-vm
└── shared/     refactor types only (deferred; not in scope of foundation PR)
```

### Cluster runtime decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Leader topology | Float freely across cluster | True "never down"; no SPoF |
| Old `chittymarket-sync-daemon` | Supersede (`daemon/` absorbs channel sync) | Old daemon broken on disk since 2026-05-10 |
| Neon-loss fallback | Park the node (MVP) | Avoids split-brain; LAN gossip is a follow-up |

### Capability ownership (do not duplicate)

| Capability | Owner | `meta/` integration |
|---|---|---|
| Routing + trust gate | `chittyagent-orchestrator` | `POST agent.chitty.cc/agent/message` |
| Durable queue | `chittyagent-tasks` | `chittyentity/workers/shared/agent-tasks.ts` |
| MCP portal / OAuth | `chittyagent-ch1tty` | Upstream `command` already in `AGENT_MCP_UPSTREAMS` |
| Forever context | ChittyConnect (ContextConsciousness + MemoryCloude) | `chittyentity/workers/shared/chittyconnect-client.ts` |
| Secret brokerage | ChittyConnect sensitive-intent path | Never inline secrets |
| Channel registration | `agent.chitty.cc/api/v1/channels` | Register on boot; nodes register as sub-channels |
| Service discovery | `registry.chitty.cc` / `register.chitty.cc` | Read + write paths |
| Identity / trust | `chittyid` / `chittyauth` / `chittytrust` | Mint command ChittyID (P-Synthetic); per-node ChittyID (L) |

## Foundation PR scope (this branch)

**Strictly in scope:**

1. This ADR.
2. `meta/` package skeleton with:
   - `meta/intent.ts` — intent-ladder types (`Goal → Plan → Task`), real Drizzle schema additions in `migrations/`, no stub data.
   - `meta/sovereignty.ts` — trust-gated decision interface; reads real ChittyTrust score for actor, returns `autonomous | requires_human | blocked` with reasoning.
   - `meta/channels.ts` — channel fanout interface; reads upstream channel list from `agent.chitty.cc/api/v1/channels`.
   - `meta/context.ts` — thin wrapper over `chittyconnect-client.ts` pattern for ContextConsciousness/MemoryCloude reads/writes.
3. `daemon/` package skeleton with:
   - `daemon/leader.ts` — Neon `node_leases` table (mirrors `task_leases` shape) + atomic claim via `UPDATE ... RETURNING`. Real SQL.
   - `daemon/loop.ts` — the persistent loop: claim → execute → heartbeat → release. Pulls intents from the existing meta-orchestrator state.
   - `daemon/supervisor.md` — process supervision plan (launchd on macOS Minis, systemd on Ubuntu Minis + VM). No runtime supervisor code in this PR.
4. One real integration test that:
   - Creates a `node_leases` row on a Neon dev branch.
   - Claims it from one "node" process.
   - Verifies a second concurrent claim is rejected.
5. No changes to existing `src/`, `agents/`, or the user-facing dashboard. Tier-5 surface stays intact.

**Out of scope (separate PRs):**

- Actual deployment / wrangler changes / domain routing.
- Refactoring shared types.
- The autonomous-loop policy semantics beyond the interface.
- Multi-node deployment scripts.
- Cluster daemon hardening (Neon-loss handling beyond "park the node").

## Binding rules (BINDING from chittyentity CLAUDE.md)

- **No mocks, no fake data, no placeholder endpoints.** Every route returns real
  query results. Every test exercises real behavior against a real Neon branch.
- **Validate against the real backend before PR.** Run the SQL via the Neon MCP
  against a dev branch; record evidence in PR body.
- **Sensitive intent contract.** Any credential/secret access routes
  `ch1tty → ChittyConnect`. Never paste secrets in code or chat.

## Consequences

- ChittyCommand's classification effectively becomes "Tier-2 platform with a
  Tier-5 dashboard surface." The CHARTER.md needs a follow-up update to reflect
  this; that change is intentionally NOT in this foundation PR (charter update
  warrants its own review).
- The existing ActionAgent in `src/agents/` becomes one of multiple execution
  surfaces the meta-orchestrator can route to. No code change required this PR.
- The cluster-daemon runtime depends on Neon reachability for leader election;
  the "park the node" fallback is acceptable for MVP and will be revisited.

---

## Delta: Roux/Triage Carry-Through (2026-06-03)

> @canon: chittycanon://gov/governance#classification-axes  STATUS:PENDING

Ratified by chittycanon-code-cardinal.

### Q1 — Where do `privilege` / `space` live?
**(c) ratified.** Add to `cc_intents` AND `cc_disputes` directly as first-class
columns (text, NOT NULL, defaults `public` / `business`), backed by indexes on
`(privilege, status)` and `(space, status)`. CHECK constraints deferred because
the Roux spec URI is `STATUS:PENDING` certification. App layer enforces the
enum in `meta/intent.ts` and `src/routes/triage.ts`.

### Q2 — Migration semantics on existing rows?
**(a) pass-through-with-warn.** The migration applies `DEFAULT 'public'` /
`'business'` so existing rows are valid. `pushUnlinkedDisputesToNotion` emits
a one-time per-row log when it encounters a row sitting on those defaults
recommending an explicit tag. No backfill writes.

### Q3 — How does Triage claim work?
**Both modes.** Specific-by-ID claim (`POST /api/triage/:id/claim`, atomic,
409 if not pending) for human triagers; bucket-ordered claim
(`POST /api/triage/claim-next`) for autonomous agents, parameterised on
`privilege`, `space`, `priority_lte`. Routes are MCP-exposed as
`triage_list_intents`, `triage_claim_intent`, `triage_claim_next`,
`triage_complete_intent`.

### Q4 — Vocabulary alignment with sovereignty.ts?
**Orthogonal axes — DO NOT TOUCH `decide()`.** The pre-existing
`sensitivity ∈ {low, normal, sensitive, critical}` on
`IntentForSovereignty` is the trust-tier axis the sovereignty matrix consumes.
`privilege ∈ {privileged, pii, hoa_evidentiary, public}` is the Roux
classification axis — informational on `IntentForSovereignty`, persisted on
the intent row, but never an input to the autonomous/human/blocked decision.

### Notion mirror gate
`linkDisputeToNotion` refuses to mirror any dispute where the effective
`privilege ∈ {privileged, pii}` OR `space === 'legalink'`. Effective values
resolve as `explicit > deriveRouxFromType(dispute_type)`. `legal` ⇒
`(privileged, legalink)`; `insurance` ⇒ `(pii, business)`; everything else
defaults to `(public, business)`. This prevents privileged work-product and
PII from being mirrored into the operations Notion workspace.
