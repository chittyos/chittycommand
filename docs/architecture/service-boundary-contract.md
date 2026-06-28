---
uri: chittycanon://docs/ops/policy/chittycommand-service-boundary-contract
namespace: chittycanon://docs/ops
type: policy
version: 0.2.0
status: DRAFT
registered_with: chittycanon://core/services/canon
title: "ChittyOS Canonical Service-Boundary Contract (Implementation-Gated)"
certifier: chittycanon://core/services/chittycertify
visibility: PUBLIC
context_brief: chittycontext://persistent-brief
discovery_refs:
  - chittycanon://gov/governance
  - chittycanon://docs/tech/spec/context-schema
  - chittycanon://specs/chittydna-session-governance
provenance:
  derived_from: adversarial canon-vs-code review, 2026-06-12
  authored: 2026-06-14
  live_verification: 2026-06-28 (canon URI validator + ChittyOS service registry)
modified: 2026-06-28
---

<!--
  URI/type note: v0.1.0 carried uri `chittycanon://docs/architecture/chittycommand/
  service-boundary-contract` and `type: contract`. Both fail live canon validation:
  `architecture` is not a valid docs domain (tech|legal|ops|exec|gov) and `contract`
  is not in the frontmatter type enum (policy|spec|procedure|registry|architecture|
  catalog|summary). v0.2.0 corrects to a validated `docs/ops/policy/...` URI and
  `type: policy`. The file path stays under docs/architecture/ (URI ≠ file path, per
  CHARTER.md precedent). ADR-001 still carries the same non-canonical `docs/architecture`
  domain — logged below, not changed here.
-->


# ChittyOS Canonical Service-Boundary Contract (Implementation-Gated)

<!-- chitty:discovery-links:start -->
## Persistent Context

- **Working memory brief**: [docs/PERSISTENT_BRIEF.md](../PERSISTENT_BRIEF.md)
- **Canonical governance**: `chittycanon://gov/governance`
- **TY/VY/RY framework**: `chittycanon://gov/governance#three-aspects-framework`
- **Context model**: `chittycanon://docs/tech/spec/context-schema`
- **Session governance genes**: `chittycanon://specs/chittydna-session-governance`
- **Governance DNA / earned authority**: `chittycanon://gov/governance#written-to-chittydna`

This section is a persistent discovery hint for humans and agents. It is not an authority source.
<!-- chitty:discovery-links:end -->

## Status of this contract

> **This contract is canon-aligned and implementation-gated.** Any service
> boundary asserted here must be cross-referenced against (1) canonical
> ChittyCanon documentation **and** (2) current repository code before it is
> enforced. If docs and code conflict, mark the boundary `canonical_drift_blocked`
> or `repo_identity_drift`; **do not** assume the service is implemented.

It describes a **target architecture** the ChittyOS ecosystem is converging
toward. It is *directionally* confirmed against canonical documentation, but it
is **not** a claim that the named repositories already implement these boundaries.
At the time of derivation (adversarial review, 2026-06-12) several named service
repos appeared to carry **copied/stale ChittyCanon** charter/package identity
rather than service-specific implementation — i.e. `repo_identity_drift` — so the
contract is enforceable only boundary-by-boundary as code evidence catches up to
canon.

This document is a **governance contract**, not a decision record. For the
ChittyCommand-internal platform decision it builds on, see
[ADR-001](ADR-001-meta-orchestrator-extension.md).

## Drift-status vocabulary

Every boundary claim in this contract carries one or more status tags. Tags are
intentionally separated into a **canon axis** (is the boundary blessed by
canonical docs?) and a **code axis** (does live repository evidence support it?).

