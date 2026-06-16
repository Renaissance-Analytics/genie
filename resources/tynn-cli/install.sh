#!/usr/bin/env bash
# Tynn CLI Installer
#
# Usage:
#   ./install.sh           - Install tynn-cli commands to PATH
#   ./install.sh --test    - Install and verify commands are accessible
#   ./install.sh --help    - Show this help
#
# This script:
# 1. Adds the bin/ directory to your PATH in ~/.bashrc
# 2. Adds .custom/ directory for user overrides (takes precedence)
# 3. Creates tynn.config from template if it doesn't exist
# 4. Makes all scripts executable

set -euo pipefail

# Source bashrc to ensure consistent environment
if [[ -f "${HOME}/.bashrc" ]]; then
  source "${HOME}/.bashrc" 2>/dev/null || true
  shopt -s expand_aliases 2>/dev/null || true
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${REPO_DIR}/bin"
CUSTOM_DIR="${REPO_DIR}/.custom"
BASHRC="${HOME}/.bashrc"
CONFIG_FILE="${REPO_DIR}/tynn.config"
CONFIG_EXAMPLE="${REPO_DIR}/tynn.config.example"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

log()  { printf "📂 %s\n" "$*"; }
info() { printf "⚡ %s\n" "$*"; }
warn() { printf "⚠️  %s\n" "$*" >&2; }
die()  { printf "❌ %s\n" "$*" >&2; exit 1; }
ok()   { printf "✅ %s\n" "$*"; }

# ─────────────────────────────────────────────────────────────────────────────
# Parse flags
# ─────────────────────────────────────────────────────────────────────────────

RUN_TEST=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test)
      RUN_TEST=true
      shift
      ;;
    --help|-h)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

# ─────────────────────────────────────────────────────────────────────────────
# Create .custom directory for user overrides
# ─────────────────────────────────────────────────────────────────────────────

if [[ ! -d "$CUSTOM_DIR" ]]; then
  mkdir -p "$CUSTOM_DIR"
  ok "Created .custom/ directory for user overrides"
else
  log ".custom/ directory already exists"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Make scripts executable
# ─────────────────────────────────────────────────────────────────────────────

chmod +x "$BIN_DIR"/* 2>/dev/null || true
chmod +x "$CUSTOM_DIR"/* 2>/dev/null || true
ok "Made scripts executable"

# ─────────────────────────────────────────────────────────────────────────────
# Create or update tynn.config (preserve existing license data)
# ─────────────────────────────────────────────────────────────────────────────

if [[ ! -f "$CONFIG_FILE" && -f "$CONFIG_EXAMPLE" ]]; then
  cp "$CONFIG_EXAMPLE" "$CONFIG_FILE"
  ok "Created tynn.config from template"
  warn "Edit tynn.config to set your SANDBOX_PATH"
elif [[ -f "$CONFIG_FILE" && -f "$CONFIG_EXAMPLE" ]]; then
  # Merge new settings from example without overwriting existing values.
  # Extracts keys from example, adds any missing ones to the user's config,
  # and always preserves existing values (especially LICENSES).
  _new_keys=0
  while IFS= read -r line; do
    # Match uncommented variable assignments (KEY="..." or KEY='...')
    if [[ "$line" =~ ^([A-Z_]+)= ]]; then
      key="${BASH_REMATCH[1]}"
      # Only add if key is not already present (commented or uncommented)
      if ! grep -q "^${key}=" "$CONFIG_FILE" 2>/dev/null; then
        echo "" >> "$CONFIG_FILE"
        echo "$line" >> "$CONFIG_FILE"
        _new_keys=$((_new_keys + 1))
      fi
    fi
  done < "$CONFIG_EXAMPLE"
  if [[ $_new_keys -gt 0 ]]; then
    ok "Added $_new_keys new config key(s) from template (existing values preserved)"
  else
    log "tynn.config is up to date"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Update PATH in bashrc
# ─────────────────────────────────────────────────────────────────────────────

# Convert Windows path to Git Bash format if needed
BIN_PATH="$BIN_DIR"
CUSTOM_PATH="$CUSTOM_DIR"

# On Windows/Git Bash, convert C:\ to /c/
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
  BIN_PATH=$(echo "$BIN_DIR" | sed 's|\\|/|g' | sed 's|^\([A-Za-z]\):|/\L\1|')
  CUSTOM_PATH=$(echo "$CUSTOM_DIR" | sed 's|\\|/|g' | sed 's|^\([A-Za-z]\):|/\L\1|')
fi

# PATH line: .custom first (for overrides), then bin
PATH_LINE="export PATH=\"$CUSTOM_PATH:$BIN_PATH:\$PATH\""

if [[ -f "$BASHRC" ]]; then
  # Remove old tynn-cli or wish-cli entries
  if command -v sed >/dev/null 2>&1; then
    # Remove old blocks (tynn-cli and wish-cli)
    sed -i '/# tynn-cli/,/export PATH.*tynn-cli/d' "$BASHRC" 2>/dev/null || \
    sed -i '' '/# tynn-cli/,/export PATH.*tynn-cli/d' "$BASHRC" 2>/dev/null || true

    sed -i '/# wish-cli/,/export PATH.*wish-cli/d' "$BASHRC" 2>/dev/null || \
    sed -i '' '/# wish-cli/,/export PATH.*wish-cli/d' "$BASHRC" 2>/dev/null || true
  fi

  # Check if already present
  if grep -qF "$BIN_PATH" "$BASHRC" 2>/dev/null; then
    ok "PATH entry already present in ~/.bashrc"
  else
    # Add new entry
    echo "" >> "$BASHRC"
    echo "# tynn-cli" >> "$BASHRC"
    echo "$PATH_LINE" >> "$BASHRC"
    ok "Added tynn-cli to PATH in ~/.bashrc"
  fi
else
  warn "~/.bashrc not found. Create it and add:"
  echo "    $PATH_LINE"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Test installation
# ─────────────────────────────────────────────────────────────────────────────

if [[ "$RUN_TEST" == true ]]; then
  echo ""
  info "Testing installation..."

  # Source bashrc and check if commands are available
  test_result=0

  # Test in a subshell
  if bash -c "source ~/.bashrc 2>/dev/null && command -v resetme >/dev/null 2>&1"; then
    ok "resetme command is accessible"
  else
    warn "resetme command not found in PATH"
    test_result=1
  fi

  if bash -c "source ~/.bashrc 2>/dev/null && command -v sandbox >/dev/null 2>&1"; then
    ok "sandbox command is accessible"
  else
    warn "sandbox command not found in PATH"
    test_result=1
  fi

  if [[ $test_result -eq 0 ]]; then
    ok "All tests passed!"
  else
    die "Some tests failed. Check your PATH configuration."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────

echo ""
ok "Installation complete!"
echo ""
echo "💡 To use immediately, run:"
echo "   source ~/.bashrc"
echo ""
echo "💡 To override a command, copy it to .custom/ and modify:"
echo "   cp bin/resetme .custom/resetme"
echo ""
if [[ -f "$CONFIG_FILE" ]]; then
  if ! grep -q '^SANDBOX_PATH="[^"]\+"' "$CONFIG_FILE" 2>/dev/null; then
    echo "⚠️  Don't forget to set SANDBOX_PATH in tynn.config"
    echo ""
  fi
fi
