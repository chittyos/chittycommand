#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "[PASS] $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "[FAIL] $1" >&2
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq "${needle}" <<< "${haystack}"; then
    pass "${label}"
  else
    fail "${label} (missing: ${needle})"
  fi
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq "${needle}" "${file}"; then
    pass "${label}"
  else
    fail "${label} (missing: ${needle} in ${file})"
  fi
}

file_hash() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${file}" | awk '{print $1}'
    return
  fi
  sha256sum "${file}" | awk '{print $1}'
}

init_git_repo() {
  local path="$1"
  mkdir -p "${path}"
  pushd "${path}" >/dev/null
  git init -q
  git checkout -B main >/dev/null 2>&1
  git config user.name "test"
  git config user.email "test@example.com"
  git config commit.gpgsign false
  git add .
  git -c commit.gpgsign=false commit -q -m "initial"
  popd >/dev/null
}

echo "== Test 1: stamp-discovery-links handles missing frontmatter and is idempotent =="
STAMP_FIXTURE="${TMP_DIR}/stamp-fixture"
mkdir -p "${STAMP_FIXTURE}/docs"
cat > "${STAMP_FIXTURE}/CHITTY.md" <<'EOF'
# CHITTY

Legacy summary
EOF
cat > "${STAMP_FIXTURE}/CHARTER.md" <<'EOF'
---
name: Legacy Charter
---
# CHARTER
EOF
cat > "${STAMP_FIXTURE}/docs/PERSISTENT_BRIEF.md" <<'EOF'
# Persistent Brief

Legacy text.
EOF

bash "${ROOT_DIR}/scripts/stamp-discovery-links.sh" "${STAMP_FIXTURE}" >/dev/null

assert_file_contains "${STAMP_FIXTURE}/CHITTY.md" "context_brief: chittycontext://persistent-brief" "CHITTY gets context_brief frontmatter"
assert_file_contains "${STAMP_FIXTURE}/CHITTY.md" "chitty:discovery-links:start" "CHITTY gets discovery block"
assert_file_contains "${STAMP_FIXTURE}/CHARTER.md" "not an authority source" "CHARTER includes non-authority marker"
assert_file_contains "${STAMP_FIXTURE}/docs/PERSISTENT_BRIEF.md" "chitty:persistent-brief-anchors:start" "PERSISTENT_BRIEF gets anchors block"

first_hash="$(cat "${STAMP_FIXTURE}/CHITTY.md" "${STAMP_FIXTURE}/CHARTER.md" "${STAMP_FIXTURE}/docs/PERSISTENT_BRIEF.md" | file_hash /dev/stdin)"
bash "${ROOT_DIR}/scripts/stamp-discovery-links.sh" "${STAMP_FIXTURE}" >/dev/null
second_hash="$(cat "${STAMP_FIXTURE}/CHITTY.md" "${STAMP_FIXTURE}/CHARTER.md" "${STAMP_FIXTURE}/docs/PERSISTENT_BRIEF.md" | file_hash /dev/stdin)"
if [[ "${first_hash}" == "${second_hash}" ]]; then
  pass "stamp-discovery-links is idempotent for baseline boundary docs"
else
  fail "stamp-discovery-links changed files on second identical run"
fi

echo "== Test 2: org-governance-remediate handles clone failure, drift-only PR path, and null arrays =="
FAKE_BIN="${TMP_DIR}/bin"
FAKE_REPOS="${TMP_DIR}/fake-repos"
mkdir -p "${FAKE_BIN}" "${FAKE_REPOS}"
export GH_FAKE_REPOS_DIR="${FAKE_REPOS}"
export GH_FAKE_LOG="${TMP_DIR}/gh.log"
touch "${GH_FAKE_LOG}"

cat > "${FAKE_BIN}/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >> "${GH_FAKE_LOG}"

cmd="${1:-}"
shift || true

