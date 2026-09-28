---
canonical_uri: chittycanon://docs/runbooks/chittycommand/daemon-bring-up-vm
title: ChittyCommand cluster daemon — first-node bring-up (chittyserv-vm)
status: draft
related_adr: chittycanon://docs/architecture/chittycommand/ADR-001
related_supervisor: chittycanon://docs/architecture/chittycommand/daemon-supervisor
target_node: chittyserv-vm (Oracle Cloud, Tailscale 100.96.187.36, Ubuntu)
---

# Daemon bring-up — chittyserv-vm

This runbook brings the meta-orchestrator daemon up on the **first** cluster
node, `chittyserv-vm`. Subsequent nodes (`chittymini-02..06` on Ubuntu,
`chittymini-01` on macOS via launchd) follow the same shape; only the
templated env values change.

The install script stops short of `systemctl start` on purpose. The operator
runs the final start command.

## Pre-requisites

1. **1Password Connect** reachable on the VM (`OP_CONNECT_URL` set; default is
   `http://100.96.187.36:8080` per `chittyserv/docs/network.md`).
2. **`op` CLI** installed and signed in:
   ```bash
   command -v op && op whoami
   ```
   If not signed in: `eval "$(op signin)"`.
3. **Node.js 20+** on the VM:
   ```bash
   node --version    # expect v20.x or later
   ```
4. **Neon project provisioned** for ChittyCommand with the `cc_node_leases`,
   `cc_goals`, `cc_plans`, `cc_intents` tables (migrations `0001_*`/`0002_*`
   from the foundation PR applied).
5. **`postgresql-client`** (for `psql` smoke tests):
   ```bash
   sudo apt-get install -y postgresql-client
   ```

## One-time: mint the node ChittyID

`chittyserv-vm` needs a **Location-type** ChittyID stored in 1Password under
`op://ChittyOS-Core/CHITTYCOMMAND_NODES/chittyserv-vm/chitty_id`.

**Operator must mint this — the public `chittyid.chitty.cc` landing page does
not expose an unauthenticated mint endpoint.** Two paths:

- **Preferred:** call the chittyid worker via the registered MCP gateway
  (`ch1tty -> chittyid`), entity type `L`, descriptor `chittyserv-vm`.
- **Fallback:** use the `chittyid-mint` action in ChittyCommand's existing
  43-tool MCP (`command.chitty.cc`) with the same parameters.

Format check (must match `VV-G-LLL-SSSS-L-YM-C-X`, type segment = `L`):
```bash
echo "$CHITTY_ID" | grep -E '^[0-9A-Z]{2}-[0-9A-Z]-[0-9A-Z]{3}-[0-9A-Z]{4}-L-[0-9A-Z]{2}-[0-9A-Z]-[0-9A-Z]$'
```

Then store it:
```bash
op item edit "CHITTYCOMMAND_NODES" "chittyserv-vm.chitty_id=<the-id>" --vault ChittyOS-Core
```

Also populate:
- `op://ChittyOS-Core/CHITTYCOMMAND_DAEMON/database_url` — Neon connection string for the daemon role
- `op://ChittyOS-Core/CHITTYCOMMAND_DAEMON/chittyconnect_token` — ChittyConnect bearer token

## Install (idempotent)

On `chittyserv-vm`, from the repo root:

```bash
# Dry-run first to inspect the plan (no sudo, no changes):
./scripts/install-daemon-vm.sh --dry-run

# Real install:
sudo -E ./scripts/install-daemon-vm.sh
```

The script:
1. Creates the `chittycommand` system user.
2. Builds `dist/daemon/runtime/entrypoint.js` via `npm run build:daemon`.
3. Syncs artifacts to `/opt/chittycommand/`.
4. Runs `op inject -i daemon/runtime/env.tmpl -o /etc/chittycommand/env`
   (1Password renders every `op://` reference — no secret ever touches shell
   history or the repo).
5. Installs `/etc/systemd/system/chittycommand-daemon.service`.
6. `systemctl daemon-reload && systemctl enable chittycommand-daemon.service`.
7. **Stops without starting.**

## Operator final command (the one thing the script will not do)

```bash
sudo systemctl start chittycommand-daemon.service
```

## Verify

### Leadership claim landed in Neon

```bash
psql "$(sudo cat /etc/chittycommand/env | grep ^DATABASE_URL= | cut -d= -f2- | tr -d '"')" -c \
  "SELECT role, node_id, node_descriptor, session_id, claimed_at, heartbeat_at, lease_expires_at
   FROM cc_node_leases
   WHERE role='meta-orchestrator-leader';"
```

Expected: one row with `node_id` = the ChittyID you minted, `node_descriptor` =
`chittyserv-vm`, `lease_expires_at` ~30s in the future.

### Heartbeat advancing

Re-run the same query after ~15s. `heartbeat_at` and `lease_expires_at` should
both have advanced (no rebound, no new `claimed_at`).

### Process health

```bash
systemctl status chittycommand-daemon.service --no-pager
journalctl -u chittycommand-daemon.service -n 100 --no-pager
journalctl -u chittycommand-daemon.service -f       # live tail
```

Look for these structured lines:
- `daemon_start` — process came up, read env
- `leader_acquired` — lease claimed
- `heartbeat_ok` — recurring every ~10s
- (Optionally) `intent_claimed` / `intent_completed` — only fires if real
  intents exist in `cc_intents`. None expected on a clean foundation install.

## Failure modes

### Neon unreachable

Per ADR-001: the node **parks**. You will see repeating `claimLeadership_error`
followed by `not_leader_parking` lines, no LAN gossip, no local election. This
is correct foundation behavior. Restore Neon reachability and the daemon
self-recovers on the next park interval (5s default).

### Lease lost (another node claimed)

`lease_lost_parking` is normal in a multi-node cluster — only one node holds
the leader role at a time. With just `chittyserv-vm` running, you should never
see this. If you do: another process is reusing this node's ChittyID — fix
that first.

### `op inject` fails at install

```
[install] fatal: 'op' is not signed in. Run: eval $(op signin)
```
Sign in to 1Password and re-run the install script. It is idempotent.

## Stop / uninstall

```bash
# Graceful stop (daemon releases lease via SIGTERM handler)
sudo systemctl stop chittycommand-daemon.service

# Disable autostart
sudo systemctl disable chittycommand-daemon.service

# Full uninstall
sudo systemctl disable --now chittycommand-daemon.service
sudo rm -f /etc/systemd/system/chittycommand-daemon.service
sudo rm -rf /etc/chittycommand /opt/chittycommand /var/log/chittycommand
sudo systemctl daemon-reload
sudo userdel chittycommand 2>/dev/null || true
```

Confirm the lease is released:
```bash
psql "$DATABASE_URL" -c \
  "SELECT role, node_id FROM cc_node_leases WHERE role='meta-orchestrator-leader';"
```
Expected: `node_id` is NULL (graceful release) within seconds of `systemctl stop`.

## Rollback

If the bring-up misbehaves and you need to abort cleanly:

1. `sudo systemctl stop chittycommand-daemon.service` (daemon releases lease)
2. `sudo systemctl disable chittycommand-daemon.service`
3. Confirm `node_id` is NULL in `cc_node_leases` (above)
4. Leave the installed artifacts in place if you intend to re-run install
   after a fix — re-running `install-daemon-vm.sh` is safe.
5. If you need to scrub completely, use the full uninstall block above.

The foundation PR's `src/` (dashboard + ActionAgent + 43-tool MCP) is
untouched by this install — rollback affects only the daemon process.
