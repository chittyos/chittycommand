# Secret Rotation Checklist

Use this checklist when any credential is suspected to have been exposed in git history, logs, CI artifacts, or chat output.

## 1) Contain
- Identify affected secret types (`API key`, `OAuth client secret`, `DB password`, `service token`, `private key`).
- Disable compromised credentials immediately when possible.
- Freeze deploys until rotation is complete for production-impacting secrets.

## 2) Rotate
- Generate replacement credentials in source systems (Cloudflare, GitHub, Neon, 1Password-backed systems, etc.).
- Update runtime secret stores first:
  - GitHub Actions secrets
  - Cloudflare Worker secrets / KV references
  - 1Password items used by automation
- Verify old credentials are revoked, not just replaced.

## 3) Purge History (if committed)
- Rewrite git history to remove the secret-bearing blobs using `git filter-repo`.
- Force-push rewritten refs.
- Invalidate all existing clones and CI caches that still contain old history.

## 4) Validate
- Run secret scans on:
  - git history
  - worktree
  - CI logs/artifacts (if applicable)
- Confirm no active tokens from the old set can authenticate.

## 5) Recover Safely
- Re-enable deploy pipeline only after validation passes.
- Document incident timeline, impacted systems, and final revocation evidence.
- Add or tighten guards to prevent recurrence (CI secret scan, policy gate, allowlist checks).

## Command References
```bash
# History scan
gitleaks git --redact --log-opts="--all" --exit-code 1

# Worktree scan
gitleaks dir . --redact --exit-code 1
```
