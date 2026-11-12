# THE MACHINE, EVERY ~2 s, BESIDE THE WHOLE GATE (Tynn #660). windows.ps1 starts it on its own pid; it writes one line
# per sample to -Out and ends when that pid is gone, or after -Seconds, whichever is first. scripts/ci/stall.mjs reads
# the lines to say whether the machine stalled during a row (a row that failed then is INFRA and rerun once).
#
#   MACHINE <epoch-ms> gap=<ms since the last sample> disk_q=<current disk queue> cpu=<% busy> disk_ms=<ms per transfer>
#
# The 62c gates' Windows stalls on Azure D8ads_v5 were the disk queue at 6-9 with the CPU idle for ~24 s: these three
# counters say it. Only _Total instances (proc-sampler.ps1's \Process(*) read failed often: "disk_q=-"). A sample whose
# counters cannot be read keeps its time and gap (`error=counters`): a VM that stopped still shows as a gap. Observe only.
param([Parameter(Mandatory = $true)][string]$Out, [Parameter(Mandatory = $true)][int]$ParentId, [double]$Interval = 2, [int]$Seconds = 14400)
$ErrorActionPreference = 'Continue'
$counters = '\PhysicalDisk(_Total)\Current Disk Queue Length', '\Processor(_Total)\% Processor Time', '\PhysicalDisk(_Total)\Avg. Disk sec/Transfer'
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$last = 0
$end = (Get-Date).AddSeconds($Seconds)
$inv = [System.Globalization.CultureInfo]::InvariantCulture
while ((Get-Date) -lt $end -and (Get-Process -Id $ParentId -ErrorAction SilentlyContinue)) {
    # The counter read itself takes about a second (two raw samples for the rates); the sleep makes up the interval.
    $line = 'error=counters'
    try {
        $s = (Get-Counter -Counter $counters -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop).CounterSamples
        $q = ($s | Where-Object { $_.Path -like '*current disk queue length' }).CookedValue
        $cpu = ($s | Where-Object { $_.Path -like '*% processor time' }).CookedValue
        $ms = ($s | Where-Object { $_.Path -like '*avg. disk sec/transfer' }).CookedValue * 1000
        $line = [string]::Format($inv, 'disk_q={0:0} cpu={1:0.0} disk_ms={2:0.0}', $q, $cpu, $ms)
    } catch { }
    $now = $clock.ElapsedMilliseconds
    $epoch = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Add-Content -Path $Out -Value "MACHINE $epoch gap=$($now - $last) $line" -Encoding ascii
    $last = $now
    $rest = [int]($Interval * 1000 - 1000)
    if ($rest -gt 0) { Start-Sleep -Milliseconds $rest }
}
