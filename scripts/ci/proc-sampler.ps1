# OBSERVE ONLY, beside CI's `unit (windows)` suite: every 5 s, which processes spent a second or more of CPU since the last
# sample, and the disk queue. The Windows suite stalls now and then (a beforeEach of ~100 ms taking over 10 s, EBUSY on a
# temp file) and nothing in its log says what the machine was doing; the next failure comes with this beside it. It
# changes no test and no timeout, writes only its own file, and ends itself after $Seconds (the job stops it first).
#
# A hot svchost is named by the services it hosts (#1636's run: svchost#1468 hot for ~90 s beside a knowledge.db EBUSY),
# read once per pid; and the processes moving the most bytes are listed beside the disk queue, so a scanner or an indexer
# reading the suite's temp files shows by name. Per-file disk activity would need ETW; per-process bytes are what is cheap.
param([string]$Out = "$env:RUNNER_TEMP\proc-samples.log", [int]$Seconds = 1700)
$prev = @{}
$services = @{}
$end = (Get-Date).AddSeconds($Seconds)
function ServicesOf([int]$procId) {
    if (-not $services.ContainsKey($procId)) {
        $names = @()
        try { $names = @(Get-CimInstance Win32_Service -Filter "ProcessId=$procId" -ErrorAction Stop | ForEach-Object { $_.Name }) } catch {}
        $services[$procId] = ($names -join ',')
    }
    return $services[$procId]
}
while ((Get-Date) -lt $end) {
    $now = Get-Date
    $rows = @()
    foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
        $cpu = 0.0; try { $cpu = [double]$p.CPU } catch {}
        $key = "$($p.Id)"
        if ($prev.ContainsKey($key)) { $d = $cpu - $prev[$key] } else { $d = $cpu }
        $prev[$key] = $cpu
        if ($d -ge 1.0) {
            $svc = ''
            if ($p.ProcessName -eq 'svchost') { $s = ServicesOf $p.Id; if ($s) { $svc = "[$s]" } }
            $rows += "$($p.ProcessName)#$($p.Id)$svc=$([math]::Round($d,1))s"
        }
    }
    $q = '-'
    $io = ''
    try {
        $counters = Get-Counter '\PhysicalDisk(_Total)\Current Disk Queue Length', '\Process(*)\IO Data Bytes/sec' -ErrorAction Stop
        $q = [math]::Round(($counters.CounterSamples | Where-Object { $_.Path -like '*physicaldisk*' } | Select-Object -First 1).CookedValue, 1)
        $top = $counters.CounterSamples | Where-Object { $_.Path -like '*\process(*' -and $_.InstanceName -notin @('_total', 'idle') -and $_.CookedValue -ge 1MB } | Sort-Object CookedValue -Descending | Select-Object -First 3
        $io = ($top | ForEach-Object { "$($_.InstanceName)=$([math]::Round($_.CookedValue / 1MB, 1))MB/s" }) -join ' '
    } catch {}
    "$($now.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')) disk_q=$q cpu>=1s: $($rows -join ' ') io: $io" | Add-Content -Path $Out
    Start-Sleep -Seconds 5
}
