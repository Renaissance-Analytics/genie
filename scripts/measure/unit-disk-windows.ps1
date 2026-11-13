<#
Tynn #671, opt-in BEFORE/AFTER job, Windows PowerShell 5.1. TEST VM ONLY.
Prepare the normal unit prerequisites first: scripts/ci/windows.ps1 -Only deps,electron-binary,unit-build
Then run this script with GENIE_TEST_MACHINE=1. Optional environment:
  GENIE_MEASURE671_PHASE=before|after  (default before)
  GENIE_MEASURE671_OUT=<new artifact directory> (default ci-out/measure671-<phase>-<timestamp>)
  GENIE_MEASURE671_CANDIDATES=<semicolon-separated test paths> (default candidates below)
  GENIE_MEASURE671_SKIP_FULL=1 (candidate probe only; NOT the complete BEFORE/AFTER job)

Each candidate runs ALONE, with the normal 30 s Windows budgets, then the unchanged full unit suite runs ONCE at
normal concurrency. Nothing patches fs, disables sync, edits test fixtures, or changes the test runner configuration.
The existing machine/proc samplers run beside the full suite. slow-tests.mjs supplies the existing outside-test
time estimate (setup + hooks + import), NOT an exact isolated hook duration. Verbose and JSON reports are kept.

