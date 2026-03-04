#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_FILE="${ROOT_DIR}/reports/org-governance/latest.json"
PR_TITLE="chore(governance): add CI/CD governance baseline"
DRY_RUN="false"
DELEGATE_MODE="${CHITTY_REVIEW_DELEGATION_MODE:-approve}" # approve|queue_only|disabled
REVIEW_DELEGATE_TOKEN="${CHITTY_REVIEW_DELEGATE_TOKEN:-}"
REVIEW_DELEGATE_LOGIN="${CHITTY_REVIEW_DELEGATE_LOGIN:-}"
QUEUE_DIR="${CHITTY_REVIEW_QUEUE_DIR:-${ROOT_DIR}/reports/review-delegate-queue}"
QUEUE_TS="$(date -u +%Y%m%dT%H%M%SZ)"
QUEUE_JSONL="${QUEUE_DIR}/queue-${QUEUE_TS}.jsonl"
QUEUE_JSON="${QUEUE_DIR}/queue-${QUEUE_TS}.json"
QUEUE_MD="${QUEUE_DIR}/queue-${QUEUE_TS}.md"

usage() {
  cat <<'USAGE'
Usage: org-governance-pr-integration-loop.sh [options]

Options:
  --report <path>       Audit report JSON (array)
  --title <string>      PR title to target
  --dry-run <bool>      Print actions only (default: false)
USAGE
}

queue_event() {
  local full_repo="$1"
  local pr_number="$2"
  local pr_url="$3"
  local action="$4"
  local outcome="$5"
  local reason="$6"
  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg repo "${full_repo}" \
    --argjson pr "${pr_number}" \
    --arg url "${pr_url}" \
    --arg mode "${DELEGATE_MODE}" \
    --arg action "${action}" \
    --arg outcome "${outcome}" \
    --arg reason "${reason}" \
    '{timestamp:$ts,repo:$repo,pr:$pr,url:$url,delegate_mode:$mode,action:$action,outcome:$outcome,reason:$reason}' >> "${QUEUE_JSONL}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --report)
      REPORT_FILE="$2"
      shift 2
      ;;
    --title)
      PR_TITLE="$2"
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
mkdir -p "${QUEUE_DIR}"
touch "${QUEUE_JSONL}"

updated_branches=0
auto_armed=0
already_armed=0
delegated_approvals=0
blocked=0
hard_failures=0

repos="$(jq -r '.[] | select(.archived==false) | .fullRepo' "${REPORT_FILE}" | sort -u)"
if [[ -z "${repos}" ]]; then
  echo "No repos in report."
  exit 0
fi

