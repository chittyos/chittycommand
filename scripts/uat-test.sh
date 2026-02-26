#!/usr/bin/env bash
# UAT Scenario Test — ChittyCommand Production
# Usage: source /tmp/chittycommand-uat.env && bash scripts/uat-test.sh
#
# Tests all user-facing API paths that power the Action Queue,
# Payment Planner, Revenue, and Cash Flow features.

set -uo pipefail

BASE="https://command.chitty.cc"
TOKEN="${UAT_TOKEN:?UAT_TOKEN not set — source /tmp/chittycommand-uat.env first}"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

PASS=0
FAIL=0
WARN=0

# ── Helpers ──────────────────────────────────────────────────

auth_header="Authorization: Bearer ${TOKEN}"

# Write response to a temp file, return filename
api_get() {
  local out="${TMPDIR}/$(openssl rand -hex 4).json"
  curl -s --max-time 30 -H "$auth_header" "${BASE}${1}" > "$out" 2>/dev/null || echo '{}' > "$out"
  echo "$out"
}

api_post() {
  local url="$1"
  local body="${2:-}"
  if [ -z "$body" ]; then body='{}'; fi
  local out="${TMPDIR}/$(openssl rand -hex 4).json"
  curl -s --max-time 60 -H "$auth_header" -H "Content-Type: application/json" -X POST -d "$body" "${BASE}${url}" > "$out" 2>/dev/null || echo '{}' > "$out"
  echo "$out"
}

check() {
  local label="$1" file="$2" expect="$3"
  if python3 -c "
import sys, json
with open('${file}') as f:
    data = json.load(f)
${expect}
" 2>/dev/null; then
    echo "  ✓ ${label}"
    PASS=$((PASS+1))
  else
    echo "  ✗ ${label}"
    echo "    Response: $(head -c 200 "$file")"
    FAIL=$((FAIL+1))
  fi
}

check_status() {
  local label="$1" url="$2" method="${3:-GET}"
  local status
  if [ "$method" = "POST" ]; then
    local body="${4:-}"
    if [ -z "$body" ]; then body='{}'; fi
    status=$(curl -s --max-time 60 -o /dev/null -w "%{http_code}" -H "$auth_header" -H "Content-Type: application/json" -X POST -d "$body" "${BASE}${url}")
  else
    status=$(curl -s --max-time 30 -o /dev/null -w "%{http_code}" -H "$auth_header" "${BASE}${url}")
  fi
  if [ "$status" = "200" ]; then
    echo "  ✓ ${label} (${status})"
    PASS=$((PASS+1))
  elif [ "$status" = "404" ] || [ "$status" = "500" ]; then
    echo "  ✗ ${label} (${status})"
    FAIL=$((FAIL+1))
  else
    echo "  ~ ${label} (${status})"
    WARN=$((WARN+1))
  fi
}

# Read a field from a JSON file
jq_read() {
  python3 -c "
import json
with open('${1}') as f:
    data = json.load(f)
${2}
" 2>/dev/null
}

DELAY=${UAT_DELAY:-3}  # seconds between test sections (avoids Hyperdrive pool contention)

echo "═══════════════════════════════════════════"
echo "  ChittyCommand UAT — $(date '+%Y-%m-%d %H:%M')"
echo "  Target: ${BASE}  (delay: ${DELAY}s)"
echo "═══════════════════════════════════════════"
echo ""

# ── 1. Health ────────────────────────────────────────────────
echo "1. Health Check"
HEALTH=$(api_get "/health")
check "GET /health returns ok" "$HEALTH" "assert data['status'] == 'ok'"
echo ""; sleep $DELAY

# ── 2. Auth ──────────────────────────────────────────────────
echo "2. Authentication"
AUTH_RESULT=$(api_get "/api/dashboard")
check "Token authenticates against /api/dashboard" "$AUTH_RESULT" "assert 'error' not in data or data.get('summary') is not None"
echo ""; sleep $DELAY

# ── 3. Dashboard ─────────────────────────────────────────────
echo "3. Dashboard (FocusView data source)"
DASH=$(api_get "/api/dashboard")
check "Dashboard returns summary" "$DASH" "assert 'summary' in data"
check "Dashboard returns obligations" "$DASH" "assert 'obligations' in data"
check "Dashboard returns recommendations" "$DASH" "assert 'recommendations' in data"
echo ""; sleep $DELAY

