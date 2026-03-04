#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY_FILE="${ROOT_DIR}/.github/org-governance-policy.json"
REPORT_FILE="${ROOT_DIR}/reports/org-governance/latest.json"
AUTO_PR="false"
AUTO_ARM_PR_MERGE="${CHITTY_AUTO_ARM_PR_MERGE:-true}"
DRY_RUN="false"
MAX_PRS=5
PRS_OPENED=0
PR_CREATE_SLEEP_SEC="${CHITTY_PR_CREATE_SLEEP_SEC:-0}"

usage() {
  cat <<'EOF'
Usage: org-governance-remediate.sh [options]

Options:
  --policy <path>       Policy file
  --report <path>       Audit report JSON (array)
  --auto-pr <bool>      Open remediation PRs for supported missing files (default: false)
  --auto-arm <bool>     Arm auto-merge on created remediation PRs (default: true)
  --dry-run <bool>      Do not mutate remote repos (default: false)
  --max-prs <n>         Cap PR count per run (default: 5)
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
    --auto-pr)
      AUTO_PR="$2"
      shift 2
      ;;
    --auto-arm)
      AUTO_ARM_PR_MERGE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="$2"
      shift 2
      ;;
    --max-prs)
      MAX_PRS="$2"
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
ISSUE_LABELS_JSON="$(jq -c '.issueManagement.labels // []' "${POLICY_FILE}")"
ISSUE_MILESTONE_TITLE="$(jq -r '.issueManagement.milestoneTitle // ""' "${POLICY_FILE}")"
BASELINE_DIR="${ROOT_DIR}/templates/governance-baseline"

ensure_issue_taxonomy() {
  local full_repo="$1"
  if [[ "${DRY_RUN}" == "true" ]]; then
    return
  fi
  while IFS= read -r label; do
    [[ -z "${label}" ]] && continue
    gh label create -R "${full_repo}" "${label}" --color "0E8A16" --force >/dev/null 2>&1 || true
  done < <(jq -r '.[]' <<< "${ISSUE_LABELS_JSON}")

  if [[ -n "${ISSUE_MILESTONE_TITLE}" ]]; then
    local milestone_num
    milestone_num="$(
      gh api "/repos/${full_repo}/milestones?state=all&per_page=100" 2>/dev/null \
        | jq -r --arg t "${ISSUE_MILESTONE_TITLE}" '.[] | select(.title == $t) | .number' \
        | head -n1 || true
    )"
    if [[ -z "${milestone_num}" ]]; then
      gh api -X POST "/repos/${full_repo}/milestones" -f title="${ISSUE_MILESTONE_TITLE}" >/dev/null 2>&1 || true
    fi
  fi
}

apply_issue_taxonomy() {
  local full_repo="$1"
  local issue_number="$2"
  if [[ "${DRY_RUN}" == "true" ]]; then
    return
  fi

  while IFS= read -r label; do
    [[ -z "${label}" ]] && continue
    gh issue edit -R "${full_repo}" "${issue_number}" --add-label "${label}" >/dev/null 2>&1 || true
  done < <(jq -r '.[]' <<< "${ISSUE_LABELS_JSON}")

  if [[ -n "${ISSUE_MILESTONE_TITLE}" ]]; then
    gh issue edit -R "${full_repo}" "${issue_number}" --milestone "${ISSUE_MILESTONE_TITLE}" >/dev/null 2>&1 || true
  fi
}

