# THE HOST SPLIT ON WINDOWS (genie#1386 phase 1), in genie-test-windows: the focused tests, then host-split-proof.mjs.
# Run from the shipped tree: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/perf-lag/host-split-proof-windows.ps1
$ErrorActionPreference = 'Continue'
"=== node $(node -v)"
npm ci --no-audit --no-fund *> ci.log; "ci exit $LASTEXITCODE"; if ($LASTEXITCODE -ne 0) { Get-Content ci.log -Tail 30 }
npm run build *> build.log; "build exit $LASTEXITCODE"; if ($LASTEXITCODE -ne 0) { Get-Content build.log -Tail 30 }
"=== focused tests on Windows (named pipe, Job Object supervisor, real host process)"
npx vitest run test/session-engine.test.ts test/engine-protocol.test.ts test/genie-host-process.test.ts test/genie-host-no-electron.test.ts *> focused.log; "focused exit $LASTEXITCODE"
Get-Content focused.log | Select-String -Pattern 'Test Files|Tests |FAIL|×' | Select-Object -First 40
"=== live proof: same heavy load, agents in main (before) vs in genie-host (after), then a window crash"
node scripts/perf-lag/host-split-proof.mjs 180 0.25 *> proof.log; "proof exit $LASTEXITCODE"
Get-Content proof.log | Select-String -Pattern '^\[proof' | Select-Object -Last 20
"=== host-split-proof.json"
Get-Content perf-out\host-split-proof.json
"=== genie-host.log (tail)"
Get-Content "$HOME\.genie\logs\genie-host.log" -Tail 30 -ErrorAction SilentlyContinue
"=== lifecycle.log host lines"
Get-Content "$HOME\.genie\runtime\lifecycle.log" -ErrorAction SilentlyContinue | Select-String -Pattern 'host|refused' | Select-Object -Last 20
"=== FULL SUITE on Windows"
npm test *> full.log; "full suite exit $LASTEXITCODE"
Get-Content full.log | Select-String -Pattern 'Test Files|Tests |FAIL' | Select-Object -First 40
"=== UPGRADE PROOF (installed build, agent host running): scripts/vm-windows-update.ps1"
Remove-Item -Recurse -Force "$HOME\.genie" -ErrorAction SilentlyContinue
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vm-windows-update.ps1 *> upgrade.log; "upgrade exit $LASTEXITCODE"
Get-Content upgrade.log | Select-String -Pattern '^=== |PASS|FAIL|ok |not ok|check|Genie.exe|0\.0\.1|report' | Select-Object -Last 50
"=== agent host in the installed build (lifecycle.log, genie-host.log)"
Get-Content "$HOME\.genie\runtime\lifecycle.log" -ErrorAction SilentlyContinue | Select-String -Pattern 'agent host|host boot|host shutdown|agent-host' | Select-Object -Last 20
Get-Content "$HOME\.genie\logs\genie-host.log" -Tail 25 -ErrorAction SilentlyContinue
