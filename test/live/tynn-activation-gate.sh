#!/usr/bin/env bash
set -euo pipefail
export GENIE_TEST_VM=1
npm ci --no-audit --no-fund
npx vitest run test/tynn-activation.test.ts test/tynn-config-cleanup.test.ts test/tynn-inherited-policy.test.ts test/mcp-preparation-error.test.ts test/tynn-agent-identities.test.ts test/tynn-agent-token.test.ts test/codex-mcp-startup.test.ts test/agent-mcp-preparation.test.ts
npm run typecheck
python3 test/live/tynn-activation-breaks.py
npx vitest run test/tynn-activation.test.ts test/tynn-config-cleanup.test.ts test/tynn-inherited-policy.test.ts test/mcp-preparation-error.test.ts
npx tsx test/live/agent-mcp-preparation.live.ts
npx tsx test/live/tynn-activation.live.ts
npm run verify
test -f dist/renderer/index.html
test -f dist/main/entry.js
test -f dist/main/main.js
test -f dist/main/preload.cjs
grep -q 'require(' dist/main/preload.cjs
if grep -Eq '^import .* from' dist/main/preload.cjs; then exit 1; fi
if grep -Eq '(src|href)="/' dist/renderer/index.html; then exit 1; fi
echo 'PASS activation focused/full suites, typecheck, six causal controls, both native adapter gates and bundles.'
