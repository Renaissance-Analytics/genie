#!/usr/bin/env bash
# The ROOT half of VM provisioning. Run as: wsl -d Ubuntu -u root -- bash <this>
#
# Separate from provision-e2e-vm.sh because only these steps need root, and WSL gives root
# WITHOUT a password (`wsl -u root`) while the default user's sudo prompts for one. That
# distinction is the difference between an agent provisioning this unattended and handing
# the job back to a human — I handed it back once before checking, which was wrong.
#
# It is a FILE rather than an inline `bash -lc "..."` on purpose: passing a script through
# wsl.exe from Git Bash mangles `$VAR` expansions and quoting, and it fails in the worst
# way — `apt-get` reported exit 0 while xvfb was never installed, because the command it ran
# was not the command intended. A file has exactly one layer of quoting.

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# WSL inherits the Windows PATH; `/mnt/c` entries shadow Linux binaries and make calls fail
# with "exec: ... Permission denied", which names the wrong thing entirely.
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/c' | paste -sd: -)"
export PATH

echo "=== apt update ==="
# `--allow-releaseinfo-change`: this VM carries the ondrej/php PPA, which renamed its Label.
# apt treats that as a trust-relevant change and REFUSES the whole update (exit 100) until a
# human accepts it — so one unrelated third-party repo blocks installing xvfb. Accepting a
# label rename is not accepting a new signing key; the repo's keys are unchanged.
apt-get update --allow-releaseinfo-change -o Acquire::Retries=2 -o Acquire::http::Timeout=15

echo "=== xvfb + build prerequisites ==="
# xvfb is the virtual display. Without it Electron exits immediately with a DISPLAY error
# that reads like a product crash rather than a missing package.
apt-get install -y xvfb git build-essential python3

echo "=== Electron's OWN shared libraries ==="
# NOT the same set as Chromium's, which is the trap. `playwright install-deps chromium`
# succeeds and Electron still cannot start, because Electron links GTK and Chromium (as
# Playwright ships it) does not. Measured here: the binary existed, was executable, and died
# with `libgtk-3.so.0: cannot open shared object file`. Playwright reports that as
# "Process failed to launch!", which names nothing and sends you looking at the app.
#
# Run BEFORE install-deps so the specific failure is fixed even if the generic step fails.
apt-get install -y \
    libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils \
    libatspi2.0-0 libdrm2 libgbm1 libxcb-dri3-0 libasound2

echo "=== Chromium shared libraries (Playwright's list) ==="
# Electron shares Chromium's .so set; Playwright knows the list better than a hand-written
# one. Non-fatal, exactly as e2e.yml treats it: an apt mirror outage must not decide whether
# the suite can run, and the first browser launch is the real test of a missing library.
NVM_DIR=/home/wish/.nvm
if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm use default >/dev/null 2>&1 || true
fi
if command -v npx >/dev/null 2>&1; then
    npx --yes playwright install-deps chromium || echo "WARNING: install-deps failed"
else
    echo "WARNING: npx not found as root — run the user half first"
fi

echo "=== verify ==="
printf 'xvfb-run: %s\n' "$(command -v xvfb-run || echo MISSING)"
printf 'git:      %s\n' "$(command -v git || echo MISSING)"
# Fail loudly rather than reporting success with the one thing that matters absent — which
# is exactly what happened on the first attempt.
command -v xvfb-run >/dev/null 2>&1 || { echo "FAILED: xvfb-run still missing"; exit 1; }
ldconfig -p | grep -q libgtk-3.so.0 || { echo "FAILED: libgtk-3.so.0 still missing — Electron will not start"; exit 1; }
echo "system provisioning OK"
