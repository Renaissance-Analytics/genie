# OBSERVE ONLY, beside CI's `unit (windows)` suite: every 5 s, which processes spent a second or more of CPU since the last
# sample, and the disk queue. The Windows suite stalls now and then (a beforeEach of ~100 ms taking over 10 s, EBUSY on a
# temp file) and nothing in its log says what the machine was doing; the next failure comes with this beside it. It
# changes no test and no timeout, writes only its own file, and ends itself after $Seconds (the job stops it first).
param([string]$Out = "$env:RUNNER_TEMP\proc-samples.log", [int]$Seconds = 1700)
$prev = @{}
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
    $now = Get-Date
    $rows = @()
    foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
        $cpu = 0.0; try { $cpu = [double]$p.CPU } catch {}
        $key = "$($p.Id)"
        if ($prev.ContainsKey($key)) { $d = $cpu - $prev[$key] } else { $d = $cpu }
        $prev[$key] = $cpu
        if ($d -ge 1.0) { $rows += "$($p.ProcessName)#$($p.Id)=$([math]::Round($d,1))s" }
    }
    $q = '-'
    try { $q = [math]::Round((Get-Counter '\PhysicalDisk(_Total)\Current Disk Queue Length' -ErrorAction Stop).CounterSamples[0].CookedValue, 1) } catch {}
    "$($now.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')) disk_q=$q cpu>=1s: $($rows -join ' ')" | Add-Content -Path $Out
    Start-Sleep -Seconds 5
}
