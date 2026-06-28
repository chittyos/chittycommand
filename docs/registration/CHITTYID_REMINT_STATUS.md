# ChittyID Re-Mint Status — T → P-Synthetic

**Status:** `PENDING` (operator action) · **Last updated:** 2026-06-28

A single status anchor for ChittyCommand's ChittyID re-mint. This file tracks
*state and blockers only* — the mint **mechanics** live in
[`SUBMISSION_RUNBOOK.md`](SUBMISSION_RUNBOOK.md) (step 3 + the substitution table)
and must not be duplicated here.

## Why this re-mint exists

ChittyCommand is a sovereign meta-orchestrator that takes autonomous action
(intent execution, sovereignty enforcement, channel fanout). Per canon, an actor
with agency is a **Person — Synthetic** (`P`-Synthetic), never a `Thing`. This is
the live, in-repo instance of the actor-class rule asserted in the
[Service-Boundary Contract](../architecture/service-boundary-contract.md)
(`chittycanon://docs/ops/policy/chittycommand-service-boundary-contract`) — the one
boundary that can move from `code_drift` to `code_confirmed` entirely within this repo.

## Identity transition

| | Value |
|---|---|
| Current (deprecated) | `03-1-USA-3846-T-2602-0-57` — 5th field `T` (Thing) |
| Target shape | `VV-G-USA-NNNN-P-YM-S-X` — 5th field `P`, subtype Synthetic |
| Mint path | `ch1tty → ChittyConnect → chittyid` (sensitive-intent broker; operator never handles the bearer) |
| Verify | 5th `-`-separated field of the minted ID is `P` before it is substituted into the payload |

The deprecated T-type ID is retained for historical lookup only and must **not** be
cited as the service identity in new code, telemetry, or downstream contracts after
the re-mint.

## What it blocks (from `CHARTER.md` → Compliance)

- Formal **ChittyCertify at Tier 2**
- **Sovereign-intent signing**
- **ChittyTrust** score binding for the service-as-actor

## Where it is tracked (do not let these drift apart)

| Artifact | Role |
|---|---|
| `CHARTER.md` → Compliance | Authoritative checkbox + blocker list |
| `docs/registration/chittycommand-registration-payload.json` | `chittyId: <<PENDING_P_SYNTHETIC_CHITTYID>>`, `metadata.previousChittyId` recorded |
| `docs/registration/SUBMISSION_RUNBOOK.md` | Mint + substitution + submission mechanics |
| `docs/architecture/service-boundary-contract.md` | The actor-class boundary this satisfies |
| **this file** | At-a-glance status + blocker anchor |

## Definition of done

1. New `P`-Synthetic ChittyID minted via the ChittyConnect path and `P` verified in the 5th field.
2. Payload placeholder substituted at submission time (never committed in plaintext).
3. `register.chitty.cc` returns 2xx; registry search shows `tier: 2` + the new ID.
4. `CHARTER.md` Compliance checkbox flipped, with redacted registration evidence recorded.
5. Service-Boundary Contract row for `Person (P, Synthetic)` updated from
   `code_confirmed (local, re-mint pending)` to `code_confirmed`.

> This file does not mint, submit, or handle tokens. It is a tracker. Operator action
> via the runbook is required to advance any step above.
