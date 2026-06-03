#!/usr/bin/env bash
#
# install-daemon-vm.sh — idempotent bootstrap for the ChittyCommand cluster
# daemon on chittyserv-vm (Oracle Cloud Ubuntu, Tailscale 100.96.187.36).
#
# Performs:
#   1. Create system user `chittycommand`
#   2. Build daemon (`npm run build:daemon` -> ./dist/daemon/runtime/entrypoint.js)
#   3. Sync built artifacts + runtime deps into /opt/chittycommand
#   4. Render /etc/chittycommand/env from 1Password via `op inject`
#   5. Install systemd unit; daemon-reload; enable (NOT start)
#
# Hard-stops before `systemctl start`. The operator runs the final command.
#
# Usage:
#   sudo ./scripts/install-daemon-vm.sh            # real install
#   ./scripts/install-daemon-vm.sh --dry-run       # print plan, no changes (no sudo needed)
#
# canonical-uri: chittycanon://docs/runbooks/chittycommand/daemon-bring-up-vm

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/chittycommand"
ENV_DIR="/etc/chittycommand"
ENV_FILE="${ENV_DIR}/env"
ENV_TMPL="${REPO_ROOT}/daemon/runtime/env.tmpl"
UNIT_SRC="${REPO_ROOT}/daemon/runtime/chittycommand-daemon.service"
UNIT_DST="/etc/systemd/system/chittycommand-daemon.service"
LOG_DIR="/var/log/chittycommand"
SERVICE_USER="chittycommand"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

log()  { printf '[install] %s\n' "$*"; }
plan() { printf '[plan]    %s\n' "$*"; }

run() {
  if (( DRY_RUN )); then
    plan "$*"
  else
    eval "$@"
  fi
}

require_or_warn() {
  local bin="$1"
  if ! command -v "$bin" >/dev/null 2>&1; then
    if (( DRY_RUN )); then
      plan "MISSING (would fail in real run): $bin"
    else
      echo "[install] fatal: required binary not found: $bin" >&2
      exit 3
    fi
  fi
}

log "ChittyCommand daemon bootstrap — $(date -u +%FT%TZ)"
log "Mode: $([[ $DRY_RUN -eq 1 ]] && echo DRY-RUN || echo REAL)"
log "Repo: ${REPO_ROOT}"
log "Target: ${INSTALL_DIR}"

# 0. Sanity: required commands
for bin in node npm op systemctl useradd install; do
  require_or_warn "$bin"
done

# 0a. Sanity: target OS
if [[ ! -d /run/systemd/system ]] && (( DRY_RUN == 0 )); then
  echo "[install] fatal: no /run/systemd/system — this host is not systemd-managed." >&2
  exit 4
fi

# 1. System user
if id "${SERVICE_USER}" >/dev/null 2>&1; then
  log "user ${SERVICE_USER} already exists"
else
  run "useradd --system --home-dir ${INSTALL_DIR} --shell /usr/sbin/nologin ${SERVICE_USER}"
fi

# 2. Build
log "building daemon (npm run build:daemon)"
run "cd ${REPO_ROOT} && npm ci --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund"
run "cd ${REPO_ROOT} && npm run build:daemon"

# 3. Install dir + artifact sync
run "install -d -m 0755 -o ${SERVICE_USER} -g ${SERVICE_USER} ${INSTALL_DIR}"
run "install -d -m 0755 -o ${SERVICE_USER} -g ${SERVICE_USER} ${INSTALL_DIR}/dist"
run "cp -R ${REPO_ROOT}/dist/. ${INSTALL_DIR}/dist/"
run "cp ${REPO_ROOT}/package.json ${INSTALL_DIR}/package.json"
# Runtime deps only (no devDeps); production install into install dir.
run "cd ${INSTALL_DIR} && npm install --omit=dev --no-audit --no-fund"
run "chown -R ${SERVICE_USER}:${SERVICE_USER} ${INSTALL_DIR}"

# 4. Logs dir
run "install -d -m 0755 -o ${SERVICE_USER} -g ${SERVICE_USER} ${LOG_DIR}"

# 5. Environment via op inject
run "install -d -m 0750 -o root -g ${SERVICE_USER} ${ENV_DIR}"
if (( DRY_RUN )); then
  plan "op inject -i ${ENV_TMPL} -o ${ENV_FILE}    # 1Password renders op:// refs"
  plan "chmod 0640 ${ENV_FILE}; chown root:${SERVICE_USER} ${ENV_FILE}"
else
  if [[ ! -f "${ENV_TMPL}" ]]; then
    echo "[install] fatal: env template missing at ${ENV_TMPL}" >&2
    exit 5
  fi
  if ! op whoami >/dev/null 2>&1; then
    echo "[install] fatal: 'op' is not signed in. Run: eval \$(op signin)" >&2
    exit 6
  fi
  op inject -i "${ENV_TMPL}" -o "${ENV_FILE}"
  chmod 0640 "${ENV_FILE}"
  chown "root:${SERVICE_USER}" "${ENV_FILE}"
fi

# 6. systemd unit
run "install -m 0644 -o root -g root ${UNIT_SRC} ${UNIT_DST}"
run "systemctl daemon-reload"
run "systemctl enable chittycommand-daemon.service"

# 7. Stop here. Operator runs `systemctl start`.
cat <<EOF

============================================================
ChittyCommand daemon is INSTALLED and ENABLED but NOT STARTED.

Operator final commands (run on chittyserv-vm):

  # Start the daemon
  sudo systemctl start chittycommand-daemon.service

  # Smoke tests
  systemctl status chittycommand-daemon.service --no-pager
  journalctl -u chittycommand-daemon.service -n 50 --no-pager
  journalctl -u chittycommand-daemon.service -f      # live tail

  # Verify leadership claim in Neon (psql against \$DATABASE_URL)
  psql "\$DATABASE_URL" -c \\
    "SELECT role, node_id, node_descriptor, heartbeat_at, lease_expires_at \\
     FROM cc_node_leases WHERE role='meta-orchestrator-leader';"

Rollback:
  sudo systemctl disable --now chittycommand-daemon.service
  sudo rm -f ${UNIT_DST} ${ENV_FILE}
  sudo systemctl daemon-reload

See: docs/runbooks/daemon-bring-up-vm.md
============================================================
EOF
