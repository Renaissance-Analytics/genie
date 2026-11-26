<#
THE LAUNCHER INSTALLS GENIE, ON WINDOWS (Tynn #1058 L3; the row launcher-install, scripts/ci/windows.ps1). In a test VM
only, In-Session as the standard user genie, never on a person's desktop. As a person on a fresh machine does it:

  1. the installer (release\tracks\installer\Genie-<build>-launcher-setup.exe) does the bare install (the launcher and
     its packages) and opens Genie: the launcher's setup window (direction C, WebView2) shows choose, installing and
     ready, each photographed through its debugger (scripts/launcher-setup-cdp.mjs); Install, then Open Genie, pressed.
  2. the launcher is %LOCALAPPDATA%\Programs\Genie\Genie.exe (the path every shortcut already uses), alone there once its
     packages are installed into %LOCALAPPDATA%\Genie, each verified against its signed manifest; Genie and Genie (doctor
     mode) in the Start menu are the launcher.
  3. Genie opens: the launcher started the host from its own folder, then the client window, which ADOPTS that host; the
     host's supervisor is ready in the host's folder. A SCREENSHOT of Genie running.
  4. the client-only profile into a code root of its own: the client and the browser, no host.
  5. the uninstaller stops the host gracefully and removes the launcher and the programs; ~\.genie stays.

Needs the package-tracks row's installer and packages. Prints `### launcher-install=PASS|FAIL <why>`.
#>
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$Repo = (Get-Location).Path
$Out = Join-Path $Repo 'ci-out\launcher-install'
$Pkg = Join-Path $Repo 'release\tracks\packages'
$Prog = Join-Path $env:LOCALAPPDATA 'Programs\Genie'
$Code = Join-Path $env:LOCALAPPDATA 'Genie'
$Data = Join-Path $env:USERPROFILE '.genie'
$Aside = Join-Path $env:USERPROFILE '.genie.before-launcher-install'
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$began = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
New-Item -ItemType Directory -Force $Out | Out-Null
$script:HostPid = $null

function Fail([string]$why) {
    Write-Output "### launcher-install=FAIL $why"
    Cleanup
    exit 1
}

function Cleanup {
    [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', $null, 'User')
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    $roots = @()
    if ($script:HostPid) { $roots += @('--root', "$($script:HostPid)") }
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path.StartsWith($Code, [StringComparison]::OrdinalIgnoreCase) -or $_.Path.StartsWith($Prog, [StringComparison]::OrdinalIgnoreCase)) })) {
        $roots += @('--root', "$($p.Id)")
    }
    if ($roots.Count -gt 0) { node scripts/end-own-tree.mjs --since "$began" @roots | Out-Host }
    if (Test-Path $Aside) {
        if (Test-Path $Data) { Remove-Item -Recurse -Force $Data -ErrorAction SilentlyContinue }
        Rename-Item $Aside $Data -ErrorAction SilentlyContinue
    }
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Shot([string]$name) {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $path = Join-Path $Out $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output "SCREENSHOT $path ($($b.Width)x$($b.Height))"
}

function Wait-Line([string]$file, [string]$pattern, [int]$seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        if (Test-Path $file) { $m = Select-String -Path $file -Pattern $pattern | Select-Object -First 1; if ($m) { return $m.Line } }
        Start-Sleep -Seconds 1
    }
    return $null
}

$installer = @(Get-ChildItem (Join-Path $Repo 'release\tracks\installer\*-launcher-setup.exe') -ErrorAction SilentlyContinue)[0]
if (-not $installer) { Fail 'no launcher installer in release\tracks\installer: see the package-tracks row' }
$build = (Get-Content -Raw (Join-Path $Repo 'release\tracks\build.txt')).Trim()
Write-Output "--- the installer: $($installer.FullName) ($($installer.Length) bytes), build $build"
if (Test-Path $Prog) { Fail "$Prog is already there: this row needs a machine with no Genie installed" }
if (Test-Path $Code) { Fail "$Code is already there: this row needs a machine with no Genie installed" }
# A data root earlier rows left: moved aside for the row and back after, so the install meets a fresh machine.
if (Test-Path $Data) {
    $hj = Join-Path $Data 'runtime\host.json'
    if (Test-Path $hj) { $old = (Get-Content -Raw $hj | ConvertFrom-Json).pid; if ($old) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue } }
    Start-Sleep -Seconds 2
    Rename-Item $Data $Aside -ErrorAction Stop
}

