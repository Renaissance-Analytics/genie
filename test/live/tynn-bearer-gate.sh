#!/usr/bin/env bash
set -euo pipefail
[ "${GENIE_TEST_VM:-}" = 1 ] || { echo 'VM-only probe'; exit 2; }
npx --no-install esbuild src/main/tynn-account.ts --bundle --platform=node --format=cjs --outfile=/tmp/genie-tynn-account.cjs
export GENIE_TYNN_ACCOUNT_BUNDLE=/tmp/genie-tynn-account.cjs
npx --no-install electron --ozone-platform=wayland test/live/tynn-bearer.live.cjs
if GENIE_TEST_BYPASS_BEARER_OMIT=1 npx --no-install electron --ozone-platform=wayland test/live/tynn-bearer.live.cjs > /tmp/genie-tynn-bearer-bypass.log 2>&1; then
    echo 'FAIL: cookie-omission bypass unexpectedly passed'; exit 1
fi
if ! rg -q 'ordinary API request has no Cookie header' /tmp/genie-tynn-bearer-bypass.log; then
    cat /tmp/genie-tynn-bearer-bypass.log
    echo 'FAIL: bypass failed for another reason'; exit 1
fi
echo 'PASS: bypass negative control failed at the Cookie-header assertion'
