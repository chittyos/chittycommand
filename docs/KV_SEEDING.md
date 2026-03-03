# KV Seeding (Credentials + Discovery)

This service enforces safe access for the credentials proxy and rate limits connect discovery via KV-configured policies.

## Keys

- `credentials:allowlist` (JSON array)
  - Allowed ref patterns (exact or prefix with `*`), e.g. `"op://ChittyOS/*"`
- `credentials:subject_allowlist` (JSON array)
  - Allowed subjects like `svc:bridge-service` or `usr:<user_id>`
- `credentials:token_allowlist` (JSON array, optional)
  - SHA-256 hex of allowed Bearer tokens
- `credentials:rate_limit` (string int)
  - Per-minute limit for credentials proxy (default 12)
- `discover:rate_limit` (string int)
  - Per-minute limit for connect discovery (default 60)

## Seeding via script

1. Get the KV namespace id for `COMMAND_KV` (from wrangler.toml):
   - `wrangler kv:namespace list | grep COMMAND_KV`
2. Run the seed script (defaults are safe):

```
export KV_NAMESPACE_ID=<COMMAND_KV_ID>
# Optional: customize
export ALLOWLIST_JSON='["op://ChittyOS/*","op://Finance/*"]'
export SUBJECT_ALLOWLIST='["svc:bridge-service","usr:<your_user_id>"]'
# Optional: token hashes
export TOKEN_SHA256_LIST='["<sha256hex1>","<sha256hex2>"]'
# Limits (optional)
export CRED_RATE_LIMIT=12
export DISCOVER_RATE_LIMIT=60

npm run kv:seed
```

## Compute token hash

```
echo -n "$TOKEN" | shasum -a 256 | awk '{print $1}'
# or
printf %s "$TOKEN" | openssl dgst -sha256 | awk '{print $2}'
```

## Notes
- Ref allowlist supports prefix matches (`pattern*`).
- Requests are audited to `cc_actions_log` with redacted refs.
- Rate windows are tracked with `rate:*` keys and a 70s TTL.