while IFS= read -r full_repo; do
  [[ -z "${full_repo}" ]] && continue

  prs_json="$(gh pr list -R "${full_repo}" --state open --search "\"${PR_TITLE}\" in:title" --json number,title,url,isDraft,mergeStateStatus,reviewDecision,autoMergeRequest,author 2>/dev/null || true)"
  if [[ -z "${prs_json}" || "${prs_json}" == "[]" ]]; then
    continue
  fi

  while IFS= read -r pr; do
    [[ -z "${pr}" ]] && continue
    pr_number="$(jq -r '.number' <<< "${pr}")"
    pr_url="$(jq -r '.url' <<< "${pr}")"
    is_draft="$(jq -r '.isDraft' <<< "${pr}")"
    merge_state="$(jq -r '.mergeStateStatus // "UNKNOWN"' <<< "${pr}")"
    review_decision="$(jq -r '.reviewDecision // ""' <<< "${pr}")"
    auto_merge_enabled="$(jq -r 'if .autoMergeRequest == null then "false" else "true" end' <<< "${pr}")"
    pr_author="$(jq -r '.author.login // ""' <<< "${pr}")"

    # Only process PRs created by known governance automation accounts
    allowed_authors="chitcommit github-actions[bot] dependabot[bot]"
    if ! echo "${allowed_authors}" | grep -qFw "${pr_author}"; then
      blocked=$((blocked + 1))
      echo "Blocked ${pr_url}: author '${pr_author}' not in governance automation allowlist"
      queue_event "${full_repo}" "${pr_number}" "${pr_url}" "integration" "blocked" "untrusted_author:${pr_author}"
      continue
    fi

    if [[ "${is_draft}" == "true" ]]; then
      blocked=$((blocked + 1))
      echo "Blocked ${pr_url}: draft"
      queue_event "${full_repo}" "${pr_number}" "${pr_url}" "integration" "blocked" "draft"
      continue
    fi

    if [[ "${merge_state}" == "DIRTY" ]]; then
      blocked=$((blocked + 1))
      echo "Blocked ${pr_url}: merge conflict"
      queue_event "${full_repo}" "${pr_number}" "${pr_url}" "integration" "blocked" "merge_conflict"
      bash "${ROOT_DIR}/scripts/chittycompliance-dispatch.sh" \
        --repo "${full_repo}" \
        --mode remediation \
        --findings "pr=${pr_number};merge_state=${merge_state};review=${review_decision};reason=merge_conflict" || true
      continue
    fi

    if [[ "${merge_state}" == "BEHIND" ]]; then
      if [[ "${DRY_RUN}" == "true" ]]; then
        echo "[DRY-RUN] Would update branch for ${pr_url}"
      else
        if gh api -X PUT "repos/${full_repo}/pulls/${pr_number}/update-branch" >/dev/null 2>&1; then
          updated_branches=$((updated_branches + 1))
          echo "Updated branch for ${pr_url}"
          queue_event "${full_repo}" "${pr_number}" "${pr_url}" "update_branch" "updated" "behind"
        else
          hard_failures=$((hard_failures + 1))
          echo "Failed to update branch for ${pr_url}" >&2
          queue_event "${full_repo}" "${pr_number}" "${pr_url}" "update_branch" "failed" "update_branch_failed"
        fi
      fi
      continue
    fi

    detail_json="$(gh pr view -R "${full_repo}" "${pr_number}" --json statusCheckRollup 2>/dev/null || true)"
    failing_checks="$(jq -r '[.statusCheckRollup[]? | select((.status // "") == "COMPLETED" and ((.conclusion // "") | IN("FAILURE","CANCELLED","TIMED_OUT","ACTION_REQUIRED","STARTUP_FAILURE","STALE"))) | .name] | join(", ")' <<< "${detail_json}")"
    pending_count="$(jq -r '[.statusCheckRollup[]? | select((.status // "") != "COMPLETED")] | length' <<< "${detail_json}")"

    if [[ -n "${failing_checks}" ]]; then
      blocked=$((blocked + 1))
      echo "Blocked ${pr_url}: failing checks ${failing_checks}"
      queue_event "${full_repo}" "${pr_number}" "${pr_url}" "integration" "blocked" "failing_checks:${failing_checks}"
      continue
    fi

    if [[ "${pending_count}" =~ ^[0-9]+$ ]] && [[ "${pending_count}" -gt 0 ]]; then
      blocked=$((blocked + 1))
      echo "Blocked ${pr_url}: ${pending_count} checks pending"
      queue_event "${full_repo}" "${pr_number}" "${pr_url}" "integration" "blocked" "pending_checks:${pending_count}"
      continue
    fi

    if [[ "${review_decision}" == "CHANGES_REQUESTED" ]]; then
      blocked=$((blocked + 1))
      echo "Blocked ${pr_url}: review decision ${review_decision}"
      queue_event "${full_repo}" "${pr_number}" "${pr_url}" "review" "blocked" "changes_requested"
      continue
    fi

    if [[ "${review_decision}" == "REVIEW_REQUIRED" ]]; then
      if [[ "${DELEGATE_MODE}" == "disabled" ]]; then
        blocked=$((blocked + 1))
        echo "Blocked ${pr_url}: review required and delegate disabled"
        queue_event "${full_repo}" "${pr_number}" "${pr_url}" "review" "queued_for_recert" "delegate_disabled"
        continue
      fi
      if [[ "${DELEGATE_MODE}" == "queue_only" ]]; then
        blocked=$((blocked + 1))
        echo "Queued ${pr_url}: review required and delegate mode queue_only"
        queue_event "${full_repo}" "${pr_number}" "${pr_url}" "review" "queued_for_recert" "queue_only_mode"
        continue
      fi
      if [[ -z "${REVIEW_DELEGATE_TOKEN}" ]]; then
        blocked=$((blocked + 1))
        echo "Blocked ${pr_url}: review required and CHITTY_REVIEW_DELEGATE_TOKEN not configured"
        queue_event "${full_repo}" "${pr_number}" "${pr_url}" "review" "queued_for_recert" "missing_delegate_token"
        continue
      fi
      if [[ -n "${REVIEW_DELEGATE_LOGIN}" && "${REVIEW_DELEGATE_LOGIN}" == "${pr_author}" ]]; then
        blocked=$((blocked + 1))
        echo "Blocked ${pr_url}: delegate login matches PR author (${pr_author})"
        queue_event "${full_repo}" "${pr_number}" "${pr_url}" "review" "blocked" "delegate_equals_author:${pr_author}"
        continue
      fi

      if [[ "${DRY_RUN}" == "true" ]]; then
        echo "[DRY-RUN] Would submit delegated non-human approval for ${pr_url}"
        queue_event "${full_repo}" "${pr_number}" "${pr_url}" "delegate_approve" "would_approve" "dry_run"
        blocked=$((blocked + 1))
        continue
      fi

      if GH_TOKEN="${REVIEW_DELEGATE_TOKEN}" gh pr review -R "${full_repo}" "${pr_number}" --approve --body "Delegated non-human governance approval: required checks passed." >/dev/null 2>&1; then
        delegated_approvals=$((delegated_approvals + 1))
        echo "Delegated approval submitted for ${pr_url}"
        queue_event "${full_repo}" "${pr_number}" "${pr_url}" "delegate_approve" "approved" "delegate_token"
      else
        hard_failures=$((hard_failures + 1))
        echo "Failed delegated approval for ${pr_url}" >&2
        queue_event "${full_repo}" "${pr_number}" "${pr_url}" "delegate_approve" "failed" "delegate_approval_failed"
        continue
      fi

      refreshed="$(gh pr view -R "${full_repo}" "${pr_number}" --json reviewDecision,autoMergeRequest 2>/dev/null || true)"
      if [[ -n "${refreshed}" ]]; then
        review_decision="$(jq -r '.reviewDecision // ""' <<< "${refreshed}")"
        auto_merge_enabled="$(jq -r 'if .autoMergeRequest == null then "false" else "true" end' <<< "${refreshed}")"
      fi
      if [[ "${review_decision}" == "REVIEW_REQUIRED" || "${review_decision}" == "CHANGES_REQUESTED" ]]; then
        blocked=$((blocked + 1))
        echo "Blocked ${pr_url}: review still not approved (${review_decision})"
        queue_event "${full_repo}" "${pr_number}" "${pr_url}" "review" "blocked" "review_still_${review_decision}"
        continue
      fi
    fi

    if [[ "${auto_merge_enabled}" == "true" ]]; then
      already_armed=$((already_armed + 1))
      echo "Already auto-merge armed ${pr_url}"
      queue_event "${full_repo}" "${pr_number}" "${pr_url}" "merge" "already_armed" "auto_merge_request_present"
      continue
    fi

    if [[ "${DRY_RUN}" == "true" ]]; then
      echo "[DRY-RUN] Would arm auto-merge for ${pr_url}"
      queue_event "${full_repo}" "${pr_number}" "${pr_url}" "merge" "would_arm" "dry_run"
      continue
    fi

    if gh pr merge -R "${full_repo}" "${pr_number}" --squash --auto >/dev/null 2>&1; then
      auto_armed=$((auto_armed + 1))
      echo "Armed auto-merge for ${pr_url}"
      queue_event "${full_repo}" "${pr_number}" "${pr_url}" "merge" "armed" "eligible"
    else
      hard_failures=$((hard_failures + 1))
      echo "Failed to arm auto-merge for ${pr_url}" >&2
      queue_event "${full_repo}" "${pr_number}" "${pr_url}" "merge" "failed" "auto_arm_failed"
    fi
  done < <(jq -c '.[]' <<< "${prs_json}")
done <<< "${repos}"

jq -s '.' "${QUEUE_JSONL}" > "${QUEUE_JSON}"
cp "${QUEUE_JSONL}" "${QUEUE_DIR}/latest.jsonl"
cp "${QUEUE_JSON}" "${QUEUE_DIR}/latest.json"
{
  echo "# Delegate Review Queue"
  echo
  echo "- Timestamp (UTC): ${QUEUE_TS}"
  echo "- Delegate mode: ${DELEGATE_MODE}"
  echo "- Queue records: $(jq 'length' "${QUEUE_JSON}")"
  echo
  echo "| Repo | PR | Action | Outcome | Reason |"
  echo "|---|---:|---|---|---|"
  jq -r '.[] | "| \(.repo) | \(.pr) | \(.action) | \(.outcome) | \(.reason) |"' "${QUEUE_JSON}"
} > "${QUEUE_MD}"
cp "${QUEUE_MD}" "${QUEUE_DIR}/latest.md"

echo "PR integration loop complete: updated=${updated_branches} delegated=${delegated_approvals} armed=${auto_armed} already_armed=${already_armed} blocked=${blocked} hard_failures=${hard_failures}"
if [[ "${hard_failures}" -gt 0 ]]; then
  exit 1
fi
