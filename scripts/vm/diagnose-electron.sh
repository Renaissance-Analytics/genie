#!/usr/bin/env bash
# Why will Electron not launch in the VM?
#
# A FILE, not an inline `bash -lc "..."`. Passing a script through wsl.exe from Git Bash
# mangles quoting badly enough that it has already produced a false success here (apt
# reporting exit 0 while xvfb was never installed). One layer of quoting, every time.

set -uo pipefail

PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/c' | paste -sd: -)"
export PATH
# shellcheck disable=SC1091
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" && nvm use default >/dev/null 2>&1

cd "${GENIE_VM_CHECKOUT:-$HOME/genie-e2e}" || exit 1

echo "=== electron package ==="
BIN="$(node -p 'require("electron")' 2>/dev/null)"
echo "resolved: ${BIN:-UNRESOLVED}"
[ -n "$BIN" ] && ls -l "$BIN" 2>/dev/null

echo
echo "=== dist dir ==="
ls -la node_modules/electron/dist 2>/dev/null | head -5 || echo "no dist/ — the postinstall download never ran"

echo
echo "=== direct launch under xvfb ==="
# `--version` exits immediately, so this isolates "can the process start at all" from
# anything Playwright or the app does. A missing shared library NAMES ITSELF here, which is
# the whole reason to try it directly rather than reading Playwright's generic
# "Process failed to launch!".
if [ -n "$BIN" ] && [ -x "$BIN" ]; then
    xvfb-run --auto-servernum "$BIN" --version 2>&1 | head -10
    echo "launch exit=${PIPESTATUS[0]}"
else
    echo "no executable to try"
fi

echo
echo "=== missing shared libraries ==="
if [ -n "$BIN" ] && [ -x "$BIN" ]; then
    ldd "$BIN" 2>/dev/null | grep -i "not found" || echo "none missing per ldd"
fi
