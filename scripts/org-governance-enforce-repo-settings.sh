#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY_FILE="${ROOT_DIR}/.github/org-governance-policy.json"
REPORT_FILE="${ROOT_DIR}/reports/org-governance/latest.json"
DRY_RUN="false"
FAIL_ON_ERROR="true"

usage() {
  cat <<'USAGE'
Usage: org-governance-enforce-repo-settings.sh [options]

Options:
  --policy <path>        Policy file
  --report <path>        Audit report JSON (array)
  --dry-run <bool>       Print intended actions only (default: false)
  --fail-on-error <bool> Exit non-zero if any repo update fails (default: true)
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

enforce_default_branch="$(jq -r '.repoSettings.enforceDefaultBranchName // false' "${POLICY_FILE}")"
expected_default_branch="$(jq -r '.repoSettings.defaultBranchName // empty' "${POLICY_FILE}")"
set_default_when_present="$(jq -r '.repoSettings.setDefaultBranchWhenPresent // true' "${POLICY_FILE}")"
push_policy_enabled="$(jq -r '.repoSettings.pushPolicy.enabled // false' "${POLICY_FILE}")"
push_policy_max_ref_updates="$(jq -r '.repoSettings.pushPolicy.maxRefUpdates // 0' "${POLICY_FILE}")"

if [[ "${enforce_default_branch}" != "true" && "${push_policy_enabled}" != "true" ]]; then
  echo "Repo settings enforcement disabled by policy."
  exit 0
fi
if [[ "${push_policy_enabled}" == "true" && ! "${push_policy_max_ref_updates}" =~ ^[0-9]+$ ]]; then
  echo "Invalid repoSettings.pushPolicy.maxRefUpdates: ${push_policy_max_ref_updates}" >&2
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
  full_repo="$(jq -r '.fullRepo // empty' <<< "${row}")"
  current_default_branch="$(jq -r '.defaultBranch // empty' <<< "${row}")"

  if [[ -z "${full_repo}" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  repo_failed=false

  if [[ "${enforce_default_branch}" == "true" && -n "${expected_default_branch}" && "${current_default_branch}" != "${expected_default_branch}" ]]; then
    if [[ "${DRY_RUN}" == "true" ]]; then
      echo "[DRY-RUN] Would set default branch ${full_repo}: ${current_default_branch} -> ${expected_default_branch}"
    elif [[ "${set_default_when_present}" != "true" ]]; then
      echo "Policy disallows default branch mutation for ${full_repo}" >&2
      repo_failed=true
    elif gh api "repos/${full_repo}/branches/${expected_default_branch}" >/dev/null 2>&1; then
      if gh api -X PATCH "repos/${full_repo}" -F default_branch="${expected_default_branch}" >/dev/null 2>&1; then
        echo "Set default branch ${full_repo}: ${current_default_branch} -> ${expected_default_branch}"
      else
        echo "Failed to set default branch for ${full_repo}" >&2
        repo_failed=true
      fi
    else
      echo "Failed to set default branch for ${full_repo}: branch ${expected_default_branch} does not exist" >&2
      repo_failed=true
    fi
  fi

  if [[ "${push_policy_enabled}" == "true" ]]; then
    current_max_ref_updates="$(gh api "repos/${full_repo}" --jq '.max_ref_updates // 0' 2>/dev/null || echo "")"
    if [[ -z "${current_max_ref_updates}" ]]; then
      echo "Failed to read current push policy for ${full_repo}" >&2
      repo_failed=true
    elif [[ "${current_max_ref_updates}" != "${push_policy_max_ref_updates}" ]]; then
      if [[ "${DRY_RUN}" == "true" ]]; then
        echo "[DRY-RUN] Would set max_ref_updates ${full_repo}: ${current_max_ref_updates} -> ${push_policy_max_ref_updates}"
      elif gh api -X PATCH "repos/${full_repo}" -F max_ref_updates="${push_policy_max_ref_updates}" >/dev/null 2>&1; then
        echo "Set max_ref_updates ${full_repo}: ${current_max_ref_updates} -> ${push_policy_max_ref_updates}"
      else
        echo "Failed to set max_ref_updates for ${full_repo}" >&2
        repo_failed=true
      fi
    fi
  fi

  if [[ "${repo_failed}" == "true" ]]; then
    failures=$((failures + 1))
  else
    successes=$((successes + 1))
  fi
done <<< "${rows}"

echo "Repo settings enforcement complete: success=${successes} failed=${failures} skipped=${skipped}"
if [[ "${FAIL_ON_ERROR}" == "true" && "${failures}" -gt 0 ]]; then
  exit 1
fi
