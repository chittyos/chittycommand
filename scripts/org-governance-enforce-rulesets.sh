#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY_FILE="${ROOT_DIR}/.github/org-governance-policy.json"
REPORT_FILE="${ROOT_DIR}/reports/org-governance/latest.json"
DRY_RUN="false"
FAIL_ON_ERROR="true"
TARGETS="branch"

usage() {
  cat <<'USAGE'
Usage: org-governance-enforce-rulesets.sh [options]

Options:
  --policy <path>        Policy file
  --report <path>        Audit report JSON (array) used to scope orgs
  --targets <csv>        Ruleset targets to enforce (branch,push)
  --dry-run <bool>       Print intended actions only (default: false)
  --fail-on-error <bool> Exit non-zero if any org/target fails (default: true)
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
    --targets)
      TARGETS="$2"
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
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq required" >&2
  exit 1
fi

use_rulesets="$(jq -r '.useOrgRulesets // true' "${POLICY_FILE}")"
if [[ "${use_rulesets}" != "true" ]]; then
  echo "Org ruleset enforcement disabled by policy (.useOrgRulesets=false)."
  exit 0
fi

required_status_checks="$(jq -c '.requiredStatusChecks // []' "${POLICY_FILE}")"
required_review_count="$(jq -r '.requiredApprovingReviewCount // 1' "${POLICY_FILE}")"
if [[ ! "${required_review_count}" =~ ^[0-9]+$ ]]; then
  echo "Invalid requiredApprovingReviewCount in policy: ${required_review_count}" >&2
  exit 1
fi

orgs=""
if [[ -f "${REPORT_FILE}" ]]; then
  orgs="$(jq -r '.[] | .org' "${REPORT_FILE}" 2>/dev/null | sort -u || true)"
fi
if [[ -z "${orgs}" ]]; then
  orgs="$(jq -r '.orgs[]' "${POLICY_FILE}")"
fi
if [[ -z "${orgs}" ]]; then
  echo "No orgs resolved from report or policy."
  exit 0
fi