GetProcessIoCounters supplies lifetime WriteTransferCount for newly born Vitest processes; first observed and final
counts are both retained. Holding query-only handles lets us attempt the final read even after process exit. This
is OS process IO (including pipes/network), NOT physical disk bytes or JS payload bytes. Worker totals exclude the
CLI and other Node/Electron descendants, which are reported separately. Non-Node children are not tracked. A 500 ms process discovery poll can miss short-lived
children; failed final reads keep a labeled lower bound. No observations means UNMEASURED, never zero evidence.
IO samples are buffered in this observer and written AFTER the run, reducing the measurement's own disk traffic.
https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getprocessiocounters
https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-io_counters
#>
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($env:GENIE_TEST_MACHINE -ne '1' -and $env:USERNAME -ne 'genie') { throw 'Test VM only; do not run on the owner desktop.' }
if ($env:OS -ne 'Windows_NT') { throw 'This job measures Windows process IO.' }
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..'))
$repo = (Get-Location).Path
$phase = if ($env:GENIE_MEASURE671_PHASE) { $env:GENIE_MEASURE671_PHASE } else { 'before' }
if ($phase -notin @('before', 'after')) { throw 'GENIE_MEASURE671_PHASE must be before or after.' }
$out = if ($env:GENIE_MEASURE671_OUT) { $env:GENIE_MEASURE671_OUT } else { Join-Path $repo ("ci-out\measure671-$phase-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
if (Test-Path -LiteralPath $out) { throw 'Use a new output directory: prior measurements are never overwritten.' }
$null = New-Item -ItemType Directory -Path $out
$out = (Resolve-Path -LiteralPath $out).Path
$node = (Get-Command node -ErrorAction Stop).Source
$vitest = Join-Path $repo 'node_modules\vitest\vitest.mjs'
if (-not (Test-Path -LiteralPath $vitest)) { throw 'Install the normal unit prerequisites first.' }
$candidates = @(
    'test/prism-harness-0103.test.ts', 'test/thread-rotation.test.ts', 'test/bounded-ledgers.test.ts',
    'test/ledger-1gb-probe.test.ts', 'test/inbox-store.test.ts', 'test/thread-history-bounded.test.ts',
    'test/thread-rotation-sidecars.test.ts', 'test/thread-writes-batched.test.ts',
    'test/session-engine.test.ts', 'test/inbox-flyout-actions.test.ts'
)
if ($env:GENIE_MEASURE671_CANDIDATES) { $candidates = @($env:GENIE_MEASURE671_CANDIDATES.Split(';') | ForEach-Object { $_.Trim() }) }
foreach ($candidate in $candidates) {
    if ($candidate -notmatch '^test/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\.test\.tsx?$' -or -not (Test-Path -LiteralPath $candidate)) { throw "Invalid candidate test path: $candidate" }
}

# Query-only Windows API, in the OBSERVER process; no code injected into Vitest or its children.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Genie671 {
    [StructLayout(LayoutKind.Sequential)]
    public struct Io {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    public static class ProcessIo {
        [DllImport("kernel32.dll", SetLastError=true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetProcessIoCounters(IntPtr handle, out Io counters);
        [DllImport("kernel32.dll", SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr handle);
    }
}
'@
function Quote-Argument([string]$value) {
    if ($value.Contains('"')) { throw 'Quotes are not allowed in job paths.' }
    return '"' + $value + '"'
}
function Observe-Process($rows, [int]$processId, [string]$kind) {
    $handle = [Genie671.ProcessIo]::OpenProcess(0x1000, $false, $processId)
    $io = New-Object Genie671.Io
    $ok = $handle -ne [IntPtr]::Zero -and [Genie671.ProcessIo]::GetProcessIoCounters($handle, [ref]$io)
    $rows[$processId] = [pscustomobject]@{
        id = $processId; kind = $kind; handle = $handle; first = [double]$io.WriteBytes; last = [double]$io.WriteBytes
        readable = $ok; final = $false; done = $false; error = $(if ($ok) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() })
    }
}
function Read-ProcessIo($row) {
    if ($row.done -or $row.handle -eq [IntPtr]::Zero) { return }
    $io = New-Object Genie671.Io
    if ([Genie671.ProcessIo]::GetProcessIoCounters($row.handle, [ref]$io)) { $row.last = [double]$io.WriteBytes; $row.readable = $true }
    else { $row.error = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
    [uint32]$processExit = 259
    if ([Genie671.ProcessIo]::GetExitCodeProcess($row.handle, [ref]$processExit) -and $processExit -ne 259) {
        $row.final = [Genie671.ProcessIo]::GetProcessIoCounters($row.handle, [ref]$io)
        if ($row.final) { $row.last = [double]$io.WriteBytes }
        $row.done = $true
    }
}
function Measure-Run([string]$label, [string]$candidate, [int]$index) {
    $stem = Join-Path $out ('{0:d2}-{1}' -f $index, $label)
    $json = "$stem.json"
    $arguments = @((Quote-Argument $vitest), 'run')
    if ($candidate) { $arguments += (Quote-Argument $candidate) }
    $arguments += '--testTimeout=30000', '--hookTimeout=30000', '--reporter=verbose', '--reporter=json', (Quote-Argument "--outputFile.json=$json")
    $rows = @{}
    $samples = New-Object 'System.Collections.Generic.List[object]'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $bornAfter = (Get-Date).AddSeconds(-1)
    $startEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $run = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput "$stem.stdout.log" -RedirectStandardError "$stem.stderr.log"
    Observe-Process $rows $run.Id 'cli'
    $lastMs = 0.0; $lastBytes = 0.0; $peak = 0.0; $discoveryErrors = 0
    try {
        do {
            # Only Node/Electron descendants of THIS run; never include another agent's Node processes. Keep ancestor IDs
            # for children already discovered even if their parent has exited between samples.
            try {
                $live = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='electron.exe'" -Property ProcessId,ParentProcessId,CommandLine,CreationDate)
                do {
                    $added = $false
                    foreach ($p in $live) {
                        $processId = [int]$p.ProcessId
                        if (-not $rows.ContainsKey($processId) -and $rows.ContainsKey([int]$p.ParentProcessId) -and $p.CreationDate -ge $bornAfter) {
                            $kind = if ($p.CommandLine -match '[/\\]vitest[/\\]dist[/\\]workers[/\\](?:vmF|f)orks\.js') { 'worker' } else { 'other-child' }
                            Observe-Process $rows $processId $kind
                            $added = $true
                        }
                    }
                } while ($added)
            } catch { $discoveryErrors += 1 }
            foreach ($row in @($rows.Values)) { Read-ProcessIo $row }
            $nowMs = $watch.Elapsed.TotalMilliseconds
            $workerBytes = [double](($rows.Values | Where-Object { $_.kind -eq 'worker' } | Measure-Object -Property last -Sum).Sum)
            $gapMs = $nowMs - $lastMs
            $rate = if ($gapMs -gt 0) { ($workerBytes - $lastBytes) * 1000 / $gapMs } else { 0 }
            $peak = [math]::Max($peak, $rate)
            $samples.Add([pscustomobject]@{ epochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); gapMs = [math]::Round($gapMs); workerWriteBytes = $workerBytes; workerWriteBytesPerSecond = [math]::Round($rate) })
            $lastMs = $nowMs; $lastBytes = $workerBytes
            $run.Refresh()
            if (-not $run.HasExited) { Start-Sleep -Milliseconds 500 }
        } while (-not $run.HasExited)
        $run.WaitForExit()
        # The CLI can exit during the final discovery poll; take the AFTER counters explicitly, too.
        foreach ($row in @($rows.Values)) { Read-ProcessIo $row }
        $watch.Stop()
        $workers = @($rows.Values | Where-Object { $_.kind -eq 'worker' })
        $unreadable = @($rows.Values | Where-Object { -not $_.readable }).Count
        $unreadableWorkers = @($workers | Where-Object { -not $_.readable }).Count
        $notFinal = @($rows.Values | Where-Object { -not $_.final }).Count
        $summary = [pscustomobject]@{
            phase = $phase; label = $label; exitCode = $run.ExitCode; seconds = [math]::Round($watch.Elapsed.TotalSeconds, 2)
            startEpochMs = $startEpoch; endEpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            workersObserved = $workers.Count; workerWriteBytes = $(if ($workers.Count) { ($workers | Measure-Object -Property last -Sum).Sum } else { $null })
            cliWriteBytes = $rows[$run.Id].last; otherChildWriteBytes = ($rows.Values | Where-Object { $_.kind -eq 'other-child' } | Measure-Object -Property last -Sum).Sum
            peakWorkerWriteBytesPerSecond = [math]::Round($peak); unreadableProcesses = $unreadable; unreadableWorkers = $unreadableWorkers; missingFinalReads = $notFinal; discoveryErrors = $discoveryErrors
            coverage = 'OS transfer bytes including IPC; Node/Electron ancestry only; short-lived children may be missed; missing final reads are lower bounds; rates sampled at discovery, not exact disk bursts'
        }
        $samples | Export-Csv -NoTypeInformation -Encoding UTF8 -Path "$stem.io.csv"
        $rows.Values | Select-Object id,kind,first,last,readable,final,done,error | Export-Csv -NoTypeInformation -Encoding UTF8 -Path "$stem.processes.csv"
        $summary | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath "$stem.summary.json"
        Write-Host ('MEASURE671 ' + ($summary | ConvertTo-Json -Compress))
        & $node scripts/ci/slow-tests.mjs $json "$stem.slow-tests.tsv" | Tee-Object -FilePath "$stem.slow-tests.log" | Write-Host
        return $summary
    } finally {
        foreach ($row in $rows.Values) { if ($row.handle -ne [IntPtr]::Zero) { $null = [Genie671.ProcessIo]::CloseHandle($row.handle) } }
    }
}

$head = & git rev-parse HEAD
$version = & $node --version
@("HEAD=$head", "NODE=$version", "PHASE=$phase", 'POLL_MS=500; original concurrency and sync unchanged', 'HOOK_TIMING=outside-test estimate from existing slow-tests.mjs, includes imports', 'BYTES=OS process transfer counts, not physical disk bytes') | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $out 'metadata.txt')
$summaries = New-Object 'System.Collections.Generic.List[object]'
$index = 0
foreach ($candidate in $candidates) {
    $index += 1
    $label = [IO.Path]::GetFileNameWithoutExtension($candidate)
    $summaries.Add((Measure-Run $label $candidate $index))
}
if ($env:GENIE_MEASURE671_SKIP_FULL -ne '1') {
    $machine = $null; $processes = $null
    try {
        $machine = Start-Process powershell.exe -ArgumentList '-NoProfile', '-File', (Quote-Argument (Join-Path $repo 'scripts/ci/machine-sampler.ps1')), '-Out', (Quote-Argument (Join-Path $out 'machine-samples.log')), '-ParentId', $PID -PassThru -WindowStyle Hidden
        $processes = Start-Process powershell.exe -ArgumentList '-NoProfile', '-File', (Quote-Argument (Join-Path $repo 'scripts/ci/proc-sampler.ps1')), '-Out', (Quote-Argument (Join-Path $out 'proc-samples.log')), '-Seconds', '7200' -PassThru -WindowStyle Hidden
        $full = Measure-Run 'full-suite' '' ($index + 1)
        $summaries.Add($full)
        & $node scripts/ci/stall.mjs (Join-Path $out 'machine-samples.log') $full.startEpochMs $full.endEpochMs | Tee-Object -FilePath (Join-Path $out 'stalls.log') | Write-Host
    } finally {
        foreach ($sampler in @($machine, $processes)) { if ($sampler -and -not $sampler.HasExited) { $sampler.Kill() } }
    }
}
$summaries | Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $out 'runs.csv')
Write-Output 'MEASURE671 TOP WORKERS (OS transfer bytes, candidate files alone):'
$summaries | Where-Object { $_.label -ne 'full-suite' } | Sort-Object workerWriteBytes -Descending | Format-Table label,workerWriteBytes,seconds,exitCode,workersObserved,missingFinalReads,discoveryErrors -AutoSize
$failed = @($summaries | Where-Object { $_.exitCode -ne 0 }).Count
$unmeasured = @($summaries | Where-Object { $_.workersObserved -eq 0 -or $_.unreadableWorkers -gt 0 -or $_.discoveryErrors -gt 0 }).Count
Write-Output "MEASURE671 END phase=$phase runs=$($summaries.Count) failed=$failed unmeasured=$unmeasured artifacts=$out"
if ($failed -gt 0 -or $unmeasured -gt 0) { exit 1 }
exit 0
