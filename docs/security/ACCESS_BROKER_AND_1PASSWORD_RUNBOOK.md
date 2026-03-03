# Access Broker and 1Password Runbook

## Principle
No agent (Claude/Codex/Copilot/CodeRabbit/custom) uses permanent shared keys.
All sensitive access is brokered by ChittyConnect using contextual signals and least-privilege scopes.

## Access Flow (Fail Closed)
1. Agent/workflow submits access request to ChittyConnect broker with:
   - repo
   - operation mode
   - run metadata (workflow, actor, run id)
   - requested capabilities (`gateway_dispatch`, `agent_orchestrator`, etc.)
2. ChittyConnect evaluates policy and context signals.
3. If allowed, ChittyConnect returns scoped short-lived credentials and endpoint bindings.
4. Agent executes using only issued credentials.
5. If denied or broker unavailable, process exits non-zero. No fallback to common/shared key.

## Denied Access Process (No Workaround Path)
1. Workflow fails and logs broker denial reason.
2. Compliance issue is opened/updated automatically by control loop.
3. `chittycompliance` dispatcher sends remediation task to relevant agents.
4. Human reviews policy/scope only if required.
5. After policy fix, rerun workflow. No manual shared token injection.

## 1Password Provisioning Model
- Source of truth: `op://` references in `.github/secret-catalog.json`.
- CI uses `OP_SERVICE_ACCOUNT_TOKEN` with least privilege.
- Secrets are rotated on schedule and audited by:
  - `.github/workflows/onepassword-rotation-audit.yml`
  - `scripts/onepassword-rotation-audit.sh`

## Rotation Policy
- Default rotation window: 30 days for automation credentials.
- Any stale/missing secret is non-compliant and opens/updates a security issue.
- Rotation validation is recurring and automatic.

## Required Control Plane Configuration
- `secrets.ORG_AUTOMATION_TOKEN`
- `vars.CHITTYCONNECT_ACCESS_BROKER_URL`
- `secrets.CHITTYCONNECT_BROKER_TOKEN`
- `secrets.OP_SERVICE_ACCOUNT_TOKEN`

Optional downstream targets (if broker returns them dynamically):
- ChittyGateway dispatch endpoint/token
- ChittyAgent orchestrator endpoint/token