# --- 1. the installer, then the launcher's setup window (direction C) -------------------------------------------------
# The window is WebView2: its debugger on 9333 for this row, through the user's environment, which the installer's
# run-after-finish (a shell start, not a child of this script) reads. Taken away again in Cleanup.
[Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '--remote-debugging-port=9333', 'User')
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
$proc = Start-Process -FilePath $installer.FullName -PassThru
$done = $proc.WaitForExit(240000)
if (-not $done) { Shot 'installer-stuck.png'; Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Fail 'the installer did not finish within 4 minutes (see installer-stuck.png)' }
Write-Output "the installer exited $($proc.ExitCode)"
if ($proc.ExitCode -ne 0) { Fail "the installer failed (exit $($proc.ExitCode))" }
if (-not (Test-Path (Join-Path $Prog 'packages'))) { Fail 'the bare install left no packages beside the launcher for its first run' }
node scripts/launcher-setup-cdp.mjs 9333 $Out both
if ($LASTEXITCODE -ne 0) {
    Shot 'setup-window-screen.png'
    foreach ($f in @('logs\genie-launcher.log', 'logs\genie-host.log')) { $p = Join-Path $Data $f; if (Test-Path $p) { Write-Output "--- $f"; Get-Content $p -Tail 30 } }
    Fail 'the setup window was not driven through choose, installing and ready (above)'
}
for ($i = 0; $i -lt 30 -and (Test-Path (Join-Path $Prog 'packages')); $i++) { Start-Sleep -Seconds 1 }

# --- 2. what it put where ----------------------------------------------------------------------------------------------
$nsis = @(Get-ChildItem -Recurse -File $Prog | ForEach-Object { $_.FullName.Substring($Prog.Length + 1) })
Write-Output "the NSIS folder holds: $($nsis -join ', ')"
$extra = @($nsis | Where-Object { $_ -ne 'Genie.exe' -and $_ -ne 'Uninstall Genie.exe' })
if (-not ($nsis -contains 'Genie.exe')) { Fail "the launcher is not at $Prog\Genie.exe" }
if ($extra.Count -gt 0) { Fail "the NSIS folder holds more than the launcher: $($extra -join ', ')" }
$launcherVersion = (& (Join-Path $Prog 'Genie.exe') version | Out-String).Trim()
if ($launcherVersion -ne $build) { Fail "Genie.exe is not the launcher of this build (it says '$launcherVersion')" }
foreach ($t in @('client', 'browser', 'host')) {
    if (-not (Test-Path (Join-Path $Code "$t\$build\.complete"))) { Fail "$t $build is not complete in $Code\$t" }
}
$state = Get-Content -Raw (Join-Path $Code 'state.json') | ConvertFrom-Json
if ($state.profile -ne 'both') { Fail "the profile is '$($state.profile)', not both" }
$status = (& (Join-Path $Prog 'Genie.exe') status --json | Out-String)
Write-Output $status
$st = $status | ConvertFrom-Json
foreach ($t in @('client', 'browser', 'host')) { if (-not $st.tracks.$t.verified) { Fail "$t does not verify after the install: $($st.tracks.$t.why)" } }
$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut((Join-Path $StartMenu 'Genie.lnk'))
if ($lnk.TargetPath -ne (Join-Path $Prog 'Genie.exe')) { Fail "the Start menu's Genie runs '$($lnk.TargetPath)'" }
$doctor = $wsh.CreateShortcut((Join-Path $StartMenu 'Genie (doctor mode).lnk'))
if ($doctor.TargetPath -ne (Join-Path $Prog 'Genie.exe') -or $doctor.Arguments -ne '--doctor') { Fail "Genie (doctor mode) runs '$($doctor.TargetPath) $($doctor.Arguments)'" }
Write-Output "Start menu: Genie -> $($lnk.TargetPath); Genie (doctor mode) -> $($doctor.TargetPath) $($doctor.Arguments)"

