<#
Opt-in Tynn #564 M4-M6 job, Azure Windows D8ads_v5, IN GENIE'S LOGGED-ON SESSION. Never on the owner's desktop.
Outer queue job writes ci-measure564-source.txt (the queued source SHA, provenance only), then:
    In-Session scripts/measure/agent-reads-windows.ps1 115
The app is built fresh; parent and samplers independently fingerprint built artifacts when the shipped tree has no .git.
No gate row is added. A failed bound ends the paired job; its numbers and partial checkpoints remain under ci-out.
#>
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..'))
if ($env:USERNAME -ne 'genie') { Write-Error 'This measurement runs only as genie on a test VM.'; exit 2 }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Error 'Run in the standard-user logged-on session.'; exit 2 }
if (-not (Test-Path -LiteralPath 'ci-measure564-source.txt')) { Write-Error 'Missing queued source provenance.'; exit 2 }
$sourceCommit = (Get-Content -LiteralPath 'ci-measure564-source.txt' -Raw).Trim()
if ($sourceCommit -notmatch '^[a-fA-F0-9]{40}$') { Write-Error 'Queued source provenance must be the full commit SHA.'; exit 2 }
Write-Output "QUEUED_SOURCE_COMMIT $sourceCommit (provenance; build identity is measured independently)"
Write-Output "MACHINE $env:COMPUTERNAME cores=$([Environment]::ProcessorCount) user=$env:USERNAME session=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { Write-Error 'No logged-on desktop session.'; exit 2 }
$env:CRASH_CDP_ALLOW = '1'
$env:GENIE_TEST_MACHINE = '1'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$npxExe = (Get-Command npx.cmd -ErrorAction Stop).Source
# A separate PowerShell preserves the existing CI setup's exit semantics and stays in this interactive session.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/ci/windows.ps1 -Only build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $npxExe --no-install tsc -p tsconfig.json --noEmit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$runName = 'agent-reads-564-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
$reportDir = Join-Path (Join-Path (Get-Location).Path 'ci-out') $runName
$runLog = Join-Path (Join-Path (Get-Location).Path 'ci-out') ($runName + '.log')
& $nodeExe scripts/agent-reads-paired.mjs "--out-dir=$reportDir" 2>&1 | Tee-Object -FilePath $runLog -ErrorAction Stop
$measurementExit = $LASTEXITCODE
if ($measurementExit -eq 0) {
    $summary = Get-Content -LiteralPath (Join-Path $reportDir 'summary.json') -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($summary.pass -ne $true -or $summary.finished -ne $true) { Write-Error 'Missing completed paired PASS verdict.'; $measurementExit = 1 }
}
if (Test-Path -LiteralPath $reportDir) { Copy-Item -LiteralPath 'ci-measure564-source.txt' -Destination (Join-Path $reportDir 'queued-source-commit.txt') -ErrorAction Stop }
Write-Output "MEASUREMENT_EXIT $measurementExit artifacts=$reportDir log=$runLog"
exit $measurementExit
