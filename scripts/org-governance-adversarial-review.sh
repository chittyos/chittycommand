#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY_FILE="${ROOT_DIR}/.github/org-governance-policy.json"
REPORT_FILE="${ROOT_DIR}/reports/org-governance/latest.json"

usage() {
  cat <<'EOF'
Usage: org-governance-adversarial-review.sh [options]

Options:
  --policy <path>       Policy file
  --report <path>       Audit report JSON (array)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --policy)
      POLICY_FILE="$2"
      shift 2
      ;;
    --report)
      REPORT_FILE="$2"
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

ISSUE_TITLE="$(jq -r '.complianceIssueTitle // "[Governance] CI/CD compliance gaps"' "${POLICY_FILE}")"

rows="$(jq -c '.[] | select(.compliant == false)' "${REPORT_FILE}")"
if [[ -z "${rows}" ]]; then
  echo "Adversarial review: no non-compliant repos in report."
  exit 0
fi

while IFS= read -r row; do
  [[ -z "${row}" ]] && continue
  full_repo="$(jq -r '.fullRepo' <<< "${row}")"
  score="$(jq -r '.score' <<< "${row}")"
  missing_files="$(jq -r '(.missingFiles // []) | join(", ")' <<< "${row}")"
  missing_patterns="$(jq -r '(.missingPatterns // []) | join(", ")' <<< "${row}")"
  missing_triggers="$(jq -r '(.missingTriggers // []) | join(", ")' <<< "${row}")"
  missing_status_checks="$(jq -r '.missingStatusChecks // [] | join(", ")' <<< "${row}")"
  missing_repo_settings="$(jq -r '.missingRepoSettings // [] | join(", ")' <<< "${row}")"

  review_body=$(
    cat <<EOF
Adversarial review checkpoint:

- Status: NON-COMPLIANT
- Score: ${score}%
- Missing files: ${missing_files:-none}
- Missing onboarding/policy patterns: ${missing_patterns:-none}
- Missing triggers: ${missing_triggers:-none}
- Missing status checks: ${missing_status_checks:-none}
- Missing repo settings: ${missing_repo_settings:-none}

Control loop will continue remediation until compliance is reached.
EOF
  )

  issue_num="$(gh issue list -R "${full_repo}" --state open --search "\"${ISSUE_TITLE}\" in:title" --json number,title --jq '.[] | select(.title=="'"${ISSUE_TITLE}"'") | .number' | head -n1 || true)"
  if [[ -n "${issue_num}" ]]; then
    gh issue comment -R "${full_repo}" "${issue_num}" --body "${review_body}" >/dev/null || true
  fi

  bash "${ROOT_DIR}/scripts/chittycompliance-dispatch.sh" \
    --repo "${full_repo}" \
    --mode adversarial \
    --findings "score=${score};missing_files=${missing_files};missing_patterns=${missing_patterns};missing_triggers=${missing_triggers};missing_status_checks=${missing_status_checks};missing_repo_settings=${missing_repo_settings}" || true
done <<< "${rows}"

echo "Adversarial review loop complete."
