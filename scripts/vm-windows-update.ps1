# vm-windows-update.ps1 — THE UPDATER, PROVEN: runs INSIDE genie-test-windows over SSH (PowerShell 5.1).
#
#   scripts/vm-run.sh genie-test-windows repos/genie2 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vm-windows-update.ps1'
#
# §7's done-when is "an in-app update applies cleanly … and the next release is offered
# in-app". Nothing may be published without the owner's approval, so the release is a LOCAL
# one: electron-builder's own `latest.yml` + installer, served by `serve-feed.mjs`, and the
# installed app's `app-update.yml` pointed at it. Every call the real GitHub channel makes is
# made here — provider → latest.yml → download → verify sha512 → quit → NSIS /S → relaunch —
# against a different URL. In order:
#
#   1. package the tree at its current version (0.0.0) and install it silently
#   2. bump to 0.0.1, package again → release\ now holds 0.0.1 + latest.yml; restore the bump
#   3. serve release\ on 127.0.0.1:8099; point the installed app's app-update.yml at it
#   4. launch the installed 0.0.0 with CDP; update-cdp.mjs drives check → download → install,
#      visiting the Deck so the signal strip is seen doing each phase
#   5. the app quits, the installer runs, the app relaunches: assert Genie.exe is now 0.0.1,
#      a Genie process is running, and the §7.2 report was printed; tear down; uninstall
#
# Expects `npm ci` to have run (vm-run.sh keeps node_modules between runs).
param([string] $Next = '0.0.1')
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
Start-Transcript -Path (Join-Path $root 'update.log') -Force | Out-Null
function Step($n) { Write-Output ""; Write-Output "=== $n ===" }
function Run($cmd, $log = $null) {
    if ($log) {
        & cmd /c "$cmd > $log 2>&1"
        if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 40; throw "FAILED ($LASTEXITCODE): $cmd" }
    } else {
        & cmd /c "$cmd 2>&1"
        if ($LASTEXITCODE -ne 0) { throw "FAILED ($LASTEXITCODE): $cmd" }
    }
}
function Kill-Tree($id) { & cmd /c "taskkill /PID $id /T /F >nul 2>&1" }
function Installed-Version() {
    $exe = "$env:LOCALAPPDATA\Programs\Genie\Genie.exe"
    if (-not (Test-Path $exe)) { return $null }
    # electron-builder stamps the PE with a FOUR-part version ("0.0.0.0" for 0.0.0 — measured);
    # package.json has three. Compare the three that carry meaning.
    $v = (Get-Item $exe).VersionInfo.ProductVersion
    if (-not $v) { return $null }
    return (($v.Trim() -split '\.')[0..2] -join '.')
}

