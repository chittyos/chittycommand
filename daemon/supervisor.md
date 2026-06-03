---
canonical_uri: chittycanon://docs/architecture/chittycommand/daemon-supervisor
title: ChittyCommand cluster daemon — process supervision plan
status: draft
related_adr: chittycanon://docs/architecture/chittycommand/ADR-001
---

# Cluster daemon — supervision plan

> **First-node target: `chittyserv-vm`.** Bring-up runbook + real systemd unit and bootstrap script live at [`docs/runbooks/daemon-bring-up-vm.md`](../docs/runbooks/daemon-bring-up-vm.md) (added in the stacked follow-on PR). The runtime artifacts are under [`daemon/runtime/`](./runtime/).

This document is doc-only. No runtime supervisor code ships in the foundation
PR. The targets below are the homelab cluster of 6 Mac Minis
(`chittymini-01..06`) plus `chittyserv-vm`. Each node runs **one** instance of
`daemon/loop.ts`; leader election in `cc_node_leases` ensures only one node
acts at a time.

Per ADR-001:
- Leader topology is **float freely across cluster** (no SPoF).
- If Neon is unreachable, a node **parks** rather than electing locally.

## Required environment

Every node:

- `CHITTYCOMMAND_NODE_ID` — ChittyID for the node, Location type, format
  `VV-G-LLL-SSSS-L-YM-C-X`. Sourced from chittyid mint on first boot,
  persisted to the node-local manifest under `/etc/chittyos/node.json`
  (macOS: `/Library/Application Support/chittyos/node.json`).
- `CHITTYCOMMAND_NODE_DESCRIPTOR` — hostname (e.g. `chittymini-03`).
- `DATABASE_URL` — Neon connection string for the ChittyCommand project. The
  connection itself flows through the ChittyConnect sensitive-intent path on
  first run; the daemon reads `DATABASE_URL` from its environment, never
  embeds it.
- `CHITTYTRUST_URL` (optional override; defaults to `https://trust.chitty.cc`).
- `CHITTYAGENT_URL` (optional override; defaults to `https://agent.chitty.cc`).
- `CHITTYCONNECT_URL` and `CHITTYCONNECT_TOKEN` for `meta/context.ts`.

Secrets are delivered via the operator manifest's standard path:
1Password (cold source of truth) → Cloudflare Secrets / launchd env / systemd
`EnvironmentFile=` (runtime delivery). The daemon never reads secrets from
local disk except via the supervisor-injected environment.

## macOS Minis — launchd

Plist shape (file: `/Library/LaunchDaemons/cc.chitty.command-daemon.plist`):

```
Label = cc.chitty.command-daemon
ProgramArguments = ["/usr/local/bin/node",
                    "/opt/chittyos/chittycommand/daemon/dist/run.js"]
RunAtLoad = true
KeepAlive = { SuccessfulExit = false, Crashed = true }
ThrottleInterval = 10
StandardOutPath = /var/log/chittycommand-daemon.out.log
StandardErrorPath = /var/log/chittycommand-daemon.err.log
EnvironmentVariables = { CHITTYCOMMAND_NODE_ID = ...,
                         CHITTYCOMMAND_NODE_DESCRIPTOR = ...,
                         DATABASE_URL = ... }   # injected by 1Password CLI at boot
```

Notes:
- `KeepAlive.Crashed = true` + `ThrottleInterval = 10` gives us crash-loop
  protection without manual intervention.
- The supervised process should respond to `SIGTERM` by calling
  `releaseLeadership` (the loop's AbortSignal path does this). launchd sends
  `SIGTERM` 20s before `SIGKILL` on `launchctl unload`, which is enough.

## Ubuntu Minis + chittyserv-vm — systemd

Unit shape (file: `/etc/systemd/system/chittycommand-daemon.service`):

```
[Unit]
Description=ChittyCommand cluster daemon (meta-orchestrator leader)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=chittyos
EnvironmentFile=/etc/chittyos/chittycommand-daemon.env
ExecStart=/usr/bin/node /opt/chittyos/chittycommand/daemon/dist/run.js
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Notes:
- `EnvironmentFile` is rendered at boot from 1Password via the operator's
  bootstrap script — never checked in.
- `Restart=on-failure` + `RestartSec=10` matches the launchd throttle behavior.
- `TimeoutStopSec=30` gives the loop time to release the lease cleanly on
  shutdown.

## Health / observability

Both supervisors should:
- Tail stdout/stderr to the node's journal / log file.
- Forward errors to ChittyTrack (the worker tail consumer mechanism is the
  primary observability path; per-node daemons emit via the same `chittytrack`
  HTTP ingest endpoint).
- Surface `leader_acquired` / `lease_lost_parking` / `intent_completed` log
  lines for ops dashboards.

## What is NOT in this PR

Per ADR-001 out-of-scope list:
- Actual plist / unit files (this doc is the shape; the files are installed
  by the homelab bootstrap repo in a follow-up).
- Multi-node deployment scripts.
- Neon-loss handling beyond "park the node".
- `daemon/dist/run.js` entrypoint — added when the daemon ships.
