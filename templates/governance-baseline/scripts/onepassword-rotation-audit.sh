#!/usr/bin/env bash
set -euo pipefail

CATALOG_FILE="${1:-.github/secret-catalog.json}"
OUT_DIR="${2:-reports/secret-rotation}"

if ! command -v op >/dev/null 2>&1; then
  echo "1Password CLI (op) is required." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

if [[ ! -f "${CATALOG_FILE}" ]]; then
  echo "Missing secret catalog: ${CATALOG_FILE}" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
json_path="${OUT_DIR}/rotation-${timestamp}.json"
md_path="${OUT_DIR}/rotation-${timestamp}.md"

rows='[]'
stale_count=0
total=0

while IFS= read -r row; do
  [[ -z "${row}" ]] && continue
  total=$((total + 1))
  name="$(jq -r '.name' <<< "${row}")"
  op_ref="$(jq -r '.op_ref' <<< "${row}")"
  rotation_days="$(jq -r '.rotation_days' <<< "${row}")"
  owner="$(jq -r '.owner // "unknown"' <<< "${row}")"

  item_ref="${op_ref%/*}"
  item_json="$(op item get "${item_ref}" --format json 2>/dev/null || true)"
  if [[ -z "${item_json}" ]]; then
    rows="$(jq -c --arg name "${name}" --arg owner "${owner}" \
      '. + [{"name":$name,"owner":$owner,"status":"missing","age_days":null,"rotation_days":null}]' <<< "${rows}")"
    stale_count=$((stale_count + 1))
    continue
  fi

  updated_at="$(jq -r '.updated_at // .created_at // empty' <<< "${item_json}")"
  if [[ -z "${updated_at}" ]]; then
    rows="$(jq -c --arg name "${name}" --arg owner "${owner}" \
      '. + [{"name":$name,"owner":$owner,"status":"unknown_age","age_days":null,"rotation_days":null}]' <<< "${rows}")"
    stale_count=$((stale_count + 1))
    continue
  fi

  age_days="$(
    python3 - <<'PY' "${updated_at}"
from datetime import datetime, timezone
import sys
v=sys.argv[1]
if v.endswith('Z'):
    v=v[:-1] + '+00:00'
d=datetime.fromisoformat(v)
if d.tzinfo is None:
    d=d.replace(tzinfo=timezone.utc)
now=datetime.now(timezone.utc)
print((now-d).days)
PY
  )"

  status="ok"
  if [[ "${age_days}" -ge "${rotation_days}" ]]; then
    status="stale"
    stale_count=$((stale_count + 1))
  fi

  rows="$(jq -c \
    --arg name "${name}" \
    --arg owner "${owner}" \
    --arg status "${status}" \
    --argjson age_days "${age_days}" \
    --argjson rotation_days "${rotation_days}" \
    '. + [{"name":$name,"owner":$owner,"status":$status,"age_days":$age_days,"rotation_days":$rotation_days}]' <<< "${rows}")"
done < <(jq -c '.secrets[]' "${CATALOG_FILE}")

jq -nc \
  --arg timestamp "${timestamp}" \
  --arg catalog "${CATALOG_FILE}" \
  --argjson total "${total}" \
  --argjson stale "${stale_count}" \
  --argjson entries "${rows}" \
  '{timestamp:$timestamp,catalog:$catalog,total:$total,stale:$stale,entries:$entries}' > "${json_path}"
cp "${json_path}" "${OUT_DIR}/latest.json"

{
  echo "# 1Password Rotation Audit"
  echo
  echo "- Timestamp: ${timestamp}"
  echo "- Catalog: ${CATALOG_FILE}"
  echo "- Secrets audited: ${total}"
  echo "- Non-compliant (stale/missing): ${stale_count}"
  echo
  echo "| Name | Owner | Status | Age (days) | Rotation window (days) |"
  echo "|---|---|---|---:|---:|"
  jq -r '.entries[] | "| \(.name) | \(.owner) | \(.status) | \(.age_days // "n/a") | \(.rotation_days // "n/a") |"' "${json_path}"
} > "${md_path}"
cp "${md_path}" "${OUT_DIR}/latest.md"

echo "Wrote ${json_path}"
echo "Wrote ${md_path}"

if [[ "${stale_count}" -gt 0 ]]; then
  echo "Rotation audit failed: ${stale_count} secret(s) out of policy." >&2
  exit 2
fi
