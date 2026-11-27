<#
vm-logon-launcher-windows.ps1 - LOGON IS THE LAUNCHER'S, ON WINDOWS (Tynn #1058 L5; the rows `logon` and `logon-launcher`).
In a test VM only, in genie's logged-on session (In-Session). The launcher writes the HKCU Run value `Genie` running itself
with --logon, and its run decides with the logon table (native/launcher/src/logon.rs = src/core/logon.ts logonEntry,
test/fixtures/logon-table.json):

  left running + setting on/off -> the host starts, no window      shut down + setting on  -> the host and a window
  shut down + setting off       -> Genie stays down until it is opened

  -Mode table        the gate row `logon`: the package-tracks row's launcher and signed packages in a code root and a data
                     root of their own; for each row of the table the Run value read back (written, running the launcher
                     with --logon, or absent) and `Genie.exe --logon` run as the entry runs it: what started, what did not.
  -Mode install      `logon-launcher` (scripts/azure-jobs/logon-launcher-windows.ps1, the VM restarted between stages): the
                     launcher at %LOCALAPPDATA%\Programs\Genie\Genie.exe (the NSIS folder) installing into the default roots
  -Mode arm-off      the setting off, Genie running, then Shut down everything
  -Mode arm-on       the setting on (start minimised off), Genie running, then Shut down everything
  -Mode arm-left     the setting off, Genie running, then Just close the UI (the host left running)
  -Mode after-logon -Expect none|window|hidden   what the logon started, read and photographed

Prints `### logon-launcher-<mode>=PASS|FAIL <why>`. The mode is the argument, or logon-mode.txt / logon-expect.txt (a stage
of the reboot job writes them, as logon-real-windows.ps1 does).
#>
param([string]$Mode = '', [string]$Expect = '')
$ErrorActionPreference = 'Continue'
if (-not $Mode -and (Test-Path 'logon-mode.txt')) { $Mode = (Get-Content -Raw 'logon-mode.txt').Trim() }
if (-not $Expect -and (Test-Path 'logon-expect.txt')) { $Expect = (Get-Content -Raw 'logon-expect.txt').Trim() }
if (-not $Mode) { $Mode = 'table' }
$Repo = (Get-Location).Path
$Out = Join-Path $Repo "ci-out\logon-launcher-$Mode"
New-Item -ItemType Directory -Force $Out | Out-Null
$Pkg = Join-Path $Repo 'release\tracks\packages'
$Built = Join-Path $Repo 'release\tracks\trees\launcher\Genie.exe'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:Failed = @()
function Fail([string]$why) { Write-Output "### logon-launcher-$Mode=FAIL $why"; exit 1 }
function Miss([string]$what) { $script:Failed += $what; Write-Output "  MISS $what" }
function Shot([string]$name) { powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'scripts\ci\screenshot.ps1') -Out (Join-Path $Out $name) }
function Run-Value { try { (Get-ItemProperty -Path $RunKey -Name 'Genie' -ErrorAction Stop).Genie } catch { $null } }
function Live-Pid([string]$file) {
    if (-not (Test-Path $file)) { return $null }
    try { $p = (Get-Content -Raw $file | ConvertFrom-Json).pid } catch { return $null }
    if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) { return $p }
    return $null
}
function Clients([string]$code) { @(Get-Process genie-client -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($code) }) }

