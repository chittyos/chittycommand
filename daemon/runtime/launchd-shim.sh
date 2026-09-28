#!/usr/bin/env bash
#
# launchd-shim.sh — macOS env-loading shim for the ChittyCommand daemon.
#
# launchd has no native EnvironmentFile equivalent (unlike systemd), so this
# shim sources /etc/chittycommand/env before exec'ing node. The systemd unit
# uses EnvironmentFile=/etc/chittycommand/env directly; this shim keeps the
# macOS path consistent.
#
# Codex P2 PR#105: previously the launchd plist invoked node directly with
# only NODE_ENV/NODE_OPTIONS exported, which meant entrypoint.ts's readEnv()
# always tripped its fatal-missing-env branch on Mac Mini nodes.
#
# Install path: /opt/chittycommand/dist/daemon/runtime/launchd-shim.sh
# Mode: 0755, owned by chittycommand:chittycommand
#
# canonical-uri: chittycanon://docs/architecture/chittycommand/daemon-supervisor

set -euo pipefail

ENV_FILE="${CHITTYCOMMAND_ENV_FILE:-/etc/chittycommand/env}"
NODE_BIN="${CHITTYCOMMAND_NODE_BIN:-/usr/local/bin/node}"
ENTRYPOINT="/opt/chittycommand/dist/daemon/runtime/entrypoint.js"

if [[ ! -r "${ENV_FILE}" ]]; then
  echo "[chittycommand-daemon-shim] fatal: env file not readable: ${ENV_FILE}" >&2
  exit 7
fi

# Source env file. The file is the same KEY=VALUE format the systemd
# EnvironmentFile expects, rendered by `op inject` at install time.
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

# Preserve NODE_ENV / NODE_OPTIONS if launchd set them.
export NODE_ENV="${NODE_ENV:-production}"
export NODE_OPTIONS="${NODE_OPTIONS:---enable-source-maps}"

if [[ ! -x "${NODE_BIN}" ]]; then
  echo "[chittycommand-daemon-shim] fatal: node not executable at ${NODE_BIN}" >&2
  exit 8
fi

exec "${NODE_BIN}" "${ENTRYPOINT}"
