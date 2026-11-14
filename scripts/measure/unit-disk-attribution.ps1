<# Tynn #671: run AFTER normal unit prerequisites, on D16 in the logged-on test session:
   In-Session scripts/measure/unit-disk-attribution.ps1 40
No SSH environment is needed. Reuses the gauge and external OS counters, with no full-suite rerun.
The do-nothing file waits 2 s only so the 500 ms observer can see its worker; ordinary Vitest/ACL setup still runs.
Its unique test file exists only during this job and is removed in finally. No existing test or fixture is edited.
#>
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or ($env:USERNAME -ne 'genie' -and $env:GENIE_TEST_MACHINE -ne '1')) { throw 'Windows test VM only.' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo
$baseline = 'test/measure671-baseline-' + [Guid]::NewGuid().ToString('N') + '.test.ts'
$baselinePath = Join-Path $repo $baseline
if (Test-Path -LiteralPath $baselinePath) { throw 'Refusing to overwrite an existing baseline file.' }
$nodeBytes = (Get-Item -LiteralPath (Get-Command node).Source).Length
Write-Output "MEASURE671 ATTRIBUTION nodeBinaryBytes=$nodeBytes programLookupCopies=84 predictedCopyBytes=$($nodeBytes * 84)"
try {
    @'
import { it } from 'vitest';
it('do-nothing worker IO baseline (2 s idle for observer visibility)', async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
});
'@ | Set-Content -LiteralPath $baselinePath -Encoding UTF8
    # These settings must be inside this logged-on wrapper: In-Session carries no SSH-side environment.
    $env:GENIE_MEASURE671_PHASE = 'before'
    $env:GENIE_MEASURE671_OUT = ''
    $env:GENIE_MEASURE671_SKIP_FULL = '1'
    $env:GENIE_MEASURE671_CANDIDATES = (@(
        $baseline, 'test/program-lookup.test.ts', 'test/attention-bounded.test.ts',
        'test/tailscale-install-signature.test.ts', 'test/windows-signing.test.ts',
        'test/p4-files-content.test.ts', 'test/p4-artboard.test.ts', 'test/gapps-v7-store.test.tsx',
        'test/file-export.test.ts', 'test/folder-export.test.ts'
    ) -join ';')
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'unit-disk-windows.ps1')
    $jobExit = $LASTEXITCODE
} finally {
    # Only the exact unique file created above; never a recursive delete or a wildcard cleanup.
    if (Test-Path -LiteralPath $baselinePath) { Remove-Item -LiteralPath $baselinePath -Force }
}
exit $jobExit
