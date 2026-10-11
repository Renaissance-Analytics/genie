# vm-windows-upgrade-from-v1.ps1 — THE UPGRADE PATH FROM v1, PROVEN: runs INSIDE genie-test-windows (PowerShell 5.1).
#
#   .ai/sandbox/test-vm/run-with-watchdog.sh 25 genie-test-windows repos/genie2 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vm-windows-upgrade-from-v1.ps1 -From 0.7.0-beta.342'
#   … and again with -From 2.0.0-beta.4
#
# The owner, 2026-10-10: "our genie 2.0 installer needs to be able to upgrade from the stable v1
# beta we are on now AND the 2.0 beta.4". Both are REAL installers from the old repo's releases
# (shipped in v1-installers/, downloaded from github.com/Renaissance-Analytics/genie), and both
# were built with appId ai.tynn.genie, productName Genie, one-click per-user NSIS, and an
# app-update.yml pointing at that repo. This script:
#
#   1. installs the real v1 silently; asserts ONE "Genie" in the per-user uninstall registry
#      reporting -From, and Genie.exe in %LOCALAPPDATA%\Programs\Genie
#   2. bumps genie2 to -Next (above 2.0.0-beta.4), builds, packages → release\ with latest.yml;
#      restores the bump
#   3. serves release\ on 127.0.0.1:8099 and points the INSTALLED v1's app-update.yml at it —
#      the only difference from production is the URL; the owner/repo in production is the
#      same old repo, which is why genie2 publishes there
#   4. launches the installed v1 with CDP; upgrade-from-v1-cdp.mjs drives v1's OWN updater
#      bridge (check → apply, v1's one-click Update)
#   5. v1 quits, the Genie 2 installer runs, and afterwards: the uninstall registry still holds
#      exactly ONE Genie, now reporting -Next (an in-place upgrade, not a second install);
#      Genie.exe is the new build; a Genie is running from the install dir (the relaunch);
#      ~\.genie\runtime exists (Genie 2 started and kept its data where every version does);
#      v1's %APPDATA%\genie is still there, untouched (nothing deleted a user's data)
#   6. tears down, uninstalls, and reports
#
# Expects `npm ci` to have run (vm-run.sh keeps node_modules between runs).
param([Parameter(Mandatory = $true)][string] $From, [string] $Next = '2.0.0-beta.5')
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
Start-Transcript -Path (Join-Path $root "upgrade-from-$From.log") -Force | Out-Null
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
# Every "Genie" the per-user uninstall registry knows: key name, DisplayVersion, InstallLocation.
function Installed-Genies() {
    $keys = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue)
    return @($keys | ForEach-Object {
        $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
        # electron-builder's NSIS writes DisplayName from productName; match loosely ("Genie",
        # "Genie 0.7.0-beta.342") so a format detail cannot hide a second install.
        if ($p.DisplayName -and ($p.DisplayName -eq 'Genie' -or $p.DisplayName -like 'Genie *')) { [pscustomobject]@{ Key = $_.PSChildName; Name = $p.DisplayName; Version = $p.DisplayVersion; Location = $p.InstallLocation } }
    })
}
function Genie-Processes($dir) { return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$dir\*" }) }

$installDir = "$env:LOCALAPPDATA\Programs\Genie"
$exe = Join-Path $installDir 'Genie.exe'
$uninst = Join-Path $installDir 'Uninstall Genie.exe'
$v1Setup = Join-Path $root "v1-installers\Genie-Setup-$From.exe"
if (-not (Test-Path $v1Setup)) { throw "no $v1Setup — ship v1-installers\ with the tree" }
$feed = $null
try {
    Step "install the REAL v1 $From"
    if (Test-Path $uninst) { Start-Process $uninst -ArgumentList '/S' -Wait; Start-Sleep 2 }
    Start-Process $v1Setup -ArgumentList '/S' -Wait
    Start-Sleep 2
    # A one-click install may auto-launch the app; it must not be running when we point its feed.
    foreach ($p in (Genie-Processes $installDir)) { Kill-Tree $p.Id }
    Start-Sleep 1
    $before = @(Installed-Genies)
    Write-Output ("uninstall registry before: " + (($before | ForEach-Object { "$($_.Key)=$($_.Version)" }) -join ', '))
    if ($before.Count -ne 1) { throw "expected exactly ONE Genie in the uninstall registry, found $($before.Count)" }
    if ($before[0].Version -ne $From) { throw "installed v1 reports $($before[0].Version), expected $From" }
    if (-not (Test-Path $exe)) { throw "no $exe after installing v1" }
    $v1Exe = (Get-Item $exe).Length
    Write-Output "v1 Genie.exe: $v1Exe bytes"
    Write-Output "v1 app-update.yml as shipped:"; Get-Content (Join-Path $installDir 'resources\app-update.yml')

    Step "package Genie 2 as $Next"
    if (Test-Path release) { Remove-Item -Recurse -Force release }
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

    Step "serve the feed, point the installed v1 at it"
    $feed = Start-Process -FilePath node -ArgumentList 'scripts\serve-feed.mjs', 'release', '8099' -PassThru `
        -RedirectStandardOutput feed.log -RedirectStandardError feed-err.log
    Start-Sleep 2
    $probe = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8099/latest.yml'
    Write-Output ("feed answers: " + $probe.StatusCode + " " + $probe.RawContentLength + " bytes")
    $cfg = Join-Path $installDir 'resources\app-update.yml'
    Set-Content -Path $cfg -Value "provider: generic`nurl: http://127.0.0.1:8099/`nupdaterCacheDirName: genie-updater`n" -Encoding ascii
    Write-Output "v1 app-update.yml now:"; Get-Content $cfg

    Step "launch the installed v1 and drive ITS updater"
    Remove-Item -Force -ErrorAction SilentlyContinue v1-out.log, v1-err.log
    $app = Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222' -PassThru `
        -RedirectStandardOutput v1-out.log -RedirectStandardError v1-err.log
    $env:EXPECT_VERSION = $Next
    & cmd /c "node scripts\upgrade-from-v1-cdp.mjs 2>&1"
    $drive = $LASTEXITCODE
    if ($drive -ne 0) {
        Write-Output "--- v1 stderr ---"; Get-Content v1-err.log -Tail 60 -ErrorAction SilentlyContinue
        Write-Output "--- v1 stdout ---"; Get-Content v1-out.log -Tail 40 -ErrorAction SilentlyContinue
        Write-Output "--- feed ---"; Get-Content feed.log -Tail 20 -ErrorAction SilentlyContinue
        foreach ($p in (Genie-Processes $installDir)) { Kill-Tree $p.Id }
        throw "upgrade-from-v1-cdp.mjs exited $drive"
    }

    Step "v1 quits, the Genie 2 installer applies $Next in place, Genie 2 relaunches"
    $deadline = (Get-Date).AddSeconds(240)
    $now = @(Installed-Genies)
    while ((Get-Date) -lt $deadline -and -not ($now.Count -eq 1 -and $now[0].Version -eq $Next)) { Start-Sleep 3; $now = @(Installed-Genies) }
    Write-Output ("uninstall registry after: " + (($now | ForEach-Object { "$($_.Key)=$($_.Version)" }) -join ', '))
    if ($now.Count -ne 1) { Get-Content v1-out.log -Tail 30 -ErrorAction SilentlyContinue; throw "expected exactly ONE Genie after the upgrade, found $($now.Count) — a second install, not an upgrade" }
    if ($now[0].Version -ne $Next) { Get-Content v1-out.log -Tail 30 -ErrorAction SilentlyContinue; throw "Genie still reports $($now[0].Version) after 240 s" }
    if ($now[0].Key -ne $before[0].Key) { throw "the uninstall key changed ($($before[0].Key) -> $($now[0].Key)): a different appId" }
    $newExe = (Get-Item $exe).Length
    Write-Output "Genie.exe now: $newExe bytes (was $v1Exe)"
    if ($newExe -eq $v1Exe) { throw 'Genie.exe is byte-for-byte the v1 size; the build did not replace it' }
    $deadline = (Get-Date).AddSeconds(60)
    $relaunched = @(Genie-Processes $installDir)
    while ((Get-Date) -lt $deadline -and $relaunched.Count -eq 0) { Start-Sleep 2; $relaunched = @(Genie-Processes $installDir) }
    Write-Output ("Genie processes after the upgrade: " + $relaunched.Count)
    if ($relaunched.Count -eq 0) { throw 'Genie 2 did not relaunch after the upgrade' }
    Start-Sleep 5
    $home2 = "$env:USERPROFILE\.genie\runtime"
    Write-Output ("~\.genie\runtime exists: " + (Test-Path $home2))
    if (-not (Test-Path $home2)) { throw "Genie 2 ran but wrote no runtime under $home2" }
    $v1Data = "$env:APPDATA\genie"
    Write-Output ("v1 data dir still present: " + (Test-Path $v1Data) + " ($v1Data)")
    if (-not (Test-Path $v1Data)) { throw "the upgrade removed v1's data directory $v1Data" }

    Step 'tear down the relaunched Genie 2, uninstall'
    foreach ($p in $relaunched) { Kill-Tree $p.Id }
    Start-Sleep 2
    $left = @(Genie-Processes $installDir)
    if ($left.Count) { throw "$($left.Count) process(es) survived" }
    Start-Process $uninst -ArgumentList '/S' -Wait
    Start-Sleep 2
    Write-Output ("install dir gone: " + (-not (Test-Path $exe)))
    Write-Output ("uninstall registry after uninstall: " + @(Installed-Genies).Count)

    Write-Output ""
    Write-Output "UPGRADE PROVEN: v1 $From -> Genie 2 $Next, in place, through v1's own updater; one Genie before and after; v1 data untouched"
} finally {
    if ($feed -and -not $feed.HasExited) { Kill-Tree $feed.Id }
    Stop-Transcript | Out-Null
}
