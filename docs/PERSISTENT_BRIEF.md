# Persistent Brief (Working Memory)

Last updated: 2026-03-02
Purpose: Persistent operator intent and discovery hints for cross-session continuity. This is not canonical authority.

## Intent Snapshot

- Build end-to-end development automation across orgs/repos with separation of concerns and adversarial review.
- Support human and synthetic principals as first-class auditable actors.
- Minimize repeated user context setup across tools/channels/models.

## Non-Negotiables

- No shared unbound credentials for synthetic actors.
- Every action must be attributable to principal + session + policy decision.
- Earned authority must be based on visible ledgered outcomes.
- Governance controls must resist accidental human bypass.

## Discovery Anchors

- Canonical governance: `chittycanon://gov/governance`
- TY/VY/RY: `chittycanon://gov/governance#three-aspects-framework`
- Context model / trust mechanics: `chittycanon://docs/tech/spec/context-schema`
- Session genes: `chittycanon://specs/chittydna-session-governance`
- Foundation charter: `chittycanon://docs/ops/policy/chitty-canon-charter`

## Principal Model

- Natural principals: accountable humans and legal entities.
- Synthetic principals: separate ChittyIDs, linked ownership/delegation, auditable actions.
- Session authority: short-lived, scoped, channel-aware; no cache-only trust.

## DNA, Trust, and Authority

- Governance and outcomes should write to ledger/DNA history.
- Authority progression should be staged and reversible.
- Inheritance should be lineage-aware and discounted; merit is earned per entity.

## Risk and Behavior Controls

- Risk tiers gate what synthetic entities can do.
- Behavior profiles are policy-bound (speed, caution, escalation mode).
- High-risk actions require stricter review/delegation until trust is demonstrated.

## Open Implementation Gaps

- Session bootstrap is still partially fail-open in local hook chain.
- ChittyContext cache currently mixes legacy and current entity/session states.
- Canonical references exist but are not uniformly surfaced in every repo triad.

## Update Rule

When intent or architecture changes materially, update this file first, then sync CHITTY/CHARTER discovery links.
