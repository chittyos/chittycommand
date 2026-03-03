#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY_FILE="${ROOT_DIR}/.github/org-governance-policy.json"
OUT_DIR="${ROOT_DIR}/reports/org-governance"
MAX_REPOS_OVERRIDE=""
declare -a ORGS=()

usage() {
  cat <<'EOF'
Usage: org-governance-audit.sh [options]

Options:
  --policy <path>       Policy JSON file (default: .github/org-governance-policy.json)
  --out-dir <path>      Output directory (default: reports/org-governance)
  --org <name>          Org override (repeatable)
  --max-repos <n>       Limit repos per org for quick runs (0 = no limit)
  --help                Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --policy)
      POLICY_FILE="$2"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --org)
      ORGS+=("$2")
      shift 2
      ;;
    --max-repos)
      MAX_REPOS_OVERRIDE="$2"
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

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq required" >&2
  exit 1
fi

if [[ ! -f "${POLICY_FILE}" ]]; then
  echo "Missing policy file: ${POLICY_FILE}" >&2
  exit 1
fi

if [[ ${#ORGS[@]} -eq 0 ]]; then
  orgs_from_policy="$(jq -r '.orgs[]' "${POLICY_FILE}")"
  while IFS= read -r org; do
    [[ -z "${org}" ]] && continue
    ORGS+=("${org}")
  done <<< "${orgs_from_policy}"
fi

INCLUDE_ARCHIVED="$(jq -r '.includeArchived // false' "${POLICY_FILE}")"
REQUIRE_BRANCH_PROTECTION="$(jq -r '.requireBranchProtection // true' "${POLICY_FILE}")"
MAX_REPOS_POLICY="$(jq -r '.maxReposPerOrg // 0' "${POLICY_FILE}")"
MAX_REPOS="${MAX_REPOS_POLICY}"
if [[ -n "${MAX_REPOS_OVERRIDE}" ]]; then
  MAX_REPOS="${MAX_REPOS_OVERRIDE}"
fi

REQUIRED_FILES_JSON="$(jq -c '.requiredFiles // []' "${POLICY_FILE}")"
REQUIRED_TRIGGERS_JSON="$(jq -c '.requiredWorkflowTriggers // {}' "${POLICY_FILE}")"
REQUIRED_STATUS_CHECKS_JSON="$(jq -c '.requiredStatusChecks // []' "${POLICY_FILE}")"
REQUIRED_FILE_PATTERNS_JSON="$(jq -c '.requiredFilePatterns // {}' "${POLICY_FILE}")"
ENFORCE_DEFAULT_BRANCH_NAME="$(jq -r '.repoSettings.enforceDefaultBranchName // false' "${POLICY_FILE}")"
DEFAULT_BRANCH_NAME="$(jq -r '.repoSettings.defaultBranchName // ""' "${POLICY_FILE}")"
PUSH_POLICY_ENABLED="$(jq -r '.repoSettings.pushPolicy.enabled // false' "${POLICY_FILE}")"
PUSH_POLICY_MAX_REF_UPDATES="$(jq -r '.repoSettings.pushPolicy.maxRefUpdates // 0' "${POLICY_FILE}")"

mkdir -p "${OUT_DIR}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
JSONL_PATH="${OUT_DIR}/report-${TIMESTAMP}.jsonl"
JSON_PATH="${OUT_DIR}/report-${TIMESTAMP}.json"
MD_PATH="${OUT_DIR}/report-${TIMESTAMP}.md"

touch "${JSONL_PATH}"

repo_cursor() {
  local org="$1"
  if gh api "/orgs/${org}" >/dev/null 2>&1; then
    gh api --paginate "/orgs/${org}/repos?per_page=100&type=all"
    return
  fi
  if gh api "/users/${org}" >/dev/null 2>&1; then
    gh api --paginate "/users/${org}/repos?per_page=100&type=owner"
    return
  fi
  return 1
}

check_file_exists() {
  local full_repo="$1"
  local default_branch="$2"
  local path="$3"
  gh api "/repos/${full_repo}/contents/${path}?ref=${default_branch}" >/dev/null 2>&1
}

fetch_file_content() {
  local full_repo="$1"
  local default_branch="$2"
  local path="$3"
  local encoded
  encoded="$(gh api "/repos/${full_repo}/contents/${path}?ref=${default_branch}" --jq '.content' 2>/dev/null || true)"
  if [[ -z "${encoded}" || "${encoded}" == "null" ]]; then
    return 1
  fi
  printf '%s' "${encoded}" | tr -d '\n' | base64 --decode 2>/dev/null || return 1
}

check_file_patterns() {
  local content="$1"
  local patterns_json="$2"
  local missing='[]'
  while IFS= read -r pattern; do
    [[ -z "${pattern}" ]] && continue
    if ! grep -Eq "^[[:space:]-]*${pattern}[[:space:]]*" <<< "${content}"; then
      missing="$(jq -c --arg p "${pattern}" '. + [$p]' <<< "${missing}")"
    fi
  done < <(jq -r '.[]' <<< "${patterns_json}")
  echo "${missing}"
}

for org in "${ORGS[@]}"; do
  echo "Auditing org: ${org}" >&2
  repos_raw="$(repo_cursor "${org}" || true)"
  if [[ -z "${repos_raw}" ]]; then
    echo "Skipping ${org}: not found or no visible repositories." >&2
    continue
  fi
  repos_json="$(jq -s 'add' <<< "${repos_raw}")"
  repo_count=0
  while IFS= read -r repo_obj; do
    repo_name="$(jq -r '.name' <<< "${repo_obj}")"
    archived="$(jq -r '.archived' <<< "${repo_obj}")"
    disabled="$(jq -r '.disabled' <<< "${repo_obj}")"
    default_branch="$(jq -r '.default_branch // "main"' <<< "${repo_obj}")"

    if [[ "${disabled}" == "true" ]]; then
      continue
    fi
    if [[ "${INCLUDE_ARCHIVED}" != "true" && "${archived}" == "true" ]]; then
      continue
    fi
    if [[ "${MAX_REPOS}" != "0" && "${repo_count}" -ge "${MAX_REPOS}" ]]; then
      break
    fi
    repo_count=$((repo_count + 1))
    full_repo="${org}/${repo_name}"
    repo_detail_json="$(gh api "/repos/${full_repo}" 2>/dev/null || true)"

    required_files_total="$(jq 'length' <<< "${REQUIRED_FILES_JSON}")"
    required_files_present=0
    missing_files_json='[]'
    while IFS= read -r required_file; do
      if check_file_exists "${full_repo}" "${default_branch}" "${required_file}"; then
        required_files_present=$((required_files_present + 1))
      else
        missing_files_json="$(jq -c --arg item "${required_file}" '. + [$item]' <<< "${missing_files_json}")"
      fi
    done < <(jq -r '.[]' <<< "${REQUIRED_FILES_JSON}")

    pattern_checks_total=0
    pattern_checks_passed=0
    missing_patterns_json='[]'
    while IFS= read -r file_path; do
      [[ -z "${file_path}" ]] && continue
      file_patterns="$(jq -c --arg fp "${file_path}" '.[$fp]' <<< "${REQUIRED_FILE_PATTERNS_JSON}")"
      file_patterns_count="$(jq 'length' <<< "${file_patterns}")"
      pattern_checks_total=$((pattern_checks_total + file_patterns_count))

      file_content="$(fetch_file_content "${full_repo}" "${default_branch}" "${file_path}" || true)"
      if [[ -z "${file_content}" ]]; then
        while IFS= read -r p; do
          missing_patterns_json="$(jq -c --arg item "${file_path}:${p}" '. + [$item]' <<< "${missing_patterns_json}")"
        done < <(jq -r '.[]' <<< "${file_patterns}")
        continue
      fi

      missing_for_file="$(check_file_patterns "${file_content}" "${file_patterns}")"
      missing_count="$(jq 'length' <<< "${missing_for_file}")"
      pattern_checks_passed=$((pattern_checks_passed + file_patterns_count - missing_count))
      while IFS= read -r p; do
        [[ -z "${p}" ]] && continue
        missing_patterns_json="$(jq -c --arg item "${file_path}:${p}" '. + [$item]' <<< "${missing_patterns_json}")"
      done < <(jq -r '.[]' <<< "${missing_for_file}")
    done < <(jq -r 'keys[]' <<< "${REQUIRED_FILE_PATTERNS_JSON}")

    trigger_checks_total=0
    trigger_checks_passed=0
    missing_triggers_json='[]'
    while IFS= read -r workflow_path; do
      workflow_content="$(fetch_file_content "${full_repo}" "${default_branch}" "${workflow_path}" || true)"
      while IFS= read -r trigger_name; do
        trigger_checks_total=$((trigger_checks_total + 1))
        if [[ -n "${workflow_content}" ]] && grep -Eq "(^|[[:space:]])${trigger_name}:" <<< "${workflow_content}"; then
          trigger_checks_passed=$((trigger_checks_passed + 1))
        else
          missing_triggers_json="$(jq -c --arg item "${workflow_path}:${trigger_name}" '. + [$item]' <<< "${missing_triggers_json}")"
        fi
      done < <(jq -r --arg wf "${workflow_path}" '.[$wf][]' <<< "${REQUIRED_TRIGGERS_JSON}")
    done < <(jq -r 'keys[]' <<< "${REQUIRED_TRIGGERS_JSON}")

    branch_protection_enabled=true
    branch_check_total=0
    branch_check_passed=0
    status_check_total=0
    status_check_passed=0
    missing_status_checks_json='[]'
    if [[ "${REQUIRE_BRANCH_PROTECTION}" == "true" ]]; then
      branch_check_total=1
      protection_json="$(gh api "/repos/${full_repo}/branches/${default_branch}/protection" 2>/dev/null || true)"
      if [[ -n "${protection_json}" ]]; then
        branch_check_passed=1
        status_check_total="$(jq 'length' <<< "${REQUIRED_STATUS_CHECKS_JSON}")"
        while IFS= read -r status_name; do
          [[ -z "${status_name}" ]] && continue
          if jq -e --arg s "${status_name}" '.required_status_checks.contexts // [] | index($s) != null' <<< "${protection_json}" >/dev/null; then
            status_check_passed=$((status_check_passed + 1))
          else
            missing_status_checks_json="$(jq -c --arg item "${status_name}" '. + [$item]' <<< "${missing_status_checks_json}")"
          fi
        done < <(jq -r '.[]' <<< "${REQUIRED_STATUS_CHECKS_JSON}")
      else
        branch_protection_enabled=false
      fi
    fi

    repo_settings_checks_total=0
    repo_settings_checks_passed=0
    missing_repo_settings_json='[]'

    if [[ "${ENFORCE_DEFAULT_BRANCH_NAME}" == "true" && -n "${DEFAULT_BRANCH_NAME}" ]]; then
      repo_settings_checks_total=$((repo_settings_checks_total + 1))
      if [[ "${default_branch}" == "${DEFAULT_BRANCH_NAME}" ]]; then
        repo_settings_checks_passed=$((repo_settings_checks_passed + 1))
      else
        missing_repo_settings_json="$(jq -c --arg item "defaultBranch:${default_branch}->${DEFAULT_BRANCH_NAME}" '. + [$item]' <<< "${missing_repo_settings_json}")"
      fi
    fi

    if [[ "${PUSH_POLICY_ENABLED}" == "true" ]]; then
      repo_settings_checks_total=$((repo_settings_checks_total + 1))
      current_max_ref_updates="$(jq -r '.max_ref_updates // 0' <<< "${repo_detail_json}" 2>/dev/null || echo "0")"
      if [[ "${current_max_ref_updates}" == "${PUSH_POLICY_MAX_REF_UPDATES}" ]]; then
        repo_settings_checks_passed=$((repo_settings_checks_passed + 1))
      else
        missing_repo_settings_json="$(jq -c --arg item "maxRefUpdates:${current_max_ref_updates}->${PUSH_POLICY_MAX_REF_UPDATES}" '. + [$item]' <<< "${missing_repo_settings_json}")"
      fi
    fi

    checks_total=$((required_files_total + pattern_checks_total + trigger_checks_total + branch_check_total + status_check_total + repo_settings_checks_total))
    checks_passed=$((required_files_present + pattern_checks_passed + trigger_checks_passed + branch_check_passed + status_check_passed + repo_settings_checks_passed))
    score=0
    if [[ "${checks_total}" -gt 0 ]]; then
      score="$(( (checks_passed * 100) / checks_total ))"
    fi

    compliant=true
    if [[ "${required_files_present}" -ne "${required_files_total}" || "${pattern_checks_passed}" -ne "${pattern_checks_total}" || "${trigger_checks_passed}" -ne "${trigger_checks_total}" ]]; then
      compliant=false
    fi
    if [[ "${REQUIRE_BRANCH_PROTECTION}" == "true" && ( "${branch_protection_enabled}" != "true" || "${status_check_passed}" -ne "${status_check_total}" ) ]]; then
      compliant=false
    fi
    if [[ "${repo_settings_checks_passed}" -ne "${repo_settings_checks_total}" ]]; then
      compliant=false
    fi

    jq -nc \
      --arg org "${org}" \
      --arg repo "${repo_name}" \
      --arg fullRepo "${full_repo}" \
      --arg defaultBranch "${default_branch}" \
      --argjson archived "${archived}" \
      --argjson branchProtection "${branch_protection_enabled}" \
      --argjson requiredFilesTotal "${required_files_total}" \
      --argjson requiredFilesPresent "${required_files_present}" \
      --argjson triggerChecksTotal "${trigger_checks_total}" \
      --argjson triggerChecksPassed "${trigger_checks_passed}" \
      --argjson patternChecksTotal "${pattern_checks_total}" \
      --argjson patternChecksPassed "${pattern_checks_passed}" \
      --argjson statusCheckTotal "${status_check_total}" \
      --argjson statusCheckPassed "${status_check_passed}" \
      --argjson repoSettingsChecksTotal "${repo_settings_checks_total}" \
      --argjson repoSettingsChecksPassed "${repo_settings_checks_passed}" \
      --argjson checksTotal "${checks_total}" \
      --argjson checksPassed "${checks_passed}" \
      --argjson score "${score}" \
      --argjson compliant "${compliant}" \
      --argjson missingFiles "${missing_files_json}" \
      --argjson missingTriggers "${missing_triggers_json}" \
      --argjson missingPatterns "${missing_patterns_json}" \
      --argjson missingStatusChecks "${missing_status_checks_json}" \
      --argjson missingRepoSettings "${missing_repo_settings_json}" \
      '{
        org: $org,
        repo: $repo,
        fullRepo: $fullRepo,
        defaultBranch: $defaultBranch,
        archived: $archived,
        branchProtection: $branchProtection,
        requiredFilesTotal: $requiredFilesTotal,
        requiredFilesPresent: $requiredFilesPresent,
        triggerChecksTotal: $triggerChecksTotal,
        triggerChecksPassed: $triggerChecksPassed,
        patternChecksTotal: $patternChecksTotal,
        patternChecksPassed: $patternChecksPassed,
        statusCheckTotal: $statusCheckTotal,
        statusCheckPassed: $statusCheckPassed,
        repoSettingsChecksTotal: $repoSettingsChecksTotal,
        repoSettingsChecksPassed: $repoSettingsChecksPassed,
        checksTotal: $checksTotal,
        checksPassed: $checksPassed,
        score: $score,
        compliant: $compliant,
        missingFiles: $missingFiles,
        missingTriggers: $missingTriggers,
        missingPatterns: $missingPatterns,
        missingStatusChecks: $missingStatusChecks,
        missingRepoSettings: $missingRepoSettings
      }' >> "${JSONL_PATH}"
  done < <(jq -c '.[]' <<< "${repos_json}")
done

jq -s '.' "${JSONL_PATH}" > "${JSON_PATH}"
cp "${JSON_PATH}" "${OUT_DIR}/latest.json"

{
  echo "# Org Governance Audit Report"
  echo
  echo "- Timestamp (UTC): ${TIMESTAMP}"
  echo "- Policy: ${POLICY_FILE}"
  echo
  jq -r '
    "## Summary",
    "",
    "- Repos audited: \((length))",
    "- Compliant repos: \((map(select(.compliant == true)) | length))",
    "- Non-compliant repos: \((map(select(.compliant == false)) | length))",
    "",
    "## By Org",
    "",
    "| Org | Audited | Compliant | Non-Compliant |",
    "|---|---:|---:|---:|",
    (
      group_by(.org)[]
      | "| \(. [0].org) | \((length)) | \((map(select(.compliant)) | length)) | \((map(select(.compliant | not)) | length)) |"
    ),
    "",
    "## Non-Compliant Repositories",
    "",
    "| Repository | Score | Missing Files | Missing Patterns | Missing Triggers | Missing Status Checks | Missing Repo Settings | Branch Protection |",
    "|---|---:|---|---|---|---|---|---|",
    (
      map(select(.compliant | not))[]
      | "| \(.fullRepo) | \(.score)% | \((.missingFiles | join(", "))) | \((.missingPatterns | join(", "))) | \((.missingTriggers | join(", "))) | \((.missingStatusChecks | join(", "))) | \((.missingRepoSettings // [] | join(", "))) | \(.branchProtection) |"
    )
  ' "${JSON_PATH}"
} > "${MD_PATH}"
cp "${MD_PATH}" "${OUT_DIR}/latest.md"

echo "Wrote:"
echo "  ${JSON_PATH}"
echo "  ${MD_PATH}"
echo "  ${OUT_DIR}/latest.json"
echo "  ${OUT_DIR}/latest.md"
