#!/usr/bin/env bash
set -euo pipefail

REPO=""
MODE="remediation"
FINDINGS=""
STRICT_MODE="${CHITTY_DISPATCH_STRICT:-false}"
BROKER_URL="${CHITTYCONNECT_ACCESS_BROKER_URL:-}"
BROKER_TOKEN="${CHITTYCONNECT_BROKER_TOKEN:-}"
DISPATCH_TIMEOUT_SEC="${CHITTY_DISPATCH_TIMEOUT_SEC:-15}"
LOCAL_AGENT_DISPATCH="${CHITTY_LOCAL_AGENT_DISPATCH:-true}"

usage() {
  cat <<'EOF'
Usage: chittycompliance-dispatch.sh --repo ORG/REPO [--mode remediation|adversarial] [--findings "..."]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    --findings)
      FINDINGS="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${REPO}" ]]; then
  echo "Missing --repo" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for broker response parsing" >&2
  exit 1
fi

task_payload="repo=${REPO}; mode=${MODE}; findings=${FINDINGS}"
echo "Dispatching chittycompliance agents: ${task_payload}" >&2

dispatch_success=0
gateway_url="${CHITTY_GATEWAY_DISPATCH_URL:-}"
gateway_token="${CHITTY_GATEWAY_TOKEN:-}"
orchestrator_url="${CHITTY_AGENT_ORCHESTRATOR_URL:-}"
orchestrator_token="${CHITTY_AGENT_TOKEN:-}"

# timeout wrapper for potentially slow commands.
run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${DISPATCH_TIMEOUT_SEC}" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "${DISPATCH_TIMEOUT_SEC}" "$@"
  else
    "$@"
  fi
}

# Primary access path: ask ChittyConnect broker for contextual, short-lived credentials.
if [[ -n "${BROKER_URL}" && -n "${BROKER_TOKEN}" ]]; then
  broker_response="$(run_with_timeout curl -fsS -X POST "${BROKER_URL}" \
    -H "Authorization: Bearer ${BROKER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc \
      --arg repo "${REPO}" \
      --arg mode "${MODE}" \
      --arg findings "${FINDINGS}" \
      --arg run_id "${GITHUB_RUN_ID:-local}" \
      --arg actor "${GITHUB_ACTOR:-local}" \
      --arg workflow "${GITHUB_WORKFLOW:-local}" \
      '{repo:$repo, mode:$mode, findings:$findings, context:{source:"org-governance-control-loop", run_id:$run_id, actor:$actor, workflow:$workflow}, requested_access:["gateway_dispatch","agent_orchestrator"]}')" 2>/dev/null || true)"

  if [[ -n "${broker_response}" ]]; then
    decision="$(jq -r '.decision // "deny"' <<< "${broker_response}" 2>/dev/null || echo "deny")"
    if [[ "${decision}" == "allow" ]]; then
      broker_gateway_url="$(jq -r '.gateway.url // empty' <<< "${broker_response}" 2>/dev/null || true)"
      broker_gateway_token="$(jq -r '.gateway.token // empty' <<< "${broker_response}" 2>/dev/null || true)"
      broker_orchestrator_url="$(jq -r '.orchestrator.url // empty' <<< "${broker_response}" 2>/dev/null || true)"
      broker_orchestrator_token="$(jq -r '.orchestrator.token // empty' <<< "${broker_response}" 2>/dev/null || true)"

      [[ -n "${broker_gateway_url}" ]] && gateway_url="${broker_gateway_url}"
      [[ -n "${broker_gateway_token}" ]] && gateway_token="${broker_gateway_token}"
      [[ -n "${broker_orchestrator_url}" ]] && orchestrator_url="${broker_orchestrator_url}"
      [[ -n "${broker_orchestrator_token}" ]] && orchestrator_token="${broker_orchestrator_token}"
    else
      reason="$(jq -r '.reason // "access denied by chittyconnect broker"' <<< "${broker_response}" 2>/dev/null || echo "access denied")"
      echo "ChittyConnect broker denied access: ${reason}" >&2
      if [[ "${STRICT_MODE}" == "true" ]]; then
        exit 3
      fi
    fi
  elif [[ "${STRICT_MODE}" == "true" ]]; then
    echo "ChittyConnect broker unavailable; strict mode enabled." >&2
    exit 3
  fi
elif [[ "${STRICT_MODE}" == "true" ]]; then
  echo "Missing ChittyConnect broker configuration in strict mode." >&2
  exit 3
fi

# Best-effort local agent dispatch. Non-blocking by design.
if [[ "${LOCAL_AGENT_DISPATCH}" == "true" ]] && command -v can >/dev/null 2>&1; then
  case "${MODE}" in
    remediation)
      run_with_timeout can chitty agent run chittyagent-canon "${task_payload}" >/dev/null 2>&1 || true
      run_with_timeout can chitty agent run chittyagent-connect "${task_payload}" >/dev/null 2>&1 || true
      run_with_timeout can chitty agent run chittyagent-register "${task_payload}" >/dev/null 2>&1 || true
      ;;
    adversarial)
      run_with_timeout can chitty agent run chittyagent-canon "adversarial-review ${task_payload}" >/dev/null 2>&1 || true
      run_with_timeout can chitty agent run chittyagent-neon-schema "adversarial-review ${task_payload}" >/dev/null 2>&1 || true
      ;;
  esac
fi

# Optional remote dispatch for centralized orchestration.
if [[ -n "${CHITTYCOMPLIANCE_AGENT_ENDPOINT:-}" ]]; then
  run_with_timeout curl -fsS -X POST "${CHITTYCOMPLIANCE_AGENT_ENDPOINT}" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg repo "${REPO}" --arg mode "${MODE}" --arg findings "${FINDINGS}" '{repo:$repo, mode:$mode, findings:$findings}')" >/dev/null && dispatch_success=1 || true
fi

# Primary path: ChittyGateway / ChittyAgent orchestrator on Cloudflare Workers AI.
if [[ -n "${gateway_url}" ]]; then
  auth_headers=()
  if [[ -n "${gateway_token}" ]]; then
    auth_headers+=(-H "Authorization: Bearer ${gateway_token}")
  fi
  run_with_timeout curl -fsS -X POST "${gateway_url}" \
    -H "Content-Type: application/json" \
    "${auth_headers[@]}" \
    -d "$(jq -nc --arg repo "${REPO}" --arg mode "${MODE}" --arg findings "${FINDINGS}" '{pipeline:"chittycompliance", repo:$repo, mode:$mode, findings:$findings}')" >/dev/null && dispatch_success=1 || true
fi

if [[ -n "${orchestrator_url}" ]]; then
  auth_headers=()
  if [[ -n "${orchestrator_token}" ]]; then
    auth_headers+=(-H "Authorization: Bearer ${orchestrator_token}")
  fi
  run_with_timeout curl -fsS -X POST "${orchestrator_url}" \
    -H "Content-Type: application/json" \
    "${auth_headers[@]}" \
    -d "$(jq -nc --arg repo "${REPO}" --arg mode "${MODE}" --arg findings "${FINDINGS}" '{operation:"governance_review", repo:$repo, mode:$mode, findings:$findings}')" >/dev/null && dispatch_success=1 || true
fi

if [[ "${STRICT_MODE}" == "true" && "${dispatch_success}" -eq 0 ]]; then
  echo "No successful remote dispatch in strict mode." >&2
  exit 4
fi

echo "Dispatch completed (best-effort)." >&2
