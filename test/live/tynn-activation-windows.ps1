$ErrorActionPreference = 'Stop'
$env:GENIE_TEST_VM = '1'
& npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# These cases make real private ACL calls. One worker avoids competing native permission helpers;
# the per-case budget bounds several calls, each with its own production 60-second deadline.
& npx.cmd vitest run test/tynn-activation.test.ts test/tynn-config-cleanup.test.ts test/tynn-inherited-policy.test.ts test/mcp-preparation-error.test.ts test/tynn-agent-identities.test.ts test/tynn-agent-token.test.ts test/codex-mcp-startup.test.ts test/agent-mcp-preparation.test.ts --maxWorkers=1 --testTimeout=180000
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& npx.cmd tsx test/live/tynn-activation.live.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'PASS Windows activation focused suite, typecheck and actual adapter composition. Synthetic API/encryption ports; safeStorage/DPAPI has its separate native gate.'
exit 0