$installDir = "$env:LOCALAPPDATA\Programs\Genie"
$exe = Join-Path $installDir 'Genie.exe'
$uninst = Join-Path $installDir 'Uninstall Genie.exe'
# A CLEAN machine first. NSIS reuses the registered InstallLocation when the appId matches (that
# is how a real upgrade stays in Programs\Genie) — so a stale install anywhere, left by an
# earlier failed run, silently becomes the target. Measured 2026-10-10: a leftover
# Programs\genie2 swallowed two runs. Uninstall every registered Genie, then sweep the dirs.
function Uninstall-AnyGenie() {
    foreach ($p in (Genie-Processes "$env:LOCALAPPDATA\Programs")) { & cmd /c "taskkill /PID $($p.Id) /T /F >nul 2>&1" }
    $keys = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue)
    foreach ($k in $keys) {
        $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
        if (-not $p.DisplayName -or -not ($p.DisplayName -eq 'Genie' -or $p.DisplayName -like 'Genie *')) { continue }
        # A stale entry can have an EMPTY InstallLocation (measured: Join-Path refuses it and the
        # whole run died in the pre-clean). No location → no uninstaller to run → drop the key.
        $loc = [string]$p.InstallLocation
        $u = if ($loc) { Join-Path $loc 'Uninstall Genie.exe' } else { $null }
        Write-Output ("pre-clean: uninstalling " + $p.DisplayName + " " + $p.DisplayVersion + " at '" + $loc + "'")
        if ($u -and (Test-Path $u)) { Start-Process $u -ArgumentList '/S' -Wait; Start-Sleep 2 } else { Remove-Item $k.PSPath -Recurse -Force -ErrorAction SilentlyContinue }
    }
    foreach ($d in @("$env:LOCALAPPDATA\Programs\Genie", "$env:LOCALAPPDATA\Programs\genie2", "$env:LOCALAPPDATA\Programs\genie")) {
        if (Test-Path $d) { Write-Output "pre-clean: removing leftover $d"; Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
function Genie-Processes($dir) { return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$dir\*" }) }
$current = (Get-Content package.json | ConvertFrom-Json).version
$feed = $null
try {
    Step "package $current and install it"
    if (Test-Path release) { Remove-Item -Recurse -Force release }
    Run 'npm run build' 'build-current.log'
    Run 'npx electron-builder --publish never' 'package-current.log'
    $setup = @(Get-ChildItem "release\Genie-$current-setup.exe")[0]
    if (-not $setup) { throw "no release\Genie-$current-setup.exe" }
    Uninstall-AnyGenie
    # One-click NSIS (as every installed Genie was built): the first silent run of it in this
    # script left no Genie.exe and no detail. So: the installer's exit code, a bounded wait for
    # the executable, and what IS under Programs if it never appears.
    $inst = Start-Process $setup.FullName -ArgumentList '/S' -Wait -PassThru
    Write-Output ("installer exit code: " + $inst.ExitCode)
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $exe)) { Start-Sleep 2 }
    if (-not (Test-Path $exe)) {
        Write-Output "--- $env:LOCALAPPDATA\Programs ---"; Get-ChildItem "$env:LOCALAPPDATA\Programs" -ErrorAction SilentlyContinue | ForEach-Object { "  " + $_.Name }
        Write-Output "--- uninstall registry entries named Genie ---"
        Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.DisplayName -like 'Genie*') { "  " + $_.PSChildName + " " + $p.DisplayVersion + " " + $p.InstallLocation } }
        Write-Output "--- installer processes still running ---"; Get-Process | Where-Object { $_.Name -like '*Genie*setup*' -or $_.Name -like 'Un_A' } | ForEach-Object { "  " + $_.Id + " " + $_.Name }
        throw "no $exe after the silent install (exit code $($inst.ExitCode))"
    }
    Write-Output ("installed: " + (Installed-Version))
    if ((Installed-Version) -ne $current) { throw "installed version is $(Installed-Version), expected $current" }

    Step "package $Next as the update"
    Copy-Item package.json package.json.orig -Force
    Copy-Item package-lock.json package-lock.json.orig -Force
    try {
        Run "npm version $Next --no-git-tag-version" 'bump.log'
        Run 'npm run build' 'build-next.log'
        Run 'npx electron-builder --publish never' 'package-next.log'
    } finally {
        Move-Item package.json.orig package.json -Force
        Move-Item package-lock.json.orig package-lock.json -Force
    }
    $nextSetup = @(Get-ChildItem "release\Genie-$Next-setup.exe")[0]
    if (-not $nextSetup) { throw "no release\Genie-$Next-setup.exe" }
    $latest = Get-Content release\latest.yml -Raw
    Write-Output "latest.yml:"; Write-Output $latest
    if ($latest -notmatch "version: $([regex]::Escape($Next))") { throw "latest.yml does not name $Next" }

    Step 'serve the feed, point the installed app at it'
    $feed = Start-Process -FilePath node -ArgumentList 'scripts\serve-feed.mjs', 'release', '8099' -PassThru `
        -RedirectStandardOutput feed.log -RedirectStandardError feed-err.log
    Start-Sleep 2
    $probe = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8099/latest.yml'
    Write-Output ("feed answers: " + $probe.StatusCode + " " + $probe.RawContentLength + " bytes")
    $cfg = Join-Path $installDir 'resources\app-update.yml'
    Write-Output "app-update.yml as shipped:"; Get-Content $cfg
    Set-Content -Path $cfg -Value "provider: generic`nurl: http://127.0.0.1:8099/`nupdaterCacheDirName: genie2-updater`n" -Encoding ascii
    Write-Output "app-update.yml now:"; Get-Content $cfg

    Step "launch the installed $current and drive the update"
    $env:GENIE2_CODEX_BINARY = "$root\scripts\stub-codex.cmd"
    Run 'node scripts\smoke-seed.mjs'
    Remove-Item -Force -ErrorAction SilentlyContinue installed-out.log, installed-err.log
    $app = Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222' -PassThru `
        -RedirectStandardOutput installed-out.log -RedirectStandardError installed-err.log
    $env:EXPECT_VERSION = $Next
    # With fancy-pty installed, the driver's §7.2 control (one open terminal → one helper under
    # the install dir) is asserted, not merely reported.
    $fancyPty = Test-Path (Join-Path $root 'node_modules\@particle-academy\fancy-pty\package.json')
    if ($fancyPty) { $env:EXPECT_HELPERS = '1' } else { Remove-Item Env:EXPECT_HELPERS -ErrorAction SilentlyContinue }
    & cmd /c "node scripts\update-cdp.mjs 2>&1"
    $drive = $LASTEXITCODE
    if ($drive -ne 0) {
        Write-Output "--- installed stderr ---"; Get-Content installed-err.log -Tail 60 -ErrorAction SilentlyContinue
        Write-Output "--- installed stdout ---"; Get-Content installed-out.log -Tail 40 -ErrorAction SilentlyContinue
        Write-Output "--- feed ---"; Get-Content feed.log -Tail 20 -ErrorAction SilentlyContinue
        if (-not $app.HasExited) { Kill-Tree $app.Id }
        throw "update-cdp.mjs exited $drive"
    }

    Step "the app quits, the installer applies $Next, the app relaunches"
    $deadline = (Get-Date).AddSeconds(180)
    $version = Installed-Version
    while ((Get-Date) -lt $deadline -and $version -ne $Next) { Start-Sleep 2; $version = Installed-Version }
    Write-Output ("installed version now: " + $version)
    if ($version -ne $Next) { Get-Content installed-out.log -Tail 20 -ErrorAction SilentlyContinue; throw "Genie.exe is still $version after 180 s" }
    $deadline = (Get-Date).AddSeconds(60)
    $relaunched = @()
    while ((Get-Date) -lt $deadline -and $relaunched.Count -eq 0) {
        Start-Sleep 2
        $relaunched = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$installDir\*" })
    }
    Write-Output ("Genie processes after the update: " + $relaunched.Count)
    if ($relaunched.Count -eq 0) { throw 'the updated app did not relaunch' }

    # §7.4: the driver started the seeded codex agent (the stub app-server) BEFORE asking for the
    # install. Its process must be gone now (the quit ended the session) and must not be back
    # after the relaunch (restore_agents_on_launch defaults OFF; nothing revives on its own).
    Start-Sleep 10
    $stubs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*stub-codex*' })
    Write-Output ("§7.4 stub agent processes after quit + relaunch: " + $stubs.Count)
    if ($stubs.Count -ne 0) { $stubs | ForEach-Object { Write-Output ("  survivor: " + $_.ProcessId + " " + $_.CommandLine) }; throw "§7.4: $($stubs.Count) agent process(es) survived the upgrade or were revived" }
    # §7.2's other half: the terminal the driver left open had ONE fancy-pty helper under the
    # install dir (asserted in the driver when fancy-pty is installed); after the quit and the
    # relaunch there must be none — a helper that outlived the upgrade is exactly the 31-orphan
    # shape, and a helper that came back would be a terminal revived without anyone asking.
    $helpers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'fancy-pty-helper*' -and $_.ExecutablePath -like "$installDir\*" })
    Write-Output ("§7.2 fancy-pty helpers under the install dir after quit + relaunch: " + $helpers.Count)
    if ($helpers.Count -ne 0) { $helpers | ForEach-Object { Write-Output ("  survivor: " + $_.ProcessId + " " + $_.ExecutablePath) }; throw "§7.2: $($helpers.Count) pty helper(s) survived the upgrade" }
    Write-Output "--- the updated app's install dir ---"
    Get-ChildItem $installDir -File | ForEach-Object { "  " + $_.Name + " " + $_.Length }
    $report = Select-String -Path installed-out.log -Pattern '\[updater\]' -ErrorAction SilentlyContinue | ForEach-Object Line
    Write-Output "--- the §7.2 report, as the app printed it ---"; $report | ForEach-Object { "  " + $_ }
    if (-not ($report | Where-Object { $_ -match 'running from the install directory' })) { throw 'no §7.2 report in the app output' }

    Step 'tear down the relaunched app, uninstall'
    foreach ($p in $relaunched) { Kill-Tree $p.Id }
    Start-Sleep 2
    $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$installDir\*" })
    if ($left.Count) { throw "$($left.Count) process(es) survived" }
    Start-Process (Join-Path $installDir 'Uninstall Genie.exe') -ArgumentList '/S' -Wait
    Start-Sleep 2
    Write-Output ("install dir gone: " + (-not (Test-Path $exe)))

    Write-Output ""
    Write-Output "UPDATE PROVEN: $current -> $Next applied in-app, relaunched, §7.2 reported"
} finally {
    if ($feed -and -not $feed.HasExited) { Kill-Tree $feed.Id }
    Stop-Transcript | Out-Null
}