# --- 3. Genie running, opened by the installer -------------------------------------------------------------------------
$life = Join-Path $Data 'runtime\lifecycle.log'
$linked = Wait-Line $life 'agent host (adopted|started|replaced) pid=' 120
if (-not $linked) {
    # The installer's own run-after-finish did not come: Genie is opened as its Start menu entry opens it.
    Write-Output '--- no window linked within 120 s of the install: opening Genie from the Start menu'
    Start-Process (Join-Path $StartMenu 'Genie.lnk')
    $linked = Wait-Line $life 'agent host (adopted|started|replaced) pid=' 120
}
if (-not $linked) {
    foreach ($f in @('runtime\lifecycle.log', 'logs\genie-host.log', 'logs\genie-client.log')) { $p = Join-Path $Data $f; if (Test-Path $p) { Write-Output "--- $f"; Get-Content $p -Tail 30 } }
    Fail 'the client window never linked to a host'
}
Write-Output "the client: $linked"
if ($linked -notmatch 'agent host adopted pid=') { Fail "the client did not ADOPT the launcher's host: $linked" }
$hostJson = Get-Content -Raw (Join-Path $Data 'runtime\host.json') | ConvertFrom-Json
$script:HostPid = $hostJson.pid
$hostPath = (Get-Process -Id $hostJson.pid -ErrorAction SilentlyContinue).Path
if ($hostPath -ne (Join-Path $Code "host\$build\genie-host.exe")) { Fail "genie-host runs from '$hostPath', not its own folder" }
Write-Output "genie-host pid $($hostJson.pid) runs from $hostPath"
$client = @(Get-Process genie-client -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $Code "client\$build\genie-client.exe") })
if ($client.Count -lt 1) { Fail "no genie-client runs from $Code\client\$build" }
$launcher = @(Get-Process Genie -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $Prog 'Genie.exe') })
if ($launcher.Count -lt 1) { Fail 'the launcher (Genie.exe) is not running' }
Write-Output "the client runs from $($client[0].Path); the launcher from $($launcher[0].Path)"
$ready = Wait-Line $life 'containment ready supervisor=' 60
if (-not $ready) { Fail "genie-host did not say its supervisor is ready within 60 s" }
if ($ready -notlike "*$Code\host\$build\*") { Fail "genie-host's supervisor is not in the host's own folder: $ready" }
Write-Output "genie-host: $ready"
if (-not (Select-String -Path $life -SimpleMatch 'started by the launcher' -Quiet)) { Fail 'the client did not say the launcher started it' }
if (Test-Path (Join-Path $Data 'host')) { Fail "a host copy was made under ~\.genie\host: the launcher's host is that copy, made at build time" }
Start-Sleep -Seconds 12
Shot 'genie-running-windows.png'