# ── 4. Action Queue ──────────────────────────────────────────
echo "4. Action Queue"
QUEUE=$(api_get "/api/queue?limit=5")
check "GET /api/queue returns array" "$QUEUE" "assert isinstance(data, list)"

STATS=$(api_get "/api/queue/stats")
check "GET /api/queue/stats returns counts" "$STATS" "assert 'approved' in data and 'total' in data"

HIST=$(api_get "/api/queue/history?limit=5")
check "GET /api/queue/history returns array" "$HIST" "assert isinstance(data, list)"

# Test decide flow (only if queue has items)
QUEUE_LEN=$(jq_read "$QUEUE" "print(len(data) if isinstance(data, list) else 0)" || echo "0")
if [ "$QUEUE_LEN" -gt "0" ] 2>/dev/null; then
  FIRST_ID=$(jq_read "$QUEUE" "print(data[0]['id'])")
  UAT_SESSION=$(python3 -c "import uuid; print(uuid.uuid4())")
  DECIDE=$(api_post "/api/queue/${FIRST_ID}/decide" "{\"decision\":\"deferred\",\"session_id\":\"${UAT_SESSION}\"}")
  check "POST /api/queue/:id/decide works" "$DECIDE" "assert 'decided' in data"
else
  echo "  ~ Queue empty — skipping decide test"
  WARN=$((WARN+1))
fi
echo ""; sleep $DELAY

# ── 5. Obligations ───────────────────────────────────────────
echo "5. Obligations"
OBLIGATIONS=$(api_get "/api/obligations?status=pending")
check "GET /api/obligations returns array" "$OBLIGATIONS" "assert isinstance(data, list)"
OB_COUNT=$(jq_read "$OBLIGATIONS" "print(len(data) if isinstance(data, list) else 0)" || echo "0")
echo "  → ${OB_COUNT} pending obligations"

FIRST_OB_ID=""
if [ "$OB_COUNT" -gt "0" ] 2>/dev/null; then
  FIRST_OB_ID=$(jq_read "$OBLIGATIONS" "print(data[0]['id'])")
fi
echo ""; sleep $DELAY

# ── 6. Cash Flow Projections ─────────────────────────────────
echo "6. Cash Flow — Projections"
PROJ=$(api_get "/api/cashflow/projections")
check "GET /api/cashflow/projections returns array" "$PROJ" "assert isinstance(data, list)"
PROJ_COUNT=$(jq_read "$PROJ" "print(len(data) if isinstance(data, list) else 0)" || echo "0")
echo "  → ${PROJ_COUNT} projection days"

if [ "$PROJ_COUNT" = "0" ]; then
  echo "  → Generating projections..."
  GEN=$(api_post "/api/cashflow/generate")
  check "POST /api/cashflow/generate works" "$GEN" "assert 'starting_balance' in data"
fi
echo ""; sleep $DELAY

# ── 7. Cash Flow Scenario ────────────────────────────────────
echo "7. Cash Flow — Scenario"
sleep 1
if [ -n "$FIRST_OB_ID" ]; then
  SCENARIO=$(api_post "/api/cashflow/scenario" "{\"defer_obligation_ids\":[\"${FIRST_OB_ID}\"]}")
  check "POST /api/cashflow/scenario works" "$SCENARIO" "assert 'projected_balance' in data"
else
  echo "  ~ No obligations for scenario test"
  WARN=$((WARN+1))
fi
echo ""; sleep $DELAY

# ── 8. Payment Planner ───────────────────────────────────────
echo "8. Payment Planner"
PLAN=$(api_get "/api/payment-plan")
check "GET /api/payment-plan returns plan or null" "$PLAN" "assert data is None or 'plan_type' in data"

echo "  → Generating optimal plan..."
sleep 2
GEN_PLAN=$(api_post "/api/payment-plan/generate" '{"strategy":"optimal","horizon_days":90}')
check "POST /api/payment-plan/generate works" "$GEN_PLAN" "assert 'starting_balance' in data and 'schedule' in data"