| Tag | Axis | Meaning |
|-----|------|---------|
| `canon_confirmed` | canon | Explicitly stated in canonical ChittyCanon documentation. |
| `canon_directional` | canon | Implied by canonical references (e.g. tier/placement) but not spelled out as an ownership rule. |
| `registry_confirmed` | live | The live ChittyOS service registry (`helper_registry_lookup`) records this ownership scope + canonical `doc_ref`. Authoritative for *ownership intent*, independent of repo-file identity. |
| `code_confirmed` | code | Verified against current, service-specific repository implementation (the repo's own `CHARTER.md` / `package.json`). |
| `code_drift` | code | Canon says one thing; the repo's current code/identity does not yet match. |
| `repo_identity_drift` | code | The repo carries another service's identity (e.g. a copied ChittyCanon `CHARTER.md` / `package.json`) instead of its own. A special case of `code_drift`. |
| `design_proposed` | both | Architecturally sound but no canonical evidence **and** no installed repo found. Must not be enforced. |
| `hold` / `hold_blocked` | both | Insufficient source data to confirm; enforcement paused pending evidence. |
| `canonical_drift_blocked` | both | Docs and code actively conflict; the boundary is blocked from enforcement until reconciled. |

**Capability-governor rule:** do **not** invent a service boundary without
canonical evidence. A boundary that is `design_proposed` or `hold_blocked` is a
hypothesis, not a contract clause to be enforced.

## The target boundary model (canon-aligned)

```text
Orchestrator              = thin session viewport (ephemeral working memory)
ChittyEntity/ChittyContext = persistent synthetic identity (ChittyID, ledger, DNA, trust)
ChittyID                  = identity minting
ChittyConnect             = context binding / connectivity
ChittyRouter              = routing
ChittyAuth                = auth / access
ChittyCanon               = ontology / canonical rules
```

### Actor and context ontology (`canon_confirmed`)

- ChittyCanon governs the **P/L/T/E/A** type ontology, the `chittycanon://` URI
  namespace, code-pattern governance, and the canonical data model. It explicitly
  does **not** own ChittyID identity generation or ChittyAuth authentication.
- An actor with agency is **`P` — Person**. A Claude / AI context is
  `Person (P, Synthetic)` — **never** `Thing`. `Entity` is not a valid type value.
- **Context is persistent; session is ephemeral.** A context has its own ChittyID,
  ledger, DNA, and trust score. A session operates *under* a context's ChittyID
  and is working memory only — a viewport, not an identity.

> **In-repo evidence (`code_confirmed` for this boundary):** ChittyCommand's own
> charter records a required ChittyID re-mint from type `T` (Thing) to
> `P`-Synthetic precisely because the service "takes autonomous action" and is
> therefore a Person, not a Thing. See `CHARTER.md` → Compliance, and the
> executor/sovereignty wiring in `meta/`. This is the live, local instance of the
> "actors with agency are always Person (P, Synthetic)" rule.

## Boundary evidence table

Status reflects the 2026-06-12 adversarial review **overlaid with a 2026-06-28 live
registry verification** (see the Live Verification section below). The registry layer
now confirms *ownership intent* for connect/auth/id/canon and confirms ChittyRouter's
`hold`. The **repo-file** identity drift (stale `CHARTER.md` / `package.json`) reported
in 2026-06-12 remains **unverified** — that check needs read access to the other repos,
which this session did not have. Treat repo-file `code_drift` as still-to-confirm.

| Boundary claim | Status | Finding |
|---|---|---|
| ChittyCanon owns ontology / canonical model | `canon_confirmed`, `registry_confirmed` | Charter governs P/L/T/E/A ontology, URI namespace, code-pattern governance, canonical data model. Does **not** own ChittyID minting or ChittyAuth authentication. Registry: `chittycanon` → "canonical definitions, architectural specifications" (`core/services/canon`). |
| `Person (P, Synthetic)` is the actor class for AI/context | `canon_confirmed`, `code_confirmed` (local) | Canon defines `P` as actor-with-agency; AI contexts are `P`-Synthetic, never `Thing`; `Entity` is not a type. ChittyCommand's own T→P re-mint is the local instance. |
| Context persistent; session ephemeral viewport/worker | `canon_confirmed` | Context has ChittyID, ledger, DNA, trust; session runs under a context's ChittyID as working memory. |
| ChittyConnect owns connectivity / context binding | `canon_confirmed`, `registry_confirmed`; repo-file `code_drift` *unverified* | Registry: `chittyconnect` → "service connections, credential proxying, API access" (`core/services/connect`, connect.chitty.cc) — confirms ownership. The 2026-06-12 report that `chittyos/chittyconnect`'s `CHARTER.md`/`package.json` identify as **ChittyCanon** (`repo_identity_drift`) is **not re-verified** this session. |
| ChittyAuth owns auth / access | `canon_confirmed`, `registry_confirmed`; repo-file `code_drift` *unverified* | Registry: `chittyauth` → "authorization, access control, permissions" (`core/services/auth`, auth.chitty.cc) — confirms ownership. Reported `repo_identity_drift` on `chittyfoundation/chittyauth` **not re-verified** this session. |
| ChittyID owns identity minting | `canon_confirmed`, `registry_confirmed`; repo-file `code_drift` *unverified* | Registry: `chittyid` → "identity management, user authentication, DID resolution" (`core/services/identity`, id.chitty.cc) — confirms ownership. Reported `repo_identity_drift` on `chittyfoundation/chittyid` **not re-verified** this session. |
| ChittyRouter owns routing | `canon_directional`, `hold_blocked` (registry-confirmed) | Live registry returns **"System not found: chittyrouter"** — no registered ownership scope or `doc_ref`. This *confirms* the contract's hold: routing has no canonical registry surface to enforce against. |
| ChittyTasks owns credential-origination task routing | `design_proposed` / `hold_blocked` | No installed repo named `chittytasks`/`chittytask` found, and no registry entry probed. Concept is sound, but the capability-governor rule forbids inventing a boundary without canonical evidence → `hold`. |

> **Note on local naming:** within ChittyCommand, "tasks" capability is satisfied
> by the `chittyagent-tasks` durable-queue pattern reused for intent dispatch and
> `node_leases` (see `CHARTER.md` → Dependencies, and `daemon/leader.ts`). That is
> **not** the same thing as a canonical `ChittyTasks` service owning
> credential-origination routing; the latter remains `design_proposed`.

## Live verification (2026-06-28)

A live status sweep of the canon validator and the ChittyOS service registry was
run on 2026-06-28. Results are recorded here as dated evidence; re-run before
relying on them.

### Service-registry ownership (`helper_registry_lookup`)

| System | Ownership scope (registry) | `doc_ref` | Interface | `last_verified` |
|---|---|---|---|---|
| `chittyid` | identity management, user authentication, DID resolution | `chittycanon://core/services/identity` | id.chitty.cc | 2026-01-06 |
| `chittyconnect` | service connections, credential proxying, API access | `chittycanon://core/services/connect` | connect.chitty.cc | 2026-01-06 |
| `chittyauth` | authorization, access control, permissions | `chittycanon://core/services/auth` | auth.chitty.cc | 2026-01-06 |
| `chittycanon` | canonical definitions, architectural specifications | `chittycanon://core/services/canon` | canon.chitty.cc | 2026-01-06 |
| `chittyrouter` | **not found** | — | — | — |

The registry confirms ownership intent for the four registered services and the
**absence** of a routing service — exactly matching the target model's `hold` on
ChittyRouter. Registry `last_verified` stamps are themselves stale (2026-01-06),
so this is ownership-of-record, not a liveness guarantee.

### Canon URI / frontmatter validation

- This document's v0.1.0 URI (`chittycanon://docs/architecture/...`) and
  `type: contract` **both failed** live canon validation. Corrected in v0.2.0 to
  `chittycanon://docs/ops/policy/chittycommand-service-boundary-contract`
  (validated clean) and `type: policy` (in the frontmatter enum).
- **Discovered drift:** [ADR-001](ADR-001-meta-orchestrator-extension.md) carries
  the same non-canonical `chittycanon://docs/architecture/chittycommand/ADR-001`
  URI. Left unchanged here (changing a referenced canonical URI is out of scope for
  this doc), but logged as a `canonical_drift_blocked` candidate for a follow-up.
- **Registered:** this contract was registered with the canonical registry
  (`canon_register_document`) on 2026-06-28T07:08:14Z → `registered: true`,
  status `DRAFT` (authority: none, as expected for a draft).

### Availability (not identity)

- `canon` service `/health` was **down** (canon.chitty.cc non-200 on all probes) and
  the MCP aggregator `mcp.chitty.cc` returned 404 — yet the canon **MCP surface**
  (URI validation, frontmatter schema) responded normally. Availability drift is
  orthogonal to the ownership boundaries above; recorded so a future reader does not
  mistake a health blip for a boundary change.
- The health probe covers the `chittyagent-*` MCP federation only; `id` / `connect` /
  `router` are platform infrastructure and are not in it (consistent with them not
  being MCP agents).

## Enforcement rule

Before any consumer (code, telemetry, downstream contract, or agent policy)
**enforces** a boundary from the target model:

1. Confirm the boundary is `canon_confirmed` **or** `canon_directional` against
   live ChittyCanon docs.
2. Confirm the owning repo is `code_confirmed` — its own charter/package identity,
   not a copied ChittyCanon stamp.
3. If (1) and (2) disagree, tag `canonical_drift_blocked` (docs vs code conflict)
   or `repo_identity_drift` (repo carries another service's identity) and **do not
   enforce** — route to reconciliation instead.
4. Never assume a service is implemented because canon names it. Absence of code
   evidence is `hold`, not confirmation.

## Bottom line

The model is **canonically consistent** as a *target* contract. Current code and
capability evidence says:

```text
canon_alignment:         confirmed (this doc's own URI/type now validate clean)
registry_ownership:      confirmed for chittyid / chittyconnect / chittyauth / chittycanon
chittyrouter:            hold_blocked — not found in the live registry
repo_identity_drift:     reported 2026-06-12, NOT re-verified (no repo read access this session)
implementation_maturity: not enough to claim deployed
chittytasks:             design-proposed unless found elsewhere
```

This preserves the intended ChittyOS architecture without pretending the current
repos fully implement it. The 2026-06-28 sweep moved ownership intent from *reported*
to *registry-confirmed*; the remaining gap is repo-file `code_confirmed` (reading each
service's own `CHARTER.md` / `package.json`). Update this contract as that evidence
lands, boundary by boundary.
