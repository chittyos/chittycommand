#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY_FILE="${ROOT_DIR}/.github/org-governance-policy.json"
REPORT_FILE="${ROOT_DIR}/reports/org-governance/latest.json"
DRY_RUN="false"
FAIL_ON_ERROR="true"

usage() {
  cat <<'USAGE'
Usage: org-governance-project-sync.sh [options]

Options:
  --policy <path>        Policy file
  --report <path>        Audit report JSON (array)
  --dry-run <bool>       Print intended actions only (default: false)
  --fail-on-error <bool> Exit non-zero if any update fails (default: true)
USAGE
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
    --fail-on-error)
      FAIL_ON_ERROR="$2"
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

enabled="$(jq -r '.projectAutomation.enabled // false' "${POLICY_FILE}")"
project_org="$(jq -r '.projectAutomation.org // empty' "${POLICY_FILE}")"
project_number="$(jq -r '.projectAutomation.projectNumber // 0' "${POLICY_FILE}")"
issue_title="$(jq -r '.complianceIssueTitle // "[Governance] CI/CD compliance gaps"' "${POLICY_FILE}")"

if [[ "${enabled}" != "true" ]]; then
  echo "Project sync disabled by policy (.projectAutomation.enabled=false)."
  exit 0
fi
if [[ -z "${project_org}" || "${project_number}" == "0" ]]; then
  echo "Project sync enabled but projectAutomation.org/projectAutomation.projectNumber not configured." >&2
  exit 1
fi

successes=0
failures=0
skipped=0

rows="$(jq -c '.[] | select(.compliant == false)' "${REPORT_FILE}")"
if [[ -z "${rows}" ]]; then
  echo "No non-compliant repos to sync into project board."
  exit 0
fi

while IFS= read -r row; do
  [[ -z "${row}" ]] && continue
  full_repo="$(jq -r '.fullRepo // empty' <<< "${row}")"
  [[ -z "${full_repo}" ]] && continue

  issue_url="$(gh issue list -R "${full_repo}" --state open --search "\"${issue_title}\" in:title" --json url,title --jq '.[] | select(.title=="'"${issue_title}"'") | .url' | head -n1 || true)"
  if [[ -z "${issue_url}" ]]; then
    echo "Skipped ${full_repo}: no open compliance issue to add to project."
    skipped=$((skipped + 1))
    continue
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] Would add ${issue_url} to project ${project_org}/${project_number}"
    skipped=$((skipped + 1))
    continue
  fi

  if gh project item-add "${project_number}" --owner "${project_org}" --url "${issue_url}" >/dev/null 2>&1; then
    echo "Added ${issue_url} to project ${project_org}/${project_number}"
    successes=$((successes + 1))
  else
    # Treat already-present items as non-fatal; gh currently returns generic failure text for duplicates.
    if gh project item-list "${project_number}" --owner "${project_org}" --format json 2>/dev/null | jq -e --arg u "${issue_url}" '.items[]? | select(.content.url == $u)' >/dev/null; then
      echo "Already present in project ${project_org}/${project_number}: ${issue_url}"
      skipped=$((skipped + 1))
    else
      echo "Failed to add ${issue_url} to project ${project_org}/${project_number}" >&2
      failures=$((failures + 1))
    fi
  fi
done <<< "${rows}"

echo "Project sync complete: success=${successes} failed=${failures} skipped=${skipped}"
if [[ "${FAIL_ON_ERROR}" == "true" && "${failures}" -gt 0 ]]; then
  exit 1
fi
