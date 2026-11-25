<#
LOGON START ON WINDOWS, PROVEN (the host split P6-3; Tynn #1036, task #1501). The Windows side of scripts/logon-entry-cdp.mjs.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/vm-logon-windows.ps1 -Mode table

  table        the gate row `logon` (windows.ps1): the packaged app (release\win-unpacked, packaged here with --dir when an
               earlier row did not), the HKCU Run value read back, the setting switched live, the four logon cases.

THE REAL LOGON (a focused job, scripts/azure-jobs/logon-real-windows.ps1: the VM restarts between its stages, run-job.sh's
#REBOOT, and genie logs on again by autologon). In-Session passes no arguments, so the job writes the mode to logon-mode.txt:

  install      release\win-unpacked copied to %LOCALAPPDATA%\Programs\Genie, where a per-user install lives
  arm-off      that Genie run, the setting off, Shut down everything: no Run value (the stale-entry probe writes one)
  arm-on       the setting on with start minimised, Shut down everything: the Run value, --hidden (the no-entry probe
               deletes it)
  after-logon  after the restart's logon, with logon-expect.txt `start` or `none`: Genie came back, genie-host up and no
               window shown, or it stayed down

Break probes for the logon (logon-break.txt): no-entry (with arm-on: the row must fail on "Genie started at logon") and
stale-entry (with arm-off: the row must fail on "Genie stayed down"). Each prints `### logon-<mode>=PASS|FAIL`.
#>
param([string]$Mode = '')
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
if (-not $Mode -and (Test-Path 'logon-mode.txt')) { $Mode = (Get-Content 'logon-mode.txt' -Raw).Trim() }
$break = if (Test-Path 'logon-break.txt') { (Get-Content 'logon-break.txt' -Raw).Trim() } else { '' }
$env:GENIE_TEST_MACHINE = '1'
$installed = Join-Path $env:LOCALAPPDATA 'Programs\Genie\Genie.exe'
$runKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run'
Write-Output "--- logon ($Mode)$(if ($break) { ", break probe $break" })"

function Packaged {
    $exe = 'release\win-unpacked\Genie.exe'
    if (Test-Path $exe) { return (Resolve-Path $exe).Path }
    # Write-Host: what this function writes to the pipeline is its answer, the path, and nothing else.
    Write-Host '--- nothing packaged yet: the app packaged here (--dir)'
    if (-not (Test-Path 'dist\main')) { npm run build *> logon-build.log; if ($LASTEXITCODE) { Get-Content logon-build.log -Tail 30; throw 'the build failed' } }
    npx tsx scripts/fetch-caddy.ts *> logon-caddy.log; if ($LASTEXITCODE) { Get-Content logon-caddy.log -Tail 30; throw 'fetch-caddy failed' }
    npx electron-builder --dir --publish never --config.win.signExecutable=false *> logon-package.log; if ($LASTEXITCODE) { Get-Content logon-package.log -Tail 30; throw 'electron-builder --dir failed' }
    if (-not (Test-Path $exe)) { throw "no $exe after packaging" }
    return (Resolve-Path $exe).Path
}

switch ($Mode) {
    'table' {
        $env:LOGON_APP = Packaged
        node scripts/logon-entry-cdp.mjs table
        exit $LASTEXITCODE
    }
    'install' {
        $from = Split-Path (Packaged)
        $to = Split-Path $installed
        if (Test-Path $to) { Remove-Item -Recurse -Force $to }
        New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
        Copy-Item -Recurse $from $to
        if (-not (Test-Path $installed)) { Write-Output "### logon-install=FAIL no $installed"; exit 1 }
        Write-Output "### logon-install=PASS $installed"
        exit 0
    }
    { $_ -in 'arm-off', 'arm-on' } {
        $env:LOGON_APP = $installed
        $on = $Mode -eq 'arm-on'
        node scripts/logon-entry-cdp.mjs arm $(if ($on) { 'on' } else { 'off' })
        $code = $LASTEXITCODE
        # The values that name this Genie, by their data (Electron names the value; the data is the exe and its arguments).
        $runItem = Get-Item 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run'
        $ours = @($runItem.GetValueNames() | Where-Object { "$($runItem.GetValue($_))" -like "*$installed*" })
        switch ($(if ($on) { $break } else { "off:$break" })) {
            'no-entry' { foreach ($v in $ours) { Write-Output "BREAK PROBE no-entry: the Run value '$v' Genie wrote is deleted before the logon"; reg delete $runKey /v $v /f } }
            'off:stale-entry' { Write-Output 'BREAK PROBE stale-entry: a Run value for Genie is written by hand with the setting off'; reg add $runKey /v 'GenieLogonProbe' /t REG_SZ /d "`"$installed`" --hidden" /f }
        }
        Write-Output '--- the Run key now:'
        reg query $runKey
        exit $code
    }
    'after-logon' {
        $env:LOGON_APP = $installed
        $expect = if (Test-Path 'logon-expect.txt') { (Get-Content 'logon-expect.txt' -Raw).Trim() } else { '' }
        Write-Output "--- the Run key at logon:"
        reg query $runKey
        node scripts/logon-entry-cdp.mjs after-logon $expect
        $code = $LASTEXITCODE
        # Whatever came up goes, so the next stage meets the machine as it left it.
        Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path.StartsWith((Split-Path $installed), [System.StringComparison]::OrdinalIgnoreCase) -or $_.Path.StartsWith((Join-Path $env:USERPROFILE '.genie\host'), [System.StringComparison]::OrdinalIgnoreCase)) } | Stop-Process -Force -ErrorAction SilentlyContinue
        reg delete $runKey /v 'GenieLogonProbe' /f 2>$null | Out-Null
        exit $code
    }
    default { Write-Output "### logon=CANNOT-RUN no mode ('$Mode'): table, install, arm-off, arm-on or after-logon"; exit 2 }
}
