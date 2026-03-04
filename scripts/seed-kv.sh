#!/usr/bin/env bash
set -euo pipefail

# Seed KV allowlists and rate limits for chittycommand
# Usage:
#   scripts/seed-kv.sh <KV_NAMESPACE_ID>
#
# Optional environment variables:
#   TOKEN_SHA256_LIST   JSON array of sha256 hex token hashes (e.g., '["abc123..."]')
#   ALLOWLIST_JSON      JSON array of allowlist patterns (default: '["op://ChittyOS/*"]')
#   SUBJECT_ALLOWLIST   JSON array of subjects (default: '["svc:bridge-service"]')
#   CRED_RATE_LIMIT     Integer per-minute limit (default: 12)
#   DISCOVER_RATE_LIMIT Integer per-minute limit (default: 60)

NS_ID=${1:-}
if [ -z "$NS_ID" ]; then
  echo "Usage: $0 <KV_NAMESPACE_ID>" >&2
  exit 1
fi

ALLOWLIST_JSON=${ALLOWLIST_JSON:-'["op://ChittyOS/*"]'}
SUBJECT_ALLOWLIST=${SUBJECT_ALLOWLIST:-'["svc:bridge-service"]'}
CRED_RATE_LIMIT=${CRED_RATE_LIMIT:-12}
DISCOVER_RATE_LIMIT=${DISCOVER_RATE_LIMIT:-60}

echo "Seeding COMMAND_KV namespace: $NS_ID"

wrangler kv key put --namespace-id "$NS_ID" credentials:allowlist "$ALLOWLIST_JSON"
wrangler kv key put --namespace-id "$NS_ID" credentials:subject_allowlist "$SUBJECT_ALLOWLIST"
wrangler kv key put --namespace-id "$NS_ID" credentials:rate_limit "$CRED_RATE_LIMIT"
wrangler kv key put --namespace-id "$NS_ID" discover:rate_limit "$DISCOVER_RATE_LIMIT"

if [ -n "${TOKEN_SHA256_LIST:-}" ]; then
  wrangler kv key put --namespace-id "$NS_ID" credentials:token_allowlist "$TOKEN_SHA256_LIST"
fi

echo "KV seed complete."