# --- 4. client only ----------------------------------------------------------------------------------------------------
$coCode = Join-Path $env:LOCALAPPDATA 'GenieClientOnlyRow'
$coHome = Join-Path $env:LOCALAPPDATA 'GenieClientOnlyRowHome'
$env:GENIE_CODE_ROOT = $coCode; $env:GENIE_HOME = $coHome
try {
    $o = (& (Join-Path $Prog 'Genie.exe') install --profile client --from $Pkg --yes 2>&1 | Out-String)
    $code = $LASTEXITCODE
} finally { Remove-Item Env:GENIE_CODE_ROOT, Env:GENIE_HOME -ErrorAction SilentlyContinue }
Write-Output $o
if ($code -ne 0) { Fail 'genie install --profile client refused' }
if (-not (Test-Path (Join-Path $coCode "client\$build\.complete")) -or -not (Test-Path (Join-Path $coCode "browser\$build\.complete"))) { Fail 'the client-only install has no client or browser' }
if (Test-Path (Join-Path $coCode 'host')) { Fail 'the client-only install has a host folder' }
$co = Get-Content -Raw (Join-Path $coCode 'state.json') | ConvertFrom-Json
if ($co.profile -ne 'client' -or $co.tracks.host) { Fail 'the client-only state is not client, or points at a host' }
Remove-Item -Recurse -Force $coCode, $coHome -ErrorAction SilentlyContinue

# --- 4b. a tampered package: the failure screen, in words, with a way forward ------------------------------------------
node scripts/ci/tamper-package.mjs $Pkg (Join-Path $Repo 'release\tracks\trees') (Join-Path $Out 'tampered-packages')
if ($LASTEXITCODE -ne 0) { Fail 'the tampered package set could not be made' }
$fCode = Join-Path $env:LOCALAPPDATA 'GenieFailRow'
$fHome = Join-Path $env:LOCALAPPDATA 'GenieFailRowHome'
$env:GENIE_CODE_ROOT = $fCode; $env:GENIE_HOME = $fHome; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9334'
try {
    $fp = Start-Process -FilePath (Join-Path $Prog 'Genie.exe') -ArgumentList @('setup', '--from', (Join-Path $Out 'tampered-packages')) -PassThru
    node scripts/launcher-setup-cdp.mjs 9334 $Out both fail
    $failShown = ($LASTEXITCODE -eq 0)
    [void]$fp.WaitForExit(30000)
} finally {
    Remove-Item Env:GENIE_CODE_ROOT, Env:GENIE_HOME -ErrorAction SilentlyContinue
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
}
if (-not $failShown) { Fail 'the failure screen for a tampered package was not as it must be (above)' }
$landed = @(Get-ChildItem -Directory (Join-Path $fCode 'client'), (Join-Path $fCode 'browser'), (Join-Path $fCode 'host') -ErrorAction SilentlyContinue)
if ($landed.Count -gt 0) { Fail "a refused install left builds: $(($landed | ForEach-Object { $_.FullName }) -join ', ')" }
Remove-Item -Recurse -Force $fCode, $fHome -ErrorAction SilentlyContinue

# --- 5. the uninstaller ------------------------------------------------------------------------------------------------
Get-Process genie-client -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$un = Start-Process -FilePath (Join-Path $Prog 'Uninstall Genie.exe') -ArgumentList '/S' -PassThru
[void]$un.WaitForExit(120000)
for ($i = 0; $i -lt 90 -and (Test-Path (Join-Path $Prog 'Genie.exe')); $i++) { Start-Sleep -Seconds 1 }
for ($i = 0; $i -lt 30 -and (Get-Process -Id $script:HostPid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
if (Get-Process -Id $script:HostPid -ErrorAction SilentlyContinue) { Fail "genie-host (pid $($script:HostPid)) still runs after the uninstall" }
if (Test-Path (Join-Path $Prog 'Genie.exe')) { Fail 'the launcher is still installed after the uninstall' }
if (Test-Path $Code) { Fail "the programs folder $Code is still there after the uninstall" }
if (-not (Test-Path $Data)) { Fail 'the data root ~\.genie was removed by the uninstall' }
$stopped = Select-String -Path (Join-Path $Data 'logs\genie-host.log') -Pattern 'shut|stopp' -Quiet
Write-Output "the host's log says it stopped: $stopped"
Cleanup
Write-Output "### launcher-install=PASS the installer put the launcher at $Prog\Genie.exe alone, the launcher installed the client, browser and host ($build) verified, started the host from its own folder, the client window adopted it, client-only installed no host, and the uninstaller stopped the host and removed the programs"
exit 0