case "${cmd}" in
  label)
    exit 0
    ;;
  issue)
    sub="${1:-}"
    shift || true
    case "${sub}" in
      list)
        exit 0
        ;;
      create|comment|edit|close)
        exit 0
        ;;
      *)
        echo "unsupported gh issue subcommand: ${sub}" >&2
        exit 1
        ;;
    esac
    ;;
  api)
    # Milestone lookups in ensure_issue_taxonomy.
    echo "[]"
    exit 0
    ;;
  pr)
    sub="${1:-}"
    shift || true
    case "${sub}" in
      list)
        exit 0
        ;;
      create)
        repo=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --repo)
              repo="${2:-}"
              shift 2
              ;;
            *)
              shift
              ;;
          esac
        done

        state_dir="${GH_FAKE_STATE_DIR:-/tmp}"
        mkdir -p "${state_dir}"
        counter_file="${state_dir}/pr-create-${repo//\//__}.count"
        count=0
        if [[ -f "${counter_file}" ]]; then
          count="$(cat "${counter_file}")"
        fi
        count=$((count + 1))
        printf '%s' "${count}" > "${counter_file}"

        case "${repo}" in
          Org/repo-throttle-ok)
            if [[ "${count}" -lt 3 ]]; then
              echo "GraphQL: pull request creation submitted too quickly" >&2
              exit 1
            fi
            echo "https://example.invalid/pr/throttle-ok"
            exit 0
            ;;
          Org/repo-throttle-fail)
            echo "GraphQL: pull request creation submitted too quickly" >&2
            exit 1
            ;;
          *)
            echo "https://example.invalid/pr/1"
            exit 0
            ;;
        esac
        ;;
      merge)
        exit 0
        ;;
      *)
        echo "unsupported gh pr subcommand: ${sub}" >&2
        exit 1
        ;;
    esac
    ;;
  repo)
    sub="${1:-}"
    shift || true
    case "${sub}" in
      clone)
        full_repo="${1:-}"
        dest="${2:-}"
        src="${GH_FAKE_REPOS_DIR}/${full_repo//\//__}"
        if [[ ! -d "${src}/.git" ]]; then
          echo "repo not found: ${full_repo}" >&2
          exit 1
        fi
        git clone -q "${src}" "${dest}"
        exit 0
        ;;
      *)
        echo "unsupported gh repo subcommand: ${sub}" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unsupported gh command: ${cmd}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${FAKE_BIN}/gh"

cat > "${FAKE_BIN}/sleep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "sleep $*" >> "${GH_FAKE_LOG}"
exit 0
EOF
chmod +x "${FAKE_BIN}/sleep"

# Repo with drifted docs (should produce dry-run PR path via stamp).
DRIFT_REPO="${FAKE_REPOS}/Org__repo-drift"
mkdir -p "${DRIFT_REPO}/docs"
cat > "${DRIFT_REPO}/CHITTY.md" <<'EOF'
# CHITTY
Old format
EOF
cat > "${DRIFT_REPO}/CHARTER.md" <<'EOF'
# CHARTER
Old format
EOF
cat > "${DRIFT_REPO}/docs/PERSISTENT_BRIEF.md" <<'EOF'
# Persistent Brief
Old format
EOF
init_git_repo "${DRIFT_REPO}"

# Repo with null arrays and no boundary files (should not crash; issue-only path).
NULL_REPO="${FAKE_REPOS}/Org__repo-null"
mkdir -p "${NULL_REPO}/src"
cat > "${NULL_REPO}/src/main.txt" <<'EOF'
placeholder
EOF
init_git_repo "${NULL_REPO}"

REPORT_PATH="${TMP_DIR}/report.json"
cat > "${REPORT_PATH}" <<'EOF'
[
  {
    "fullRepo": "Org/repo-missing",
    "compliant": false,
    "defaultBranch": "main",
    "score": 0,
    "missingFiles": [],
    "missingPatterns": [],
    "missingTriggers": [],
    "missingStatusChecks": [],
    "missingRepoSettings": [],
    "branchProtection": false
  },
  {
    "fullRepo": "Org/repo-drift",
    "compliant": false,
    "defaultBranch": "main",
    "score": 50,
    "missingFiles": [],
    "missingPatterns": ["CHITTY.md:context_brief:"],
    "missingTriggers": [],
    "missingStatusChecks": [],
    "missingRepoSettings": [],
    "branchProtection": true
  },
  {
    "fullRepo": "Org/repo-null",
    "compliant": false,
    "defaultBranch": "main",
    "score": 10,
    "missingFiles": null,
    "missingPatterns": null,
    "missingTriggers": null,
    "missingStatusChecks": null,
    "missingRepoSettings": null,
    "branchProtection": true
  }
]
EOF

set +e
remediate_output="$(
  PATH="${FAKE_BIN}:$PATH" \
  CHITTY_DISPATCH_STRICT=false \
  CHITTY_LOCAL_AGENT_DISPATCH=false \
  bash "${ROOT_DIR}/scripts/org-governance-remediate.sh" \
    --policy "${ROOT_DIR}/.github/org-governance-policy.json" \
    --report "${REPORT_PATH}" \
    --auto-pr true \
    --dry-run true \
    --max-prs 20 2>&1
)"
remediate_status=$?
set -e

if [[ "${remediate_status}" -eq 0 ]]; then
  pass "org-governance-remediate exits successfully in dry-run pressure test"
