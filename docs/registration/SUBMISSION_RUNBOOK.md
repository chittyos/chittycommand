# ChittyCommand Registration Submission Runbook

Operator-facing runbook for submitting `chittycommand` to `register.chitty.cc` as a Tier-2 platform service. The payload draft lives alongside this file at `chittycommand-registration-payload.json`.

This runbook does NOT submit. Submission is a separate, gated operator action routed through ChittyConnect (the sensitive-intent concierge broker).

## Pre-requisites

1. **Stacked PRs merged to `main`, in order:**
   - PR #106
   - PR #107
   - PR #109
   - PR #110 (Tier-2 reclassification — CHARTER/CHITTY/CLAUDE updates)

   This PR (registration payload draft) is stacked on #110 and should merge AFTER #110 lands on main.

2. **Live pre-flight health probe:**

   ```bash
   curl -sS https://command.chitty.cc/health | jq .
   ```

   Must return the real-dependency probe JSON shape — fields for `db`, `chittyconnect`, and `daemon` heartbeat must reflect actual probed state. A static `{"status":"ok"}` response is a regression and blocks submission per the global "no fake/non-working endpoints" rule.

3. **New P-Synthetic ChittyID minted** via the canonical ChittyConnect path:

   - Route: `ch1tty → ChittyConnect → chittyid`
   - The previous ID `03-1-USA-3846-T-2602-0-57` is deprecated because the 5th field encoded `T` (Thing). `chittycommand` is a sovereign actor and must be `P` (Person, Synthetic characterization).
   - Verify the minted ID's 5th `-`-separated field is `P` before substituting into the payload.

## Substitutions Before Submission

The committed payload contains two placeholder strings. Both must be substituted at submission time. NEITHER value is ever pasted into chat, committed to git, or stored in shell history in plaintext.

| Placeholder | Substitution Source | Routing |
|---|---|---|
| `<<CHITTY_REGISTER_TOKEN>>` | chittysecrets (cold source) → Cloudflare Secrets (runtime) | ChittyConnect broker — operator never handles the bearer directly |
| `<<PENDING_P_SYNTHETIC_CHITTYID>>` | Newly minted via ChittyID service | Operator confirms `P` in 5th field, then injects |

Per `/home/ubuntu/.ch1tty/canon/system-wide-sensitive-intent-contract-v1.md`, the operator does not paste secrets — the request must route through ChittyConnect. If the broker path is unavailable, fail closed with `POLICY_BLOCKED_CHITTYCONNECT_UNAVAILABLE`.

## Submission Command (shape only)

The actual injection uses `op run` per the operator manifest. The template below shows the request shape — do NOT run it verbatim with raw env vars.

```bash
jq '.registrationToken="$CHITTY_REGISTER_TOKEN" | .service.chittyId="$NEW_CHITTYID"' \
   docs/registration/chittycommand-registration-payload.json | \
   curl -sS -X POST https://register.chitty.cc/api/v1/register \
     -H "Authorization: Bearer $CHITTY_REGISTER_TOKEN" \
     -H "content-type: application/json" \
     --data @-
```

Production invocation wraps the above under `op run --env-file=... --` with the token resolved by ChittyConnect at request time.

## Verification

After a 2xx response from `register.chitty.cc`:

```bash
curl -sS 'https://registry.chitty.cc/api/v1/search?q=chittycommand' | jq .
```

Expected: the new entry is returned with `tier: 2`, `category: "core-infrastructure"`, and the new P-Synthetic ChittyID.

Record the verification response (with the token field redacted) in a follow-up commit to `CHARTER.md` under a "Registration Evidence" section.

## ChittyCertify Next Step

Once registered, `chittycommand` is eligible for Tier-2 ChittyCertify audit. Open the audit request via the canonical ChittyCertify intake — do not self-assert the certification level in the payload (the payload's `certificationLevel` is `null` by design; ChittyCertify writes it).

## Rollback / Failure Handling

If `register.chitty.cc` rejects the submission:

1. Capture the full response body (headers + JSON) — redact token-shaped fields before storing.
2. Do NOT retry blindly.
3. File an issue against `chittyos/chittyregistry` referencing this runbook, the response body, and the payload shape (NOT the resolved token).
4. Diagnose the schema or auth mismatch before any second attempt. The `ServiceRegistrationSchema` in `chittyregistry/src/types/index.ts` is the authoritative shape — payload must match.

## What This Runbook Does NOT Do

- Does not submit the registration.
- Does not handle the bearer token directly — ChittyConnect owns that.
- Does not modify CHARTER/CHITTY/CLAUDE (PR #110's lane).
- Does not deploy any worker.
- Does not enable auto-merge on this PR.