build_rules() {
  local target="$1"
  local spec_json="$2"

  jq -nc \
    --arg target "${target}" \
    --argjson spec "${spec_json}" \
    --argjson requiredChecks "${required_status_checks}" \
    --argjson reviewCount "${required_review_count}" '
      [
        (if $target == "branch" then
          {
            type: "pull_request",
            parameters: {
              allowed_merge_methods: ($spec.rules.pull_request.allowed_merge_methods // ["squash"]),
              dismiss_stale_reviews_on_push: ($spec.rules.pull_request.dismiss_stale_reviews_on_push // true),
              require_code_owner_review: ($spec.rules.pull_request.require_code_owner_review // false),
              require_last_push_approval: ($spec.rules.pull_request.require_last_push_approval // false),
              required_approving_review_count: ($spec.rules.pull_request.required_approving_review_count // $reviewCount),
              required_review_thread_resolution: ($spec.rules.pull_request.required_review_thread_resolution // true)
            }
          }
        else empty end),
        (if $target == "branch" and ($requiredChecks | length) > 0 then
          {
            type: "required_status_checks",
            parameters: {
              do_not_enforce_on_create: ($spec.rules.required_status_checks.do_not_enforce_on_create // false),
              required_status_checks: ($requiredChecks | map({context: ., integration_id: null})),
              strict_required_status_checks_policy: ($spec.rules.required_status_checks.strict_required_status_checks_policy // true)
            }
          }
        else empty end),
        (if ($spec.rules.non_fast_forward // true) then {type: "non_fast_forward"} else empty end),
        (if ($spec.rules.required_linear_history // false) then {type: "required_linear_history"} else empty end),
        (if ($spec.rules.required_signatures // false) then {type: "required_signatures"} else empty end),
        (if ($target == "branch" and ($spec.rules.block_branch_deletion // false)) then {type: "deletion"} else empty end),
        (if ($target == "branch" and ($spec.rules.block_branch_creation // false)) then {type: "creation"} else empty end),
        (if ($target == "branch" and ($spec.rules.block_branch_updates // false)) then {type: "update"} else empty end),
        (if ($target == "branch" and (($spec.rules.required_deployments // []) | length) > 0) then
          {
            type: "required_deployments",
            parameters: {
              required_deployment_environments: ($spec.rules.required_deployments)
            }
          }
        else empty end)
      ] | map(select(. != null))'
}

build_conditions() {
  local target="$1"
  local spec_json="$2"

  jq -nc --arg target "${target}" --argjson spec "${spec_json}" '
    if $target == "push" then
      {
        repository_name: {
          include: ($spec.conditions.repository_name.include // ["~ALL"]),
          exclude: ($spec.conditions.repository_name.exclude // []),
          protected: ($spec.conditions.repository_name.protected // false)
        }
      }
    else
      {
        repository_name: {
          include: ($spec.conditions.repository_name.include // ["~ALL"]),
          exclude: ($spec.conditions.repository_name.exclude // []),
          protected: ($spec.conditions.repository_name.protected // false)
        },
        ref_name: {
          include: ($spec.conditions.ref_name.include // ["~DEFAULT_BRANCH"]),
          exclude: ($spec.conditions.ref_name.exclude // [])
        }
      }
    end'
}

build_bypass_actors() {
  local spec_json="$1"
  jq -nc --argjson spec "${spec_json}" '
    ($spec.bypassActors // [
      {actor_id: null, actor_type: "OrganizationAdmin", bypass_mode: "always"}
    ])
    | map({
      actor_id: (.actor_id // null),
      actor_type: .actor_type,
      bypass_mode: (.bypass_mode // "always")
    })'
}

successes=0
failures=0
skipped=0

IFS=',' read -ra target_list <<< "${TARGETS}"

while IFS= read -r org; do
  [[ -z "${org}" ]] && continue

  for target in "${target_list[@]}"; do
    target="$(echo "${target}" | xargs)"
    [[ -z "${target}" ]] && continue

    spec="$(jq -c --arg t "${target}" '.orgRulesets[$t] // empty' "${POLICY_FILE}")"
    if [[ -z "${spec}" || "${spec}" == "null" ]]; then
      echo "Skipped ${org}:${target} (no policy orgRulesets.${target})"
      skipped=$((skipped + 1))
      continue
    fi

    rules="$(build_rules "${target}" "${spec}")"
    if [[ "${rules}" == "[]" ]]; then
      echo "Skipped ${org}:${target} (no rules resolved)"
      skipped=$((skipped + 1))
      continue
    fi

    conditions="$(build_conditions "${target}" "${spec}")"
    bypass_actors="$(build_bypass_actors "${spec}")"
    ruleset_name="$(jq -r --arg t "${target}" '.orgRulesets[$t].name // ""' "${POLICY_FILE}")"
    if [[ -z "${ruleset_name}" ]]; then
      ruleset_name="Chitty Governance ${target^} Gate"
    fi
    enforcement="$(jq -r --arg t "${target}" '.orgRulesets[$t].enforcement // "active"' "${POLICY_FILE}")"

    payload="$(jq -nc \
      --arg name "${ruleset_name}" \
      --arg target "${target}" \
      --arg enforcement "${enforcement}" \
      --argjson bypass "${bypass_actors}" \
      --argjson conditions "${conditions}" \
      --argjson rules "${rules}" '
      {
        name: $name,
        target: $target,
        enforcement: $enforcement,
        bypass_actors: $bypass,
        conditions: $conditions,
        rules: $rules
      }
    ')"

    if [[ "${DRY_RUN}" == "true" ]]; then
      echo "[DRY-RUN] Would enforce ${org}:${target} ruleset \"${ruleset_name}\""
      skipped=$((skipped + 1))
      continue
    fi

    list_json="$(gh api "/orgs/${org}/rulesets?targets=${target}" 2>/dev/null || true)"
    ruleset_id=""
    if [[ -n "${list_json}" ]]; then
      ruleset_id="$(jq -r --arg n "${ruleset_name}" '.[] | select(.name == $n) | .id' <<< "${list_json}" | head -n1 || true)"
    fi

    if [[ -n "${ruleset_id}" && "${ruleset_id}" != "null" ]]; then
      if gh api -X PUT "/orgs/${org}/rulesets/${ruleset_id}" --input <(echo "${payload}") >/dev/null 2>&1; then
        echo "Updated org ruleset ${org}:${target} -> ${ruleset_name}"
        successes=$((successes + 1))
      else
        echo "Failed to update org ruleset ${org}:${target} -> ${ruleset_name}" >&2
        failures=$((failures + 1))
      fi
    else
      if gh api -X POST "/orgs/${org}/rulesets" --input <(echo "${payload}") >/dev/null 2>&1; then
        echo "Created org ruleset ${org}:${target} -> ${ruleset_name}"
        successes=$((successes + 1))
      else
        echo "Failed to create org ruleset ${org}:${target} -> ${ruleset_name}" >&2
        failures=$((failures + 1))
      fi
    fi
  done
done <<< "${orgs}"

echo "Org ruleset enforcement complete: success=${successes} failed=${failures} skipped=${skipped}"
if [[ "${FAIL_ON_ERROR}" == "true" && "${failures}" -gt 0 ]]; then
  exit 1
fi
