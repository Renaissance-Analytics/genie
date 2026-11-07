# THE SPAWN HOST INSIDE THE REAL APP ON WINDOWS (genie#1397). On genie-test-windows only, never the owner's desktop.
#
#   npm run build; powershell -NoProfile -ExecutionPolicy Bypass -File test/live/spawn-host-electron-windows.ps1
#
# Starts the built app (Electron, as `npx electron .` does in CI), waits for its lifecycle log to say the spawn host is
# ready, prints what it said, and ends every Electron process it started (the spawn host is one: Genie's own executable
# run as Node). Exits 1 when the log never says `spawn host ready`, or says `spawn host could not start`.
$ErrorActionPreference = 'Continue'
$log = Join-Path $HOME '.genie\runtime\lifecycle.log'
$before = if (Test-Path $log) { (Get-Content $log).Count } else { 0 }
$app = Start-Process -FilePath 'npx.cmd' -ArgumentList 'electron', '.' -PassThru -RedirectStandardOutput electron-out.log -RedirectStandardError electron-err.log
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $log) {
        $new = @(Get-Content $log | Select-Object -Skip $before)
        if ($new | Where-Object { $_ -match 'spawn host ready pid=' }) { $ready = $true; break }
        if ($new | Where-Object { $_ -match 'spawn host could not start' }) { break }
    }
}
Start-Sleep -Seconds 5
$new = if (Test-Path $log) { @(Get-Content $log | Select-Object -Skip $before) } else { @() }
"lifecycle lines from this launch:"
$new | Where-Object { $_ -match 'boot pid|spawn host|stall main' } | Select-Object -First 12
$hosts = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -match 'spawn-host' })
"spawn host processes running: $($hosts.Count)"
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
$failed = ($new | Where-Object { $_ -match 'spawn host could not start' })
if ($ready -and -not $failed) { 'SPAWN_HOST_READY_IN_APP'; exit 0 }
'SPAWN_HOST_NOT_READY_IN_APP'
Get-Content electron-err.log -Tail 20 -ErrorAction SilentlyContinue
exit 1
