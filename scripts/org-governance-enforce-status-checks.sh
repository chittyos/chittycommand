#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY_FILE="${ROOT_DIR}/.github/org-governance-policy.json"
REPORT_FILE="${ROOT_DIR}/reports/org-governance/latest.json"
DRY_RUN="false"

usage() {
  cat <<'EOF'
Usage: org-governance-enforce-status-checks.sh [options]

Options:
  --policy <path>       Policy file
  --report <path>       Audit report JSON (array)
  --dry-run <bool>      Print actions only (default: false)
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

if [[ ! -f "${POLICY_FILE}" ]]; then
  echo "Missing policy file: ${POLICY_FILE}" >&2
  exit 1
fi
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

use_org_rulesets="$(jq -r '.useOrgRulesets // false' "${POLICY_FILE}")"
has_branch_ruleset="$(jq -r 'if .orgRulesets.branch then "true" else "false" end' "${POLICY_FILE}")"
if [[ "${use_org_rulesets}" == "true" && "${has_branch_ruleset}" == "true" ]]; then
  echo "Org rulesets are enabled; skipping legacy branch-protection status-check enforcement."
  exit 0
fi

required_checks="$(jq -c '.requiredStatusChecks // []' "${POLICY_FILE}")"
if [[ "${required_checks}" == "[]" ]]; then
  echo "No required status checks defined; nothing to enforce."
  exit 0
fi
required_review_count="$(jq -r '.requiredApprovingReviewCount // 1' "${POLICY_FILE}")"
if [[ ! "${required_review_count}" =~ ^[0-9]+$ ]]; then
  echo "Invalid requiredApprovingReviewCount in policy: ${required_review_count}" >&2
  exit 1
fi

successes=0
failures=0
skipped=0

rows="$(jq -c '.[] | select(.archived == false)' "${REPORT_FILE}")"
if [[ -z "${rows}" ]]; then
  echo "No active repos in report."
  exit 0
fi

while IFS= read -r row; do
  [[ -z "${row}" ]] && continue
  full_repo="$(jq -r '.fullRepo' <<< "${row}")"
  default_branch="$(jq -r '.defaultBranch // empty' <<< "${row}")"

  if [[ -z "${default_branch}" ]]; then
    echo "Skipped ${full_repo}: missing default branch."
    skipped=$((skipped + 1))
    continue
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] Would enforce branch protection checks on ${full_repo}:${default_branch}"
    skipped=$((skipped + 1))
    continue
  fi

  # If branch protection exists, patch only the required status checks and review/admin controls.
  if gh api -X PATCH "repos/${full_repo}/branches/${default_branch}/protection/required_status_checks" \
      --input <(jq -n --argjson checks "${required_checks}" '{strict:true,contexts:$checks}') >/dev/null 2>&1; then
    gh api -X POST "repos/${full_repo}/branches/${default_branch}/protection/enforce_admins" >/dev/null 2>&1 || true
    gh api -X PATCH "repos/${full_repo}/branches/${default_branch}/protection/required_pull_request_reviews" \
      --input <(jq -n --argjson count "${required_review_count}" '{dismiss_stale_reviews:true,require_code_owner_reviews:false,required_approving_review_count:$count}') >/dev/null 2>&1 || true
    echo "Enforced checks on protected branch ${full_repo}:${default_branch}"
    successes=$((successes + 1))
    continue
  fi

  # If protection does not exist, create a fail-closed baseline.
  if gh api -X PUT "repos/${full_repo}/branches/${default_branch}/protection" \
      --input <(jq -n \
        --argjson checks "${required_checks}" \
        --argjson count "${required_review_count}" '{
        required_status_checks:{strict:true,contexts:$checks},
        enforce_admins:true,
        required_pull_request_reviews:{
          dismiss_stale_reviews:true,
          require_code_owner_reviews:false,
          required_approving_review_count:$count
        },
        restrictions:null
      }') >/dev/null 2>&1; then
    echo "Created branch protection baseline ${full_repo}:${default_branch}"
    successes=$((successes + 1))
  else
    echo "Failed to enforce branch protection checks on ${full_repo}:${default_branch}" >&2
    failures=$((failures + 1))
  fi
done <<< "${rows}"

echo "Status-check enforcement complete: success=${successes} failed=${failures} skipped=${skipped}"
if [[ "${failures}" -gt 0 ]]; then
  exit 1
fi