if ($Mode -eq 'table') {
    if (-not (Test-Path $Built) -or -not (Test-Path $Pkg)) { Fail 'no launcher or packages: see the package-tracks row' }
    $Code = Join-Path $env:LOCALAPPDATA 'GenieLogonRowCode'
    $Data = Join-Path $env:LOCALAPPDATA 'GenieLogonRowHome'
    foreach ($d in @($Code, $Data)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
    $env:GENIE_CODE_ROOT = $Code; $env:GENIE_HOME = $Data
    $o = (& $Built install --profile both --from $Pkg --yes 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { Write-Output $o; Fail 'the launcher did not install the packages' }
    $Runtime = Join-Path $Data 'runtime'
    function Stop-All {
        if (Live-Pid (Join-Path $Runtime 'launcher.json')) { & $Built shut-down 2>&1 | Out-Null }
        & $Built stop-host 2>&1 | Out-Null
        Clients $Code | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    function Case-Row([string]$name, [string]$setting, [bool]$left, [bool]$wantEntry, [bool]$wantHost, [bool]$wantWindow) {
        Write-Output ""; Write-Output "=== ${name}: setting $setting, left running $left -> entry $wantEntry, host $wantHost, window $wantWindow ==="
        Stop-All
        New-Item -ItemType Directory -Force $Runtime | Out-Null
        $mark = Join-Path $Runtime 'left-running'
        if ($left) { Set-Content $mark '' } else { Remove-Item $mark -ErrorAction SilentlyContinue }
        & $Built logon-settings $setting off 2>&1 | Out-Host
        $v = Run-Value
        Write-Output "  the Run value: $v"
        if ($wantEntry) {
            if ($v -ne "`"$Built`" --logon") { Miss "${name}: the Run value is '$v', not the launcher with --logon" }
        } elseif ($v) { Miss "${name}: a Run value with nothing to start" }
        $p = Start-Process -FilePath $Built -ArgumentList '--logon' -PassThru -RedirectStandardError (Join-Path $Out "logon-$name.log")
        Start-Sleep -Seconds 20
        $hp = Live-Pid (Join-Path $Runtime 'host.json'); $cs = @(Clients $Code)
        Write-Output "  after --logon: launcher $(if ($p.HasExited) { "exited $($p.ExitCode)" } else { $p.Id }), host $hp, clients $($cs.Count)"
        if ($wantHost -and -not $hp) { Miss "${name}: no host" }
        if (-not $wantHost -and $hp) { Miss "${name}: a host started" }
        if (-not $wantHost -and -not $p.HasExited) { Miss "${name}: the launcher stayed up with nothing to start" }
        if ($wantWindow -and $cs.Count -eq 0) { Miss "${name}: no window" }
        if (-not $wantWindow -and $cs.Count -gt 0) { Miss "${name}: a window opened" }
    }
    Case-Row 'left-on' 'on' $true $true $true $false
    Case-Row 'left-off' 'off' $true $true $true $false
    Case-Row 'down-on' 'on' $false $true $true $true
    Case-Row 'down-off' 'off' $false $false $false $false
    Stop-All
    & $Built logon-settings off off 2>&1 | Out-Null
    Remove-ItemProperty -Path $RunKey -Name 'Genie' -ErrorAction SilentlyContinue
    if ($script:Failed.Count) { Write-Output "### logon-launcher-table=FAIL $($script:Failed -join '; ')"; exit 1 }
    Write-Output '### logon-launcher-table=PASS the launcher wrote (or removed) its Run value and its --logon run followed the logon table''s four rows'
    exit 0
}

# --- the reboot job's stages: the default roots, the launcher where NSIS puts it ----------------------------------------
$Prog = Join-Path $env:LOCALAPPDATA 'Programs\Genie'
$Genie = Join-Path $Prog 'Genie.exe'
$Code = Join-Path $env:LOCALAPPDATA 'Genie'
$Runtime = Join-Path $env:USERPROFILE '.genie\runtime'
function Running-Genie {
    Start-Process -FilePath $Genie -ArgumentList 'serve' -RedirectStandardError (Join-Path $Out 'serve.log') | Out-Null
    for ($i = 0; $i -lt 30 -and -not (Live-Pid (Join-Path $Runtime 'launcher.json')); $i++) { Start-Sleep -Seconds 1 }
    & $Genie ensure-host 2>&1 | Out-Host
    if (-not (Live-Pid (Join-Path $Runtime 'host.json'))) { Fail 'the host did not start' }
}
switch ($Mode) {
    'install' {
        New-Item -ItemType Directory -Force $Prog | Out-Null
        Copy-Item $Built $Genie -Force
        & $Genie install --profile both --from $Pkg --yes 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { Fail 'the launcher did not install the packages' }
        Write-Output "### logon-launcher-install=PASS $Genie installed into $Code"
    }
    'arm-off' {
        & $Genie logon-settings off off 2>&1 | Out-Host
        Running-Genie
        & $Genie shut-down 2>&1 | Out-Host
        $v = Run-Value
        if ($v) { Fail "the setting off after Shut down everything left a Run value: $v" }
        Write-Output '### logon-launcher-arm-off=PASS the setting off, everything shut down, no Run value'
    }
    'arm-on' {
        & $Genie logon-settings on off 2>&1 | Out-Host
        Running-Genie
        & $Genie shut-down 2>&1 | Out-Host
        $v = Run-Value
        if ($v -ne "`"$Genie`" --logon") { Fail "the setting on: the Run value is '$v'" }
        Write-Output "### logon-launcher-arm-on=PASS the setting on, everything shut down, the Run value $v"
    }
    'arm-left' {
        & $Genie logon-settings off off 2>&1 | Out-Host
        Running-Genie
        & $Genie close-ui 2>&1 | Out-Host
        if (-not (Test-Path (Join-Path $Runtime 'left-running'))) { Fail 'Just close the UI did not mark the host left running' }
        $v = Run-Value
        if ($v -ne "`"$Genie`" --logon") { Fail "left running: the Run value is '$v'" }
        Write-Output "### logon-launcher-arm-left=PASS the host left running, the Run value $v"
    }
    'after-logon' {
        Start-Sleep -Seconds 45
        $lp = Live-Pid (Join-Path $Runtime 'launcher.json'); $hp = Live-Pid (Join-Path $Runtime 'host.json'); $cs = @(Clients $Code)
        Write-Output "after the logon: launcher $lp, host $hp, clients $($cs.Count) (expect $Expect)"
        Shot "after-logon-$Expect-windows.png"
        switch ($Expect) {
            'none' { if ($lp -or $hp -or $cs.Count) { Fail "Genie started at logon with the setting off after Shut down everything" } }
            'window' { if (-not $lp -or -not $hp -or $cs.Count -eq 0) { Fail "the setting on: launcher $lp, host $hp, clients $($cs.Count)" } }
            'hidden' { if (-not $lp -or -not $hp -or $cs.Count -gt 0) { Fail "left running: launcher $lp, host $hp, clients $($cs.Count)" } }
            default { Fail "-Expect none|window|hidden" }
        }
        # What started goes, so the next stage begins from nothing.
        if ($lp) { & $Genie shut-down 2>&1 | Out-Host } else { & $Genie stop-host 2>&1 | Out-Null }
        Clients $Code | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Output "### logon-launcher-after-logon=PASS ($Expect)"
    }
    default { Write-Output "### logon-launcher=CANNOT-RUN mode '$Mode'"; exit 2 }
}
exit 0
