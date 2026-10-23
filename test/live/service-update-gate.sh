#!/usr/bin/env bash
# Only invoked through the envelope's test-VM runner. Does not use any owner's service or credential.
set -euo pipefail
[[ "${GENIE_SERVICE_UPDATE_VM_PROOF:-}" == 1 ]] || { echo 'Run through the test VM, with GENIE_SERVICE_UPDATE_VM_PROOF=1'; exit 2; }
npm ci
npm run typecheck
npx vitest run --reporter=dot
npm run build
sudo systemctl start docker
npx tsx test/live/service-update.live.ts
set +e
GENIE_SERVICE_UPDATE_BREAK_PROBE=1 npx tsx test/live/service-update.live.ts > /tmp/genie-service-update-break.log 2>&1
break_status=$?
set -e
if [[ "$break_status" == 0 ]]; then echo 'FAIL: bypassing update did not fail the real-container proof'; exit 1; fi
if ! rg -q 'the container must actually be recreated' /tmp/genie-service-update-break.log; then cat /tmp/genie-service-update-break.log; exit 1; fi
echo 'PASS: bypassing recreation fails the real-container proof; positive and negative runs cleaned their own data.'
