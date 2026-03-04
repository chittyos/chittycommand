#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-.}"

DISCOVERY_BLOCK='<!-- chitty:discovery-links:start -->
## Persistent Context

- **Working memory brief**: [docs/PERSISTENT_BRIEF.md](docs/PERSISTENT_BRIEF.md)
- **Canonical governance**: `chittycanon://gov/governance`
- **TY/VY/RY framework**: `chittycanon://gov/governance#three-aspects-framework`
- **Context model**: `chittycanon://docs/tech/spec/context-schema`
- **Session governance genes**: `chittycanon://specs/chittydna-session-governance`
- **Governance DNA / earned authority**: `chittycanon://gov/governance#written-to-chittydna`

This section is a persistent discovery hint for humans and agents. It is not an authority source.
<!-- chitty:discovery-links:end -->'

BRIEF_ANCHORS_BLOCK='<!-- chitty:persistent-brief-anchors:start -->
## Discovery Anchors

- TY/VY/RY framework: `chittycanon://gov/governance#three-aspects-framework`
- Session genes: `chittycanon://specs/chittydna-session-governance`
- Governance DNA: `chittycanon://gov/governance#written-to-chittydna`
<!-- chitty:persistent-brief-anchors:end -->'

ensure_frontmatter_refs() {
  local file="$1"
  local tmp
  local end_line

  grep -q '^context_brief:' "$file" && return 0
  tmp="$(mktemp)"

  if [[ "$(head -n1 "$file" || true)" == "---" ]]; then
    end_line="$(awk 'NR>1 && $0=="---" {print NR; exit}' "$file")"
    [[ -n "${end_line:-}" ]] || return 0
    {
      head -n $((end_line - 1)) "$file"
      cat <<'YAML'
context_brief: chittycontext://persistent-brief
discovery_refs:
  - chittycanon://gov/governance
  - chittycanon://docs/tech/spec/context-schema
  - chittycanon://specs/chittydna-session-governance
YAML
      tail -n +"$end_line" "$file"
    } > "$tmp"
    mv "$tmp" "$file"
    return 0
  fi

  {
    cat <<'YAML'
---
context_brief: chittycontext://persistent-brief
discovery_refs:
  - chittycanon://gov/governance
  - chittycanon://docs/tech/spec/context-schema
  - chittycanon://specs/chittydna-session-governance
---

YAML
    cat "$file"
  } > "$tmp"
  mv "$tmp" "$file"
}

upsert_discovery_block() {
  local file="$1"
  local tmp
  tmp="$(mktemp)"

  if grep -q '<!-- chitty:discovery-links:start -->' "$file"; then
    perl -0777 -pe "s@<!-- chitty:discovery-links:start -->.*?<!-- chitty:discovery-links:end -->@${DISCOVERY_BLOCK}@s" "$file" > "$tmp"
    mv "$tmp" "$file"
    return 0
  fi

  if grep -q '^# ' "$file"; then
    inserted=false
    while IFS= read -r line || [[ -n "$line" ]]; do
      printf '%s\n' "$line" >> "$tmp"
      if [[ "${inserted}" == "false" && "$line" == \#\ * ]]; then
        printf '\n%s\n\n' "$DISCOVERY_BLOCK" >> "$tmp"
        inserted=true
      fi
    done < "$file"
    if [[ "${inserted}" == "false" ]]; then
      printf '\n%s\n' "$DISCOVERY_BLOCK" >> "$tmp"
    fi
    mv "$tmp" "$file"
  else
    {
      cat "$file"
      printf "\n%s\n" "$DISCOVERY_BLOCK"
    } > "$tmp"
    mv "$tmp" "$file"
  fi
}

upsert_brief_anchors() {
  local file="$1"
  local tmp
  tmp="$(mktemp)"

  if grep -q '<!-- chitty:persistent-brief-anchors:start -->' "$file"; then
    perl -0777 -pe "s@<!-- chitty:persistent-brief-anchors:start -->.*?<!-- chitty:persistent-brief-anchors:end -->@${BRIEF_ANCHORS_BLOCK}@s" "$file" > "$tmp"
    mv "$tmp" "$file"
    return 0
  fi

  if grep -q '^## Discovery Anchors' "$file"; then
    # Leave existing anchors untouched when they already exist.
    return 0
  fi

  {
    cat "$file"
    printf "\n%s\n" "$BRIEF_ANCHORS_BLOCK"
  } > "$tmp"
  mv "$tmp" "$file"
}

count=0
while IFS= read -r file; do
  ensure_frontmatter_refs "$file"
  upsert_discovery_block "$file"
  count=$((count + 1))
  echo "Stamped: $file"
done < <(find "$ROOT_DIR" -type f \( -name 'CHITTY.md' -o -name 'CHARTER.md' \) | sort)

while IFS= read -r file; do
  upsert_brief_anchors "$file"
  count=$((count + 1))
  echo "Stamped: $file"
done < <(find "$ROOT_DIR" -type f -path '*/docs/PERSISTENT_BRIEF.md' | sort)

echo "Updated $count files."