ensure_issue() {
  local full_repo="$1"
  local body="$2"
  local existing
  ensure_issue_taxonomy "${full_repo}"
  existing="$(gh issue list -R "${full_repo}" --state open --search "\"${ISSUE_TITLE}\" in:title" --json number,title --jq '.[] | select(.title=="'"${ISSUE_TITLE}"'") | .number' | head -n1 || true)"

  if [[ -n "${existing}" ]]; then
    if [[ "${DRY_RUN}" == "true" ]]; then
      echo "[DRY-RUN] Would comment on issue #${existing} in ${full_repo}"
      return
    fi
    if gh issue comment -R "${full_repo}" "${existing}" --body "${body}" >/dev/null 2>&1; then
      apply_issue_taxonomy "${full_repo}" "${existing}"
      echo "Updated issue #${existing} in ${full_repo}"
    else
      echo "Skipped ${full_repo}: unable to update issue (possibly disabled)." >&2
      return
    fi
  else
    if [[ "${DRY_RUN}" == "true" ]]; then
      echo "[DRY-RUN] Would create issue in ${full_repo}: ${ISSUE_TITLE}"
      return
    fi
    if gh issue create -R "${full_repo}" --title "${ISSUE_TITLE}" --body "${body}" >/dev/null 2>&1; then
      new_issue="$(gh issue list -R "${full_repo}" --state open --search "\"${ISSUE_TITLE}\" in:title" --json number,title --jq '.[] | select(.title=="'"${ISSUE_TITLE}"'") | .number' | head -n1 || true)"
      if [[ -n "${new_issue}" ]]; then
        apply_issue_taxonomy "${full_repo}" "${new_issue}"
      fi
      echo "Created issue in ${full_repo}: ${ISSUE_TITLE}"
    else
      echo "Skipped ${full_repo}: unable to create issue (possibly disabled)." >&2
      return
    fi
  fi
}

close_issue_if_open() {
  local full_repo="$1"
  local existing
  existing="$(gh issue list -R "${full_repo}" --state open --search "\"${ISSUE_TITLE}\" in:title" --json number,title --jq '.[] | select(.title=="'"${ISSUE_TITLE}"'") | .number' | head -n1 || true)"
  if [[ -z "${existing}" ]]; then
    return
  fi
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] Would close issue #${existing} in ${full_repo}"
    return
  fi
  gh issue comment -R "${full_repo}" "${existing}" --body "Compliance loop: repository is now compliant. Closing." >/dev/null 2>&1 || true
  if gh issue close -R "${full_repo}" "${existing}" >/dev/null 2>&1; then
    echo "Closed compliance issue #${existing} in ${full_repo}"
  else
    echo "Skipped closing issue in ${full_repo}: issue operations unavailable." >&2
  fi
}