else
  fail "org-governance-remediate failed in pressure test (status=${remediate_status})"
fi

assert_contains "${remediate_output}" "Skipped PR create in Org/repo-missing: unable to clone repository." "clone failure does not abort loop"
assert_contains "${remediate_output}" "[DRY-RUN] Would open remediation PR in Org/repo-drift" "drift-only repo enters PR remediation path"
assert_contains "${remediate_output}" "No supported auto-fixes for Org/repo-null; issue-only remediation applied." "null-array row handled without crash"

echo "== Test 3: org-governance-remediate retries GitHub throttle and handles retry exhaustion =="
export GH_FAKE_STATE_DIR="${TMP_DIR}/gh-state"
mkdir -p "${GH_FAKE_STATE_DIR}"

THROTTLE_OK_REPO="${FAKE_REPOS}/Org__repo-throttle-ok"
mkdir -p "${THROTTLE_OK_REPO}/docs"
cat > "${THROTTLE_OK_REPO}/CHITTY.md" <<'EOF'
# CHITTY
Old format
EOF
cat > "${THROTTLE_OK_REPO}/CHARTER.md" <<'EOF'
# CHARTER
Old format
EOF
cat > "${THROTTLE_OK_REPO}/docs/PERSISTENT_BRIEF.md" <<'EOF'
# Persistent Brief
Old format
EOF
init_git_repo "${THROTTLE_OK_REPO}"

THROTTLE_FAIL_REPO="${FAKE_REPOS}/Org__repo-throttle-fail"
mkdir -p "${THROTTLE_FAIL_REPO}/docs"
cat > "${THROTTLE_FAIL_REPO}/CHITTY.md" <<'EOF'
# CHITTY
Old format
EOF
cat > "${THROTTLE_FAIL_REPO}/CHARTER.md" <<'EOF'
# CHARTER
Old format
EOF
cat > "${THROTTLE_FAIL_REPO}/docs/PERSISTENT_BRIEF.md" <<'EOF'
# Persistent Brief
Old format
EOF
init_git_repo "${THROTTLE_FAIL_REPO}"

THROTTLE_REPORT="${TMP_DIR}/report-throttle.json"
cat > "${THROTTLE_REPORT}" <<'EOF'
[
  {
    "fullRepo": "Org/repo-throttle-ok",
    "compliant": false,
    "defaultBranch": "main",
    "score": 60,
    "missingFiles": [],
    "missingPatterns": ["CHITTY.md:context_brief:"],
    "missingTriggers": [],
    "missingStatusChecks": [],
    "missingRepoSettings": [],
    "branchProtection": true
  },
  {
    "fullRepo": "Org/repo-throttle-fail",
    "compliant": false,
    "defaultBranch": "main",
    "score": 50,
    "missingFiles": [],
    "missingPatterns": ["CHARTER.md:context_brief:"],
    "missingTriggers": [],
    "missingStatusChecks": [],
    "missingRepoSettings": [],
    "branchProtection": true
  }
]
EOF

set +e
throttle_output="$(
  PATH="${FAKE_BIN}:$PATH" \
  CHITTY_DISPATCH_STRICT=false \
  CHITTY_LOCAL_AGENT_DISPATCH=false \
  CHITTY_AUTO_ARM_PR_MERGE=false \
  bash "${ROOT_DIR}/scripts/org-governance-remediate.sh" \
    --policy "${ROOT_DIR}/.github/org-governance-policy.json" \
    --report "${THROTTLE_REPORT}" \
    --auto-pr true \
    --max-prs 20 2>&1
)"
throttle_status=$?
set -e

if [[ "${throttle_status}" -eq 0 ]]; then
  pass "throttle scenario exits successfully"
else
  fail "throttle scenario failed (status=${throttle_status})"
fi

assert_contains "${throttle_output}" "PR create throttled for Org/repo-throttle-ok; retrying in 20s..." "throttle retry #1 observed"
assert_contains "${throttle_output}" "PR create throttled for Org/repo-throttle-ok; retrying in 40s..." "throttle retry #2 observed"
assert_contains "${throttle_output}" "Opened remediation PR in Org/repo-throttle-ok" "throttle repo eventually opens PR"
assert_contains "${throttle_output}" "Skipped PR create in Org/repo-throttle-fail: retries exhausted after GitHub throttle." "retry exhaustion is handled"

echo "== Summary =="
echo "Passed: ${PASS_COUNT}"
echo "Failed: ${FAIL_COUNT}"

if [[ "${FAIL_COUNT}" -ne 0 ]]; then
  exit 1
fi
