#!/usr/bin/env bash
set -euo pipefail

TARGET_FILE="${1:-.chittyconnect.yml}"

if [[ ! -f "${TARGET_FILE}" ]]; then
  echo "Missing required onboarding file: ${TARGET_FILE}" >&2
  exit 1
fi

required_patterns=(
  "onboarding:"
  "provisions:"
  "chitty_id:"
  "service_token:"
  "certificate:"
  "trust_chain:"
  "context_consciousness:"
  "chittydna:"
  "memorycloude:"
  "synthetic_entity:"
  "type:"
  "classification:"
  "authority_scope:"
  "access_scope:"
  "actor_binding:"
)

missing=0
for pattern in "${required_patterns[@]}"; do
  if ! grep -Eq "^[[:space:]-]*${pattern}[[:space:]]*" "${TARGET_FILE}"; then
    echo "Missing onboarding key pattern: ${pattern}" >&2
    missing=1
  fi
done

if [[ "${missing}" -ne 0 ]]; then
  echo "ChittyID context onboarding policy check failed." >&2
  exit 1
fi

echo "ChittyID context onboarding policy check passed."
