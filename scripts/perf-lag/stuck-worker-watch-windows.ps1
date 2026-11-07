# stuck-worker-watch-windows.ps1 — WHAT A STUCK TEST WORKER IS WAITING ON. Beside a full suite on genie-test-windows, in the background, writing to a file the job prints at the end:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\perf-lag\stuck-worker-watch-windows.ps1 -Log stuck.log -Minutes 120
#
# Batch HH: one test held its worker's event loop for 65 minutes, past a 30 s limit that could not fire, and nothing said what it was blocked in. A blocked thread cannot say, so this looks from outside, every 30 s:
#   - any process under a node.exe that is older than 60 s and not itself a test's node: what a worker may be blocked waiting for, with its command line;
#   - any node.exe whose CPU time has not moved between looks: a held worker;
#   - how long the reading itself took, since a slow WMI is a suspect too.
# It decides nothing, and ends at -Minutes or when its parent job's VM goes down.
param([Parameter(Mandatory = $true)][string]$Log, [int]$Minutes = 120)
$ErrorActionPreference = 'Continue'
$deadline = (Get-Date).AddMinutes($Minutes)
$cpu = @{}
function Say([string]$line) { Add-Content -Path $Log -Value "$((Get-Date).ToString('HH:mm:ss')) $line" }
Say "watching, up to $Minutes minutes"
while ((Get-Date) -lt $deadline) {
    $read = [Diagnostics.Stopwatch]::StartNew()
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $read.Stop()
    if ($read.ElapsedMilliseconds -gt 5000) { Say "reading the process table took $($read.ElapsedMilliseconds) ms" }
    $byId = @{}
    foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
    foreach ($p in $all) {
        $parent = $byId[[int]$p.ParentProcessId]
        if ($parent -and $parent.Name -eq 'node.exe' -and $p.Name -ne 'node.exe' -and $p.Name -ne 'conhost.exe') {
            $age = ((Get-Date) - $p.CreationDate).TotalSeconds
            if ($age -gt 60) {
                $line = "$($p.Name) $($p.ProcessId) under node $($p.ParentProcessId), $([int]$age) s old: $($p.CommandLine)"
                Say $line.Substring(0, [Math]::Min(300, $line.Length))
            }
        }
    }
    foreach ($p in (Get-Process node -ErrorAction SilentlyContinue)) {
        $used = $p.TotalProcessorTime.TotalSeconds
        if ($cpu.ContainsKey($p.Id)) {
            $was = $cpu[$p.Id]
            if ($used -le $was.used) {
                $was.still += 1
                if ($was.still -ge 4) { Say "node $($p.Id) has used no CPU for $($was.still * 30) s (threads $($p.Threads.Count), handles $($p.HandleCount))" }
            } else { $was.used = $used; $was.still = 0 }
        } else { $cpu[$p.Id] = @{ used = $used; still = 0 } }
    }
    Start-Sleep -Seconds 30
}
