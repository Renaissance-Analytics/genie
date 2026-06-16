#!/usr/bin/env bash
# License management utilities for tynn-cli
# Source this file to use license functions in commands

# ─────────────────────────────────────────────────────────────────────────────
# License Lookup
# ─────────────────────────────────────────────────────────────────────────────

# Get license params for a tool
# Usage: get_license "flux" "laravel" "myflux"
# Usage: get_license "flux" "laravel" "0"  (first match)
# Returns: JSON array of params, or empty if not found
get_license() {
  local tool="$1"
  local stack="$2"
  local lic_ref="${3:-}"

  # LICENSES should be set from tynn.config
  if [[ -z "${LICENSES:-}" || "$LICENSES" == "[]" ]]; then
    return 1
  fi

  # Prefer jq if available
  if command -v jq >/dev/null 2>&1; then
    _get_license_jq "$tool" "$stack" "$lic_ref"
  else
    _get_license_bash "$tool" "$stack" "$lic_ref"
  fi
}

# Get license using jq (preferred)
_get_license_jq() {
  local tool="$1"
  local stack="$2"
  local lic_ref="${3:-}"

  local result

  if [[ -z "$lic_ref" ]]; then
    # Get first matching license for tool+stack
    result=$(echo "$LICENSES" | jq -r \
      --arg tool "$tool" --arg stack "$stack" \
      '[.[] | select(.tool == $tool and .stack == $stack)][0].params // empty')
  elif [[ "$lic_ref" =~ ^[0-9]+$ ]]; then
    # Get by index (among matches for this tool+stack)
    result=$(echo "$LICENSES" | jq -r \
      --arg tool "$tool" --arg stack "$stack" --argjson idx "$lic_ref" \
      '[.[] | select(.tool == $tool and .stack == $stack)][$idx].params // empty')
  else
    # Get by name
    result=$(echo "$LICENSES" | jq -r \
      --arg tool "$tool" --arg stack "$stack" --arg name "$lic_ref" \
      '[.[] | select(.tool == $tool and .stack == $stack and .name == $name)][0].params // empty')
  fi

  if [[ -n "$result" && "$result" != "null" ]]; then
    echo "$result"
    return 0
  fi
  return 1
}

# Fallback bash JSON parsing (basic, for simple cases)
_get_license_bash() {
  local tool="$1"
  local stack="$2"
  local lic_ref="${3:-}"

  # Very basic parsing - extract params for matching entries
  # This is a simplified parser that works for well-formatted JSON
  local in_match=false
  local found_tool=false
  local found_stack=false
  local found_name=false
  local match_count=0
  local target_idx=-1
  local target_name=""

  if [[ "$lic_ref" =~ ^[0-9]+$ ]]; then
    target_idx="$lic_ref"
  elif [[ -n "$lic_ref" ]]; then
    target_name="$lic_ref"
  fi

  # Use grep/sed to find matching entries
  # This is a simplified approach - for complex JSON, jq is recommended
  local entry
  while IFS= read -r line; do
    # Check for tool match
    if [[ "$line" =~ \"tool\"[[:space:]]*:[[:space:]]*\"$tool\" ]]; then
      found_tool=true
    fi
    # Check for stack match
    if [[ "$line" =~ \"stack\"[[:space:]]*:[[:space:]]*\"$stack\" ]]; then
      found_stack=true
    fi
    # Check for name match
    if [[ -n "$target_name" && "$line" =~ \"name\"[[:space:]]*:[[:space:]]*\"$target_name\" ]]; then
      found_name=true
    fi
    # Check for params
    if [[ "$line" =~ \"params\"[[:space:]]*:[[:space:]]*\[(.+)\] ]]; then
      if [[ "$found_tool" == true && "$found_stack" == true ]]; then
        # Check if this is the entry we want
        if [[ -z "$lic_ref" ]]; then
          # First match
          echo "[${BASH_REMATCH[1]}]"
          return 0
        elif [[ "$target_idx" -ge 0 && "$match_count" -eq "$target_idx" ]]; then
          echo "[${BASH_REMATCH[1]}]"
          return 0
        elif [[ -n "$target_name" && "$found_name" == true ]]; then
          echo "[${BASH_REMATCH[1]}]"
          return 0
        fi
        ((match_count++))
      fi
      # Reset for next entry
      found_tool=false
      found_stack=false
      found_name=false
    fi
  done <<< "$LICENSES"

  return 1
}

# Extract param at index from JSON array
# Usage: lic_param '[\"email\", \"key\"]' 0  → email
# Usage: lic_param '[\"email\", \"key\"]' 1  → key
lic_param() {
  local params_json="$1"
  local index="$2"

  if command -v jq >/dev/null 2>&1; then
    echo "$params_json" | jq -r ".[$index] // empty"
  else
    # Basic extraction for simple arrays
    # Remove brackets and split by comma
    local clean="${params_json#[}"
    clean="${clean%]}"
    # Extract nth element (0-indexed)
    local i=0
    local IFS=','
    for param in $clean; do
      # Remove quotes and whitespace
      param="${param#\"}"
      param="${param%\"}"
      param="${param# }"
      param="${param% }"
      param="${param#\"}"
      param="${param%\"}"
      if [[ $i -eq $index ]]; then
        echo "$param"
        return 0
      fi
      ((i++))
    done
  fi
  return 1
}

# Check if license exists for tool+stack
# Usage: has_license "flux" "laravel"
has_license() {
  local tool="$1"
  local stack="$2"

  if [[ -z "${LICENSES:-}" || "$LICENSES" == "[]" ]]; then
    return 1
  fi

  if command -v jq >/dev/null 2>&1; then
    local count
    count=$(echo "$LICENSES" | jq \
      --arg tool "$tool" --arg stack "$stack" \
      '[.[] | select(.tool == $tool and .stack == $stack)] | length')
    [[ "$count" -gt 0 ]]
  else
    # Basic check - look for tool and stack in LICENSES
    [[ "$LICENSES" == *"\"tool\""*"\"$tool\""* && "$LICENSES" == *"\"stack\""*"\"$stack\""* ]]
  fi
}

# List available licenses for a tool+stack
# Usage: list_licenses "flux" "laravel"
list_licenses() {
  local tool="$1"
  local stack="$2"

  if [[ -z "${LICENSES:-}" || "$LICENSES" == "[]" ]]; then
    echo "No licenses configured"
    return 1
  fi

  if command -v jq >/dev/null 2>&1; then
    echo "$LICENSES" | jq -r \
      --arg tool "$tool" --arg stack "$stack" \
      '.[] | select(.tool == $tool and .stack == $stack) | "  - \(.name // "unnamed")"'
  else
    echo "  (install jq for detailed listing)"
  fi
}
