#!/usr/bin/env bash
#
# Runs INSIDE the container launched by `smoke-linux.sh`. Not meant to be run directly.
#
# Builds the app, starts a REAL Electron window under Xvfb, and drives it over the Chrome
# DevTools Protocol. §8.1's smoke path — the thing that was missing from all four failed betas,
# where four releases shipped on green unit suites and nobody ever opened the built app.

set -euo pipefail

mkdir -p /work
cd /src
tar cf - --exclude=node_modules --exclude=dist --exclude=.git . | (cd /work && tar xf -)
cd /work

echo "=== npm ci (with scripts: Electron's binary IS the point here) ==="
npm ci --no-audit --no-fund >/tmp/ci.log 2>&1 || { tail -40 /tmp/ci.log; exit 1; }

echo "=== build ==="
npm run build >/tmp/build.log 2>&1 || { tail -40 /tmp/build.log; exit 1; }

echo "=== launching Electron under Xvfb ==="
#
# `--no-sandbox` is a CONTAINER concession, not a product change: Chromium's sandbox needs user
# namespaces that a default Docker container does not grant. It is passed on the command line
# here and appears nowhere in `src/`.
#
# `--remote-debugging-port` is likewise a Chromium flag, not a hook in the product. The
# previous build had a `GENIE_E2E` env var that changed how the app behaved — it
# short-circuited the single-instance lock — and the measured result was two instances opening
# windows on the owner's desktop while real agents were mid-turn. **A harness that requires the
# product to behave differently is a harness that tests a different product.**
#
xvfb-run --auto-servernum --server-args='-screen 0 1440x900x24' \
    npx electron . --no-sandbox --remote-debugging-port=9222 >/tmp/electron.log 2>&1 &
ELECTRON_PID=$!

cleanup() {
    kill "$ELECTRON_PID" 2>/dev/null || true
    wait "$ELECTRON_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== driving it over CDP ==="
if node scripts/smoke-cdp.mjs; then
    status=0
else
    status=$?
    echo ""
    echo "--- electron's own output, because a smoke failure is usually explained there ---"
    tail -60 /tmp/electron.log || true
fi

# The screenshot goes back to the host through the output mount, so a human can look at it.
# Writing one is not the same as somebody having seen it.
if [ -f /work/smoke-dashboard.png ] && [ -d /out ]; then
    cp /work/smoke-dashboard.png /out/smoke-dashboard.png
    echo "screenshot copied to the host"
fi

exit "$status"
