#!/usr/bin/env bash
# Run Genie's E2E suite inside the Ubuntu WSL2 VM.
#
#   scripts/vm/e2e-vm.sh <git-ref> [playwright args...]
#   scripts/vm/e2e-vm.sh main
#   scripts/vm/e2e-vm.sh my-branch e2e/deck.spec.ts
#
# Electron draws to a virtual display that exists only inside the VM, so nothing ever
# appears on the Windows desktop — which is the entire point (RULES.md:154).
#
# THIS IS NOT A REPLACEMENT FOR CI.
#
# CI runs a three-OS matrix and this is the Linux leg alone. The repo's own history is full
# of failures that appeared on exactly one platform — inertia page paths that only broke on
# Linux, ConPTY behaviour that only exists on Windows, an unsigned build that only matters on
# macOS. Use this to shorten the loop; CI stays the gate before merge.

set -euo pipefail

CHECKOUT="${GENIE_VM_CHECKOUT:-$HOME/genie-e2e}"
REF="${1:-main}"
shift || true

# WSL inherits the Windows PATH, so Windows' node.exe and npm shim shadow the Linux ones and
# fail with "exec: node: Permission denied" — an error that names the wrong thing entirely.
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/c' | paste -sd: -)"
export PATH
# shellcheck disable=SC1091
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" && nvm use default >/dev/null 2>&1

command -v xvfb-run >/dev/null 2>&1 || {
    echo "xvfb-run is missing. Run once, interactively:"
    echo "  wsl -d Ubuntu -- bash ~/bin/provision-e2e-vm.sh --system"
    exit 2
}

say() { printf '\n=== %s ===\n' "$1"; }

cd "$CHECKOUT"

say "ref ${REF}"
git fetch --prune origin
# Detached on purpose: this checkout is a test fixture, not somewhere work happens, and a
# local branch here would quietly diverge from the one being tested.
git checkout --detach "origin/${REF}" 2>/dev/null || git checkout --detach "$REF"
git --no-pager log -1 --oneline

say "install"
# `npm ci` not `install`: the lockfile is the thing under test, and a resolution that only
# happens on this machine would make a green run mean nothing.
npm ci

say "playwright browser"
# The npm package ships no browsers. A spec opens a Chromium context for the mobile web UI,
# so chromium is required even though the suite mostly drives Electron.
npx playwright install chromium

say "native modules"
npm run pretest:e2e

say "suite"
# xvfb-run gives Electron a display inside the VM. `--auto-servernum` so repeat runs do not
# collide on :99 — without it a second run fails with a server-already-active error that
# reads like a product fault.
set +e
xvfb-run --auto-servernum npm run test:e2e -- "$@"
STATUS=$?
set -e

say "result"
# The REAL status, reported explicitly. A pipe here would report the last command's status
# instead, which is the trap this repo has already paid for.
echo "exit=${STATUS}"
[ -d playwright-report ] && echo "report: \\\\wsl\$\\Ubuntu${CHECKOUT//\//\\}\\playwright-report\\index.html"
exit "$STATUS"
