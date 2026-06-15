---
uri: chittycanon://docs/architecture/chittycommand/service-boundary-contract
namespace: chittycanon://docs/architecture
type: contract
version: 0.1.0
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
---

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
| `code_confirmed` | code | Verified against current, service-specific repository implementation. |
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

Status reflects the 2026-06-12 adversarial review. Code-side findings for **other**
repos were reported by that review and are **not independently re-verified in this
repository** — treat them as `code_drift` flags to confirm, not as settled fact.

| Boundary claim | Status | Finding |
|---|---|---|
| ChittyCanon owns ontology / canonical model | `canon_confirmed` | Charter governs P/L/T/E/A ontology, URI namespace, code-pattern governance, canonical data model. Does **not** own ChittyID minting or ChittyAuth authentication. |
| `Person (P, Synthetic)` is the actor class for AI/context | `canon_confirmed`, `code_confirmed` (local) | Canon defines `P` as actor-with-agency; AI contexts are `P`-Synthetic, never `Thing`; `Entity` is not a type. ChittyCommand's own T→P re-mint is the local instance. |
| Context persistent; session ephemeral viewport/worker | `canon_confirmed` | Context has ChittyID, ledger, DNA, trust; session runs under a context's ChittyID as working memory. |
| ChittyConnect owns connectivity / context binding | `canon_confirmed`, `code_drift` | Governance maps Connectivity (VY) and context binding to ChittyConnect. But `chittyos/chittyconnect`'s `CHARTER.md` / `package.json` reportedly identify as **ChittyCanon** → `repo_identity_drift`. |
| ChittyAuth owns auth / access | `canon_confirmed`, `code_drift` | Governance maps Authority (RY) access to ChittyAuth. But `chittyfoundation/chittyauth` reportedly carries a ChittyCanon charter/package identity → `repo_identity_drift`. |
| ChittyID owns identity minting | `canon_confirmed`, `code_drift` | Context spec: ChittyID mints IDs for synthetic contexts. But `chittyfoundation/chittyid` reportedly carries a ChittyCanon charter/package identity → `repo_identity_drift`. |
| ChittyRouter owns routing | `canon_directional`, `code_drift` / `hold` | Ecosystem reference places ChittyRouter in Tier-2 platform infrastructure. Earlier repo checks suggested `chittyos/chittyrouter` also looked copied/stale as ChittyCanon → `hold` until a real ChittyRouter pentad/code surface is verified. |
| ChittyTasks owns credential-origination task routing | `design_proposed` / `hold_blocked` | No installed repo named `chittytasks`/`chittytask` found. Concept is sound, but the capability-governor rule forbids inventing a boundary without canonical evidence → `hold`. |

> **Note on local naming:** within ChittyCommand, "tasks" capability is satisfied
> by the `chittyagent-tasks` durable-queue pattern reused for intent dispatch and
> `node_leases` (see `CHARTER.md` → Dependencies, and `daemon/leader.ts`). That is
> **not** the same thing as a canonical `ChittyTasks` service owning
> credential-origination routing; the latter remains `design_proposed`.

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
doc_code_aligned:        partially
repo_identity_drift:     present (chittyconnect, chittyauth, chittyid; chittyrouter on hold)
implementation_maturity: not enough to claim deployed
chittytasks:             design-proposed unless found elsewhere
```

This preserves the intended ChittyOS architecture without pretending the current
repos fully implement it. Update this contract as repos shed `repo_identity_drift`
and earn `code_confirmed` status, boundary by boundary.
