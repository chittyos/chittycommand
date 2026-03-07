# ChittyCommand Adversarial Review (Restated)

**Date:** 2026-03-05  
**Status:** Canonical correction to prior analysis

## Corrections to Prior Claims

1. Queue approval does execute a DB payment state change today.
- `src/routes/swipe-queue.ts` sets linked obligation `status='paid'` on approved payment-type actions.
- It bypasses the explicit `/obligations/:id/pay` path, but it is still a real mutation.

2. Dispute "Take Action" is not a same-page no-op from Dashboard context.
- In Focus Mode it navigates from `/` to `/disputes`.
- Real issue: it does not deep-link to a specific dispute/action target.

## Verified Findings

1. Dispute progress dots are currently synthetic and not backed by lifecycle-stage storage.
2. Recommendations page duplicates Action Queue capabilities.
3. Payment plan activation updates DB status only; no downstream execution artifacts are created.
4. Cash Flow tabs are disconnected data views without synthesis.
5. Upload flows cannot explicitly set `linked_dispute_id` from UI.
6. Legal and Disputes are not cross-linked via `case_ref`.
7. Chat sidebar content is in-memory and lost on refresh.
8. Queue does not auto-run triage on empty first-load.
9. Dashboard pay action had no confirmation.
10. No frontend dispute creation form despite backend POST support.

## Plan Flaws Identified

1. Double-write risk in queue approval flow (`decideQueue` plus `markPaid`).
2. `case_ref` top-level proposal conflicts with existing `metadata.ledger_case_id`.
3. Stage/status semantics were undefined.
4. Chat context expansion added heavy per-message query cost with no cache strategy.
5. Replacing Cash Flow tabs entirely was high-risk relative to value.
6. Chat message action buttons did not account for SSE stream completion boundaries.
7. No automated test coverage was defined for large-scope financial-flow changes.

## Required Fixes

1. Remove payment side-effect from queue decide endpoint; keep payment execution explicit and single-path.
2. Promote `metadata.ledger_case_id` into a first-class column (or migration path), not parallel sources of truth.
3. Define lifecycle contract: stage = position, status = resolution outcome with terminal transitions only.
4. Lazy-load heavy dispute verification context only for targeted prompts/actions.
5. Keep Cash Flow tabs and add synthesis strip first.
6. Render chat action buttons only after SSE stream completion (`[DONE]`).
7. Gate each phase with integration tests before merge.

## Priority Order

### P0 (ship first)
- Toast system + ConfirmDialog
- Dashboard pay confirmation
- Auto-triage on empty queue

### P1
- Remove queue payment double-write path and add explicit execution path
- Swipe decision feedback toasts

### P2
- Real dispute lifecycle model (stage column + stage/status rules)
- Dispute creation form
- Progress dots from DB state
- Upload documents from dispute context

### P3
- Legal ↔ Disputes cross-linking
- Payment plan outputs into queue items
- Cash Flow synthesis strip while preserving tabs

### P4
- Chat persistence and streaming-aware insight actions
- Chat-to-correspondence bridge
- Sidebar information architecture cleanup
- Remove redundant Recommendations page

## Current Execution Snapshot (this pass)

- Implemented P0 foundations in UI:
  - Added global toast system and provider.
  - Added reusable confirmation dialog.
  - Added Dashboard pay confirmation and feedback toasts.
  - Added Action Queue auto-triage on first empty load and decision feedback toasts.
