# Org Governance Audit Report

- Timestamp (UTC): 20260302T002833Z
- Policy: .github/org-governance-policy.json

## Summary

- Repos audited: 1
- Compliant repos: 0
- Non-compliant repos: 1

## By Org

| Org | Audited | Compliant | Non-Compliant |
|---|---:|---:|---:|
| CHITTYOS | 1 | 0 | 1 |

## Non-Compliant Repositories

| Repository | Score | Missing Files | Missing Patterns | Missing Triggers | Missing Status Checks | Branch Protection |
|---|---:|---|---|---|---|---|
| CHITTYOS/chittyscore | 2% | .github/workflows/governance-gates.yml, .github/workflows/adversarial-review.yml, .github/workflows/identity-context-onboarding.yml, .github/workflows/onepassword-rotation-audit.yml, .github/secret-catalog.json, .github/allowed-workflow-secrets.txt, .gitleaks.toml | .chittyconnect.yml:onboarding:, .chittyconnect.yml:provisions:, .chittyconnect.yml:chitty_id:, .chittyconnect.yml:service_token:, .chittyconnect.yml:certificate:, .chittyconnect.yml:trust_chain:, .chittyconnect.yml:context_consciousness:, .chittyconnect.yml:enabled:, .chittyconnect.yml:chittydna:, .chittyconnect.yml:memorycloude:, .chittyconnect.yml:synthetic_entity:, .chittyconnect.yml:type:, .chittyconnect.yml:classification:, .chittyconnect.yml:authority_scope:, .chittyconnect.yml:access_scope:, .chittyconnect.yml:actor_binding: | .github/workflows/adversarial-review.yml:pull_request_target, .github/workflows/governance-gates.yml:pull_request, .github/workflows/governance-gates.yml:push, .github/workflows/identity-context-onboarding.yml:pull_request, .github/workflows/identity-context-onboarding.yml:push, .github/workflows/onepassword-rotation-audit.yml:schedule, .github/workflows/onepassword-rotation-audit.yml:workflow_dispatch | Governance Gates / gates, Identity & Context Onboarding Gate / identity-onboarding, Adversarial Review Orchestrator / orchestrate | true |
