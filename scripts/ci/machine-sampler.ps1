# THE MACHINE, EVERY ~2 s, BESIDE THE WHOLE GATE (Tynn #660). windows.ps1 starts it on its own pid; it writes one line
# per sample to -Out and ends when that pid is gone, or after -Seconds, whichever is first. scripts/ci/stall.mjs reads
# the lines to say whether the machine stalled during a row (a row that failed then is INFRA and rerun once).
#
#   MACHINE <epoch-ms> gap=<ms since the last sample> disk_q=<current disk queue> cpu=<% busy> [disk_ms=<ms/transfer>] src=pdh|cim
#
# The 62c gates' Windows stalls on Azure D8ads_v5 were the disk queue at 6-9 with the CPU idle for ~24 s: these counters
# say it. Read from the performance counters (Get-Counter, _Total instances only), or, where those cannot be read (they
# could not over SSH as the standard user genie: every read failed on the first Azure run of the sampler's test), from
# the same counters' raw values through CIM, the CPU worked out between two samples. A sample neither can read keeps its
# time and gap, with the reason (`error=...`): a VM that stopped still shows as a gap. Observe only.
param([Parameter(Mandatory = $true)][string]$Out, [Parameter(Mandatory = $true)][int]$ParentId, [double]$Interval = 2, [int]$Seconds = 14400)
$ErrorActionPreference = 'Continue'
$counters = '\PhysicalDisk(_Total)\Current Disk Queue Length', '\Processor(_Total)\% Processor Time', '\PhysicalDisk(_Total)\Avg. Disk sec/Transfer'
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$clock = [System.Diagnostics.Stopwatch]::StartNew()
# No sample before the first: its gap is not the time since start (the first counter read takes up to ~10 s to set
# up, which read as a 10 s pause on the first quiet-image run, gt-11122013-341d332e).
$last = -1
$end = (Get-Date).AddSeconds($Seconds)
$usePdh = $true
$prevCpu = $null

function Read-Pdh {
    $s = (Get-Counter -Counter $counters -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop).CounterSamples
    $q = ($s | Where-Object { $_.Path -like '*current disk queue length' }).CookedValue
    $cpu = ($s | Where-Object { $_.Path -like '*% processor time' }).CookedValue
    $ms = ($s | Where-Object { $_.Path -like '*avg. disk sec/transfer' }).CookedValue * 1000
    return [string]::Format($inv, 'disk_q={0:0} cpu={1:0.0} disk_ms={2:0.0} src=pdh', $q, $cpu, $ms)
}
# Raw values: the queue is instantaneous; % Processor Time's raw value counts the idle 100-ns ticks, so the CPU is the
# share of the time between two samples that was not idle.
function Read-Cim {
    $disk = Get-CimInstance -ClassName Win32_PerfRawData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -ErrorAction Stop
    $cpuRaw = Get-CimInstance -ClassName Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop
    $now = @{ idle = [double]$cpuRaw.PercentProcessorTime; t = [double]$cpuRaw.Timestamp_Sys100NS }
    $cpu = ''
    if ($script:prevCpu -and $now.t -gt $script:prevCpu.t) {
        $busy = 100 - (($now.idle - $script:prevCpu.idle) / ($now.t - $script:prevCpu.t) * 100)
        $cpu = [string]::Format($inv, ' cpu={0:0.0}', [math]::Max(0, [math]::Min(100, $busy)))
    }
    $script:prevCpu = $now
    return [string]::Format($inv, 'disk_q={0:0}{1} src=cim', [double]$disk.CurrentDiskQueueLength, $cpu)
}

while ((Get-Date) -lt $end -and (Get-Process -Id $ParentId -ErrorAction SilentlyContinue)) {
    $line = ''
    $why = ''
    if ($usePdh) {
        try { $line = Read-Pdh } catch { $why = "pdh: $($_.Exception.Message)"; $usePdh = $false }
    }
    if (-not $line) {
        try { $line = Read-Cim; Start-Sleep -Milliseconds 1000 } catch { $why = "$why; cim: $($_.Exception.Message)" }
    }
    if (-not $line) { $w = ($why -replace '\s+', '_') -replace '=', ':'; $line = 'error=' + $w.Substring(0, [math]::Min(160, $w.Length)) }
    $now = $clock.ElapsedMilliseconds
    $epoch = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $gap = if ($last -lt 0) { [int]($Interval * 1000) } else { $now - $last }
    Add-Content -Path $Out -Value "MACHINE $epoch gap=$gap $line" -Encoding ascii
    $last = $now
    $rest = [int]($Interval * 1000 - 1000)
    if ($rest -gt 0) { Start-Sleep -Milliseconds $rest }
}
