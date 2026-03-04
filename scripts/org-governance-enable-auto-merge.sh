#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_FILE="${ROOT_DIR}/reports/org-governance/latest.json"
DRY_RUN="false"

usage() {
  cat <<'EOF'
Usage: org-governance-enable-auto-merge.sh [options]

Options:
  --report <path>       Audit report JSON (array)
  --dry-run <bool>      Print actions only (default: false)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --report)
      REPORT_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="$2"
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

if [[ ! -f "${REPORT_FILE}" ]]; then
  echo "Missing report file: ${REPORT_FILE}" >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq required" >&2
  exit 1
fi

successes=0
failures=0
skipped=0

repos="$(jq -r '.[] | select(.archived==false) | .fullRepo' "${REPORT_FILE}" | sort -u)"
if [[ -z "${repos}" ]]; then
  echo "No repos in report."
  exit 0
fi

while IFS= read -r full_repo; do
  [[ -z "${full_repo}" ]] && continue
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] Would enable auto-merge in ${full_repo}"
    skipped=$((skipped + 1))
    continue
  fi

  if gh api -X PATCH "repos/${full_repo}" \
      -f allow_auto_merge=true \
      -f allow_squash_merge=true \
      -f allow_update_branch=true \
      -f delete_branch_on_merge=true \
      >/dev/null 2>&1; then
    successes=$((successes + 1))
    echo "Enabled auto-merge in ${full_repo}"
  else
    failures=$((failures + 1))
    echo "Failed to enable auto-merge in ${full_repo}" >&2
  fi
done <<< "${repos}"

echo "Auto-merge settings update complete: success=${successes} failed=${failures} skipped=${skipped}"
if [[ "${failures}" -gt 0 ]]; then
  exit 1
fi