copy_template_if_supported() {
  local missing_file="$1"
  local work_dir="$2"
  local copied=1

  if [[ -f "${BASELINE_DIR}/${missing_file}" ]]; then
    mkdir -p "$(dirname "${work_dir}/${missing_file}")"
    cp "${BASELINE_DIR}/${missing_file}" "${work_dir}/${missing_file}"
    if [[ "${missing_file}" == scripts/* ]]; then
      chmod +x "${work_dir}/${missing_file}"
    fi
    copied=0
  fi
  return "${copied}"
}

open_remediation_pr() {
  local full_repo="$1"
  local default_branch="$2"
  local missing_files_json="$3"
  local missing_triggers_json="$4"
  local missing_patterns_json="$5"

  if [[ "${AUTO_PR}" != "true" ]]; then
    return
  fi
  if [[ "${PRS_OPENED}" -ge "${MAX_PRS}" ]]; then
    echo "PR limit reached (${MAX_PRS}), skipping PR for ${full_repo}"
    return
  fi

  local pr_title="chore(governance): add CI/CD governance baseline"
  local existing_pr
  existing_pr="$(gh pr list -R "${full_repo}" --state open --search "\"${pr_title}\" in:title" --json number,title --jq '.[] | select(.title=="'"${pr_title}"'") | .number' | head -n1 || true)"
  if [[ -n "${existing_pr}" ]]; then
    echo "PR already open in ${full_repo}: #${existing_pr}"
    return
  fi

  local work_dir
  work_dir="$(mktemp -d)"
  trap 'rm -rf "${work_dir}"' RETURN

  if ! gh repo clone "${full_repo}" "${work_dir}" -- --depth 1 >/dev/null 2>&1; then
    echo "Skipped PR create in ${full_repo}: unable to clone repository." >&2
    return
  fi
  pushd "${work_dir}" >/dev/null
  local branch_name="automation/governance-baseline"
  if ! git checkout -B "${branch_name}" "origin/${default_branch}" >/dev/null 2>&1; then
    echo "Skipped PR create in ${full_repo}: default branch origin/${default_branch} not found." >&2
    popd >/dev/null
    return
  fi
  git config user.name "chitty-governance-bot"
  git config user.email "automation@chitty.cc"
  git config commit.gpgsign false

  local touched=false
  while IFS= read -r missing_file; do
    [[ -z "${missing_file}" ]] && continue
    if copy_template_if_supported "${missing_file}" "${work_dir}"; then
      touched=true
    fi
  done < <(jq -r '.[]' <<< "${missing_files_json}")

  # If any workflow trigger checks fail, refresh that workflow from baseline template if available.
  while IFS= read -r missing_trigger; do
    [[ -z "${missing_trigger}" ]] && continue
    workflow_path="${missing_trigger%%:*}"
    if [[ -f "${BASELINE_DIR}/${workflow_path}" ]]; then
      mkdir -p "$(dirname "${workflow_path}")"
      cp "${BASELINE_DIR}/${workflow_path}" "${workflow_path}"
      touched=true
    fi
  done < <(jq -r '.[]' <<< "${missing_triggers_json}")

  # Keep boundary docs synchronized even when they exist but fail required patterns.
  if bash "${ROOT_DIR}/scripts/stamp-discovery-links.sh" "${work_dir}" >/dev/null; then
    if [[ -n "$(git status --porcelain -- CHITTY.md CHARTER.md docs/PERSISTENT_BRIEF.md 2>/dev/null || true)" ]]; then
      touched=true
    fi
  fi

  # If audit surfaced boundary pattern drift and no concrete file edits were produced,
  # force a baseline copy for those docs when templates exist.
  while IFS= read -r missing_pattern; do
    [[ -z "${missing_pattern}" ]] && continue
    pattern_file="${missing_pattern%%:*}"
    case "${pattern_file}" in
      CHITTY.md|CHARTER.md|docs/PERSISTENT_BRIEF.md)
        if [[ -f "${BASELINE_DIR}/${pattern_file}" ]]; then
          mkdir -p "$(dirname "${work_dir}/${pattern_file}")"
          cp "${BASELINE_DIR}/${pattern_file}" "${work_dir}/${pattern_file}"
          touched=true
        fi
        ;;
    esac
  done < <(jq -r '.[]' <<< "${missing_patterns_json}")

  if [[ "${touched}" != "true" ]]; then
    echo "No supported auto-fixes for ${full_repo}; issue-only remediation applied."
    popd >/dev/null
    return
  fi

  if [[ -z "$(git status --porcelain)" ]]; then
    popd >/dev/null
    echo "No file changes produced for ${full_repo}"
    return
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] Would open remediation PR in ${full_repo}"
    popd >/dev/null
    return
  fi

  git add .
  git -c commit.gpgsign=false commit -m "${pr_title}" >/dev/null
  if ! git push -u origin "${branch_name}" >/dev/null 2>&1; then
    if ! git push -u origin "${branch_name}" --force-with-lease >/dev/null 2>&1; then
      # Existing remote automation branch can diverge without an open PR; fallback to a unique branch.
      branch_name="automation/governance-baseline-$(date +%s)-$RANDOM"
      git checkout -B "${branch_name}" >/dev/null
      if ! git push -u origin "${branch_name}" >/dev/null 2>&1; then
        echo "Skipped PR create in ${full_repo}: unable to push automation branch." >&2
        popd >/dev/null
        return
      fi
    fi
  fi

  local pr_created=false
  local pr_attempt=0
  local pr_error=""
  local created_pr_url=""
  while [[ "${pr_created}" != "true" && "${pr_attempt}" -lt 3 ]]; do
    pr_attempt=$((pr_attempt + 1))
    pr_error=""
    if pr_error="$(gh pr create \
      --repo "${full_repo}" \
      --base "${default_branch}" \
      --head "${branch_name}" \
      --title "${pr_title}" \
      --body "Automated governance baseline remediation from org control loop." 2>&1)"; then
      created_pr_url="$(tail -n1 <<< "${pr_error}")"
      pr_created=true
      break
    fi

    # Back off and retry when GitHub abuse/rate guards trigger.
    if grep -qi "submitted too quickly" <<< "${pr_error}"; then
      if [[ "${pr_attempt}" -lt 3 ]]; then
        sleep_time=$((pr_attempt * 20))
        echo "PR create throttled for ${full_repo}; retrying in ${sleep_time}s..." >&2
        sleep "${sleep_time}"
        continue
      fi
      echo "Skipped PR create in ${full_repo}: retries exhausted after GitHub throttle." >&2
      popd >/dev/null
      return
    fi

    echo "Skipped PR create in ${full_repo}: GitHub rejected request (rate/abuse guard)." >&2
    popd >/dev/null
    return
  done

  if [[ "${pr_created}" != "true" ]]; then
    echo "Skipped PR create in ${full_repo}: retries exhausted." >&2
    popd >/dev/null
    return
  fi

  PRS_OPENED=$((PRS_OPENED + 1))
  if [[ -z "${created_pr_url}" ]]; then
    created_pr_url="$(gh pr list -R "${full_repo}" --head "${branch_name}" --state open --json url --jq '.[0].url' 2>/dev/null || true)"
  fi
  if [[ "${AUTO_ARM_PR_MERGE}" == "true" && -n "${created_pr_url}" ]]; then
    if gh pr merge -R "${full_repo}" "${created_pr_url}" --squash --auto >/dev/null 2>&1; then
      echo "Armed auto-merge for ${created_pr_url}"
    else
      echo "Could not auto-arm merge for ${created_pr_url}; will retry in integration loop." >&2
    fi
  fi
  if [[ "${PR_CREATE_SLEEP_SEC}" =~ ^[0-9]+$ ]] && [[ "${PR_CREATE_SLEEP_SEC}" -gt 0 ]]; then
    sleep "${PR_CREATE_SLEEP_SEC}"
  fi
  popd >/dev/null
  echo "Opened remediation PR in ${full_repo}"
}

rows="$(jq -c '.[]' "${REPORT_FILE}")"
if [[ -z "${rows}" ]]; then
  echo "No rows in report."
  exit 0
fi

while IFS= read -r row; do
  [[ -z "${row}" ]] && continue
  full_repo="$(jq -r '.fullRepo' <<< "${row}")"
  compliant="$(jq -r '.compliant' <<< "${row}")"
  default_branch="$(jq -r '.defaultBranch' <<< "${row}")"
  score="$(jq -r '.score' <<< "${row}")"
  missing_files_json="$(jq -c '.missingFiles // []' <<< "${row}")"
  missing_patterns_json="$(jq -c '.missingPatterns // []' <<< "${row}")"
  missing_triggers_json="$(jq -c '.missingTriggers // []' <<< "${row}")"
  missing_status_checks_json="$(jq -c '.missingStatusChecks // []' <<< "${row}")"
  missing_repo_settings_json="$(jq -c '.missingRepoSettings // []' <<< "${row}")"
  branch_protection="$(jq -r '.branchProtection' <<< "${row}")"

  if [[ -z "${full_repo}" || "${full_repo}" == "null" ]]; then
    echo "Skipping row with missing fullRepo field." >&2
    continue
  fi
  if [[ -z "${default_branch}" || "${default_branch}" == "null" ]]; then
    default_branch="main"
  fi

  if [[ "${compliant}" == "true" ]]; then
    close_issue_if_open "${full_repo}"
    continue
  fi

  body=$(
    cat <<EOF
Automated governance control loop flagged this repository as non-compliant.

- Score: ${score}%
- Branch protection: ${branch_protection}
- Missing files: $(jq -r 'if length==0 then "none" else join(", ") end' <<< "${missing_files_json}")
- Missing onboarding/policy patterns: $(jq -r 'if length==0 then "none" else join(", ") end' <<< "${missing_patterns_json}")
- Missing triggers: $(jq -r 'if length==0 then "none" else join(", ") end' <<< "${missing_triggers_json}")
- Missing status checks: $(jq -r 'if length==0 then "none" else join(", ") end' <<< "${missing_status_checks_json}")
- Missing repo settings: $(jq -r 'if length==0 then "none" else join(", ") end' <<< "${missing_repo_settings_json}")

This issue is managed by automation and will be updated until compliant.
EOF
  )

  ensure_issue "${full_repo}" "${body}"
  bash "${ROOT_DIR}/scripts/chittycompliance-dispatch.sh" \
    --repo "${full_repo}" \
    --mode remediation \
    --findings "score=${score};missing_files=$(jq -r 'join(",")' <<< "${missing_files_json}");missing_patterns=$(jq -r 'join(",")' <<< "${missing_patterns_json}");missing_status_checks=$(jq -r 'join(",")' <<< "${missing_status_checks_json}");missing_repo_settings=$(jq -r 'join(",")' <<< "${missing_repo_settings_json}")" || true

  open_remediation_pr "${full_repo}" "${default_branch}" "${missing_files_json}" "${missing_triggers_json}" "${missing_patterns_json}"
done <<< "${rows}"

echo "Remediation loop complete."
