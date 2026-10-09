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
# KNOWN DIVERGENCE — four specs fail HERE and pass on CI's ubuntu runner.
#
# Measured on `feat/workspace-file-panel-states`, whose CI run is green on all three
# platforms at the same SHA:
#
#   e2e/agent-access.spec.ts:53   expect('.agent-form-ws-row').toHaveCount(1) -> got 10
#   e2e/agent-access.spec.ts:77   same shape
#   e2e/workspace-hibernation.spec.ts:80, :147   15s / 1m timeouts
#
# They fail in isolation too, so it is NOT contention from running the full suite.
#
# My first guess was leftover state, like the `genie-apps` one below. MEASURED AND WRONG:
# `find / -name genie.db` across the VM returns nothing on its Linux filesystem — only
# copies under /mnt/c, which is Windows. The E2E profile does not survive a run, so nothing
# accumulates. The `agent-access` harness seeds 2 workspaces and the spec expects 1 row; it
# sees 10. That is not a leftover database.
#
# So the cause is UNKNOWN. Recording the disproved hypothesis too, because the next person
# will have the same idea and can skip it.
#
# So: a red here is a QUESTION, not a verdict. Check CI before believing it, and check these
# four first. Everything else in the suite has matched CI.
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

say "reset per-run state"
# CI gets a CLEAN MACHINE for every run; this VM does not, and that difference is not
# cosmetic. `genie-apps.spec.ts` scaffolds into `~/genie-apps/<slug>.gapp` and the product
# refuses to scaffold into a non-empty folder — correctly — so the second run onward fails
# four specs with "Target folder … is not empty".
#
# Measured, not guessed: that is exactly what happened on the second run here, and it
# presents as four failures at 5-7ms each. A spec that fails in single-digit milliseconds
# did not run; it inherited a broken setup. Without this reset the VM would start reporting
# failures that CI does not have, and a local harness nobody trusts is worse than none.
rm -rf "$HOME/genie-apps"

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
