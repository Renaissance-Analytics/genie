#!/usr/bin/env bash
# Provision the Ubuntu WSL2 VM to run Genie's Playwright/Electron E2E suite.
#
# WHY A VM AND NOT THE DESKTOP
#
# RULES.md:154 — "Agents do not launch browsers, Electron apps, or GUI test runs on the
# owner's machine. Verification happens on CI, or in a VM." Only the CI branch was ever
# built. This is the other one. WSL2 is a real VM with its own kernel, and Electron draws to
# a virtual display inside it, so nothing ever reaches the Windows desktop.
#
# WHY A SEPARATE CHECKOUT INSIDE THE VM
#
# The Windows worktree's node_modules holds WINDOWS binaries — node-pty, better-sqlite3 and
# electron all ship per-platform — and reusing them from Linux fails in ways that look like
# product bugs rather than setup ones. /mnt/c is also slow enough that `npm ci` across it
# takes minutes instead of seconds. So the VM gets its own clone on its own filesystem.
#
# SPLIT IN TWO ON PURPOSE
#
# Only `--system` needs sudo, and sudo here is interactive. Everything else installs into
# $HOME so an agent can run it unattended. That keeps the human's involvement to one command,
# once, instead of a password prompt on every provision.
#
# Idempotent: every step checks before it installs.

set -euo pipefail

NODE_MAJOR=22          # Owner directive for this repo, and what e2e.yml pins.
CHECKOUT="${GENIE_VM_CHECKOUT:-$HOME/genie-e2e}"
REMOTE="${GENIE_REMOTE:-https://github.com/Renaissance-Analytics/genie.git}"
NVM_DIR="$HOME/.nvm"

say() { printf '\n=== %s ===\n' "$1"; }

# WSL inherits the WINDOWS PATH, so `/mnt/c/.../npm` and Windows' node.exe shadow the Linux
# ones and every call dies with "exec: node: Permission denied" — a Linux shell cannot exec a
# PE binary. That error names the wrong thing entirely; it reads as a broken install rather
# than as the wrong node being first on PATH. Stripped here once, for every step below.
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/c' | paste -sd: -)"
export PATH

# ---------------------------------------------------------------- system (sudo)
if [ "${1:-}" = "--system" ]; then
    say "system packages (needs sudo)"
    # Bounded retries, like e2e.yml's own apt step: an unreachable Ubuntu mirror has taken
    # that workflow down twice, and a mirror outage must not be what decides whether the
    # suite can run.
    sudo apt-get update -o Acquire::Retries=2 -o Acquire::http::Timeout=15
    # xvfb is the virtual display. Without it Electron exits immediately with a DISPLAY
    # error that reads like a product crash. The rest are what Electron shares with
    # Chromium — Playwright knows the list better than a hand-written one does.
    sudo apt-get install -y xvfb git build-essential python3
    say "Electron/Chromium shared libraries"
    if [ -x "$NVM_DIR/nvm.sh" ] || [ -s "$NVM_DIR/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh"
    fi
    sudo "$(command -v npx)" --yes playwright install-deps chromium \
        || echo "WARNING: install-deps failed — the first browser launch is the real test"
    say "system done — now run this script with no arguments"
    exit 0
fi

# ------------------------------------------------------------- user ($HOME only)
say "VM"
echo "kernel: $(uname -sr)"
echo "cpus:   $(nproc)"
echo "mem:    $(free -h | awk '/^Mem:/ {print $2}')"

say "Node ${NODE_MAJOR} (via nvm, no sudo)"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
if [ "$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')" = "$NODE_MAJOR" ]; then
    echo "already node $(node -v)"
else
    # The major version is not cosmetic: prism and the ACP packages declare engines >= 22,
    # and an older node fails at spawn with an unsupported-engine error and nothing on screen.
    nvm install "$NODE_MAJOR"
    nvm alias default "$NODE_MAJOR"
fi
nvm use "$NODE_MAJOR" >/dev/null
echo "node $(node -v), npm $(npm -v)"

say "checkout at ${CHECKOUT}"
if [ -d "$CHECKOUT/.git" ]; then
    echo "already cloned"
else
    # Blobless: the suite needs the tree at one ref, not a decade of history.
    git clone --filter=blob:none "$REMOTE" "$CHECKOUT"
fi

say "readiness"
printf 'node     %s\n' "$(node -v)"
printf 'npm      %s\n' "$(npm -v)"
printf 'xvfb     %s\n' "$(command -v xvfb-run || echo 'MISSING — run with --system')"
printf 'checkout %s\n' "$CHECKOUT"
