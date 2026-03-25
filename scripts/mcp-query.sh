#!/bin/bash
# Query ChittyCommand MCP endpoint with service token from KV
set -euo pipefail

TOOL="${1:?Usage: mcp-query.sh <tool_name> [json_args]}"
ARGS="${2:-\{\}}"

KV_ID=$(grep -A1 'COMMAND_KV' wrangler.toml | grep 'id' | head -1 | sed 's/.*= *"//;s/".*//')
TOKEN=$(npx wrangler kv key get "mcp:service_token" --namespace-id="$KV_ID" --remote 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Could not read mcp:service_token from KV" >&2
  exit 1
fi

PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'jsonrpc': '2.0',
    'id': 1,
    'method': 'tools/call',
    'params': {'name': '$TOOL', 'arguments': json.loads('$ARGS')}
}))
")

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "https://command.chitty.cc/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

echo "HTTP: $HTTP_CODE"
echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