# Validate schedule is parseable
check "Plan schedule is valid JSON array" "$GEN_PLAN" "
schedule = data.get('schedule', '[]')
if isinstance(schedule, str):
    import json as j
    schedule = j.loads(schedule)
assert isinstance(schedule, list)
"

# Validate warnings field
check "Plan warnings is valid JSON array" "$GEN_PLAN" "
warnings = data.get('warnings', '[]')
if isinstance(warnings, str):
    import json as j
    warnings = j.loads(warnings)
assert isinstance(warnings, list)
"

# Validate revenue summary
check "Plan includes revenue summary" "$GEN_PLAN" "assert 'revenue_summary' in data and isinstance(data['revenue_summary'], list)"

# Simulate scenario
echo "  → Simulating with deferrals..."
sleep 2
if [ -n "$FIRST_OB_ID" ]; then
  SIM=$(api_post "/api/payment-plan/simulate" "{\"strategy\":\"optimal\",\"defer_ids\":[\"${FIRST_OB_ID}\"]}")
  check "POST /api/payment-plan/simulate works" "$SIM" "assert 'starting_balance' in data"
else
  echo "  ~ No obligations for simulation"
  WARN=$((WARN+1))
fi

# Test all 3 strategies
for STRAT in optimal conservative aggressive; do
  sleep 2
  check_status "Generate ${STRAT} plan" "/api/payment-plan/generate" "POST" "{\"strategy\":\"${STRAT}\"}"
done
echo ""; sleep $DELAY

# ── 9. Revenue Sources ───────────────────────────────────────
echo "9. Revenue Sources"
REVENUE=$(api_get "/api/revenue")
check "GET /api/revenue returns sources + summary" "$REVENUE" "assert 'sources' in data and 'summary' in data"
REV_COUNT=$(jq_read "$REVENUE" "print(len(data.get('sources', [])))" || echo "0")
echo "  → ${REV_COUNT} revenue sources"

echo "  → Running revenue discovery..."
DISCOVER=$(api_post "/api/revenue/discover")
check "POST /api/revenue/discover works" "$DISCOVER" "assert 'sources_discovered' in data"
echo ""; sleep $DELAY

# ── 10. Accounts ─────────────────────────────────────────────
echo "10. Accounts"
ACCOUNTS=$(api_get "/api/accounts")
check "GET /api/accounts returns array" "$ACCOUNTS" "assert isinstance(data, list)"
ACCT_COUNT=$(jq_read "$ACCOUNTS" "print(len(data) if isinstance(data, list) else 0)" || echo "0")
echo "  → ${ACCT_COUNT} accounts"
echo ""; sleep $DELAY

# ── 11. Disputes ─────────────────────────────────────────────
echo "11. Disputes"
DISPUTES=$(api_get "/api/disputes")
check "GET /api/disputes returns array" "$DISPUTES" "assert isinstance(data, list)"
echo ""; sleep $DELAY

# ── 12. Legal ────────────────────────────────────────────────
echo "12. Legal Deadlines"
LEGAL=$(api_get "/api/legal")
check "GET /api/legal returns array" "$LEGAL" "assert isinstance(data, list)"
echo ""; sleep $DELAY

# ── 13. Recommendations ─────────────────────────────────────
echo "13. Recommendations"
RECS=$(api_get "/api/recommendations")
check "GET /api/recommendations returns array" "$RECS" "assert isinstance(data, list)"
echo ""; sleep $DELAY

# ── 14. Sync Status ─────────────────────────────────────────
echo "14. Sync Status"
SYNC=$(api_get "/api/sync/status")
check "GET /api/sync/status returns array" "$SYNC" "assert isinstance(data, list)"
echo ""; sleep $DELAY

# ── 15. Email Connections ────────────────────────────────────
echo "15. Email Connections"
EMAIL=$(api_get "/api/email-connections")
check "GET /api/email-connections returns data" "$EMAIL" "assert 'connections' in data"
echo ""

# ── Summary ──────────────────────────────────────────────────
echo "═══════════════════════════════════════════"
echo "  Results: ${PASS} passed, ${FAIL} failed, ${WARN} warnings"
echo "═══════════════════════════════════════════"

if [ "$FAIL" -gt "0" ]; then
  exit 1
fi
