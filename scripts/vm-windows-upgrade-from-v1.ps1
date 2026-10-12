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
# A CLEAN machine first. NSIS reuses the registered InstallLocation when the appId matches (that
# is how the real upgrade stays in Programs\Genie), so a stale install anywhere — left by an
# earlier failed run — would silently become v1's target and then Genie 2's. Measured
# 2026-10-10: a leftover Programs\genie2 swallowed two runs. Uninstall every registered Genie,
# then sweep the directories, before the real v1 goes on.
function Uninstall-AnyGenie() {
    foreach ($p in (Genie-Processes "$env:LOCALAPPDATA\Programs")) { Kill-Tree $p.Id }
    foreach ($g in @(Installed-Genies)) {
        # A stale entry can have an EMPTY InstallLocation (measured: Join-Path refuses it and the
        # whole run died in the pre-clean). No location → no uninstaller to run → drop the key.
        $loc = [string]$g.Location
        $u = if ($loc) { Join-Path $loc 'Uninstall Genie.exe' } else { $null }
        Write-Output ("pre-clean: uninstalling " + $g.Name + " " + $g.Version + " at '" + $loc + "'")
        if ($u -and (Test-Path $u)) { Start-Process $u -ArgumentList '/S' -Wait; Start-Sleep 2 }
        else { Remove-Item ("HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\" + $g.Key) -Recurse -Force -ErrorAction SilentlyContinue }
    }
    foreach ($d in @("$env:LOCALAPPDATA\Programs\Genie", "$env:LOCALAPPDATA\Programs\genie2", "$env:LOCALAPPDATA\Programs\genie")) {
        if (Test-Path $d) { Write-Output "pre-clean: removing leftover $d"; Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
    }
    # electron-builder's NSIS remembers the install directory in a SECOND key, HKCU\Software\<appId
    # GUID>\InstallLocation, and every later installer with the same appId — v1's included — goes
    # where it says. Measured 2026-10-10 21:5x: with the Uninstall entry and the directories gone,
    # the real 2.0.0-beta.4 installer still landed in Programs\genie2 because this key said so.
    foreach ($k in @(Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^[0-9a-fA-F-]{36}$' })) {
        $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
        if ($p.InstallLocation -and ($p.InstallLocation -like '*\Programs\genie*' -or $p.InstallLocation -like '*\Programs\Genie*')) {
            Write-Output ("pre-clean: removing install-memory key HKCU\Software\" + $k.PSChildName + " (" + $p.InstallLocation + ")")
            Remove-Item $k.PSPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    $left = @(Installed-Genies)
    if ($left.Count -ne 0) { throw "pre-clean left $($left.Count) Genie entries in the uninstall registry" }
}

$installDir = "$env:LOCALAPPDATA\Programs\Genie"
$exe = Join-Path $installDir 'Genie.exe'
$uninst = Join-Path $installDir 'Uninstall Genie.exe'
$v1Setup = Join-Path $root "v1-installers\Genie-Setup-$From.exe"
if (-not (Test-Path $v1Setup)) { throw "no $v1Setup — ship v1-installers\ with the tree" }
$feed = $null
try {
    Step "install the REAL v1 $From"
    Uninstall-AnyGenie
    Start-Process $v1Setup -ArgumentList '/S' -Wait
    Start-Sleep 2
    # A one-click install may auto-launch the app; it must not be running when we point its feed.
    foreach ($p in (Genie-Processes $installDir)) { Kill-Tree $p.Id }
    Start-Sleep 1
    $before = @(Installed-Genies)
    Write-Output ("uninstall registry before: " + (($before | ForEach-Object { "$($_.Key)=$($_.Version) at '$($_.Location)'" }) -join ', '))
    if ($before.Count -ne 1) { throw "expected exactly ONE Genie in the uninstall registry, found $($before.Count)" }
    if ($before[0].Version -ne $From) { throw "installed v1 reports $($before[0].Version), expected $From" }
    # A one-click installer can return before its files are all on disk (measured on the rc run:
    # the registry entry was there, Genie.exe was not yet). Wait, bounded; then say what IS there.
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $exe)) { Start-Sleep 2 }
    if (-not (Test-Path $exe)) {
        Write-Output "--- $env:LOCALAPPDATA\Programs ---"; Get-ChildItem "$env:LOCALAPPDATA\Programs" -ErrorAction SilentlyContinue | ForEach-Object { "  " + $_.Name }
        $loc = [string]$before[0].Location
        if ($loc -and (Test-Path $loc)) { Write-Output "--- $loc ---"; Get-ChildItem $loc -File -ErrorAction SilentlyContinue | Select-Object -First 8 | ForEach-Object { "  " + $_.Name } }
        throw "no $exe after installing v1 (registry says '$loc')"
    }
    $v1Exe = (Get-Item $exe).Length
    Write-Output "v1 Genie.exe: $v1Exe bytes"

    # THE DATA THAT MUST CARRY OVER. The owner's first real upgrade (2026-10-11) lost every workspace:
    # Genie 2 never read v1's genie.db. So v1 runs once here to create its database the way it really
    # does, is killed, and the database is seeded with one workspace and two agents through v1's own
    # schema; after the upgrade Genie 2's import is asserted on exactly those rows.
    Step 'first-run v1 so it creates its database, then seed it with a workspace and two agents'
    $v1Db = "$env:APPDATA\genie\genie.db"
    $first = Start-Process -FilePath $exe -PassThru
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $v1Db)) { Start-Sleep 2 }
    Start-Sleep 5
    foreach ($p in (Genie-Processes $installDir)) { Kill-Tree $p.Id }
    Start-Sleep 2
    if (-not (Test-Path $v1Db)) { throw "v1 ran and created no $v1Db" }
    Run "node scripts\seed-v1-db.mjs ""$v1Db"" ""$root"""

    # THE ORPHAN CONTROL. v1's dead pty host left 42 shells behind on the owner's desktop; here one orphaned
    # cmd.exe (its parent exits at once) with a long ping under it stands in for them. It must exist before
    # the upgrade (positive control) and be gone after — reaped and REPORTED by Genie 2's first boot.
    Step 'leave an orphaned shell behind, as v1 did, to be reaped by Genie 2'
    & cmd /c 'start /b cmd /c "ping -n 3600 127.0.0.1 >nul"'
    Start-Sleep 3
    $orphanPings = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'PING.EXE' -and $_.CommandLine -like '*-n 3600*' })
    Write-Output ("orphan control before the upgrade: " + $orphanPings.Count + " long ping(s) under an orphaned cmd")
    if ($orphanPings.Count -lt 1) { throw 'the orphan control did not start' }
    Write-Output "v1 app-update.yml as shipped:"; Get-Content (Join-Path $installDir 'resources\app-update.yml')

    Step "package Genie 2 as $Next"
    if (Test-Path release) { Remove-Item -Recurse -Force release }
    Copy-Item package.json package.json.orig -Force
    Copy-Item package-lock.json package-lock.json.orig -Force
    try {
        Run "npm version $Next --no-git-tag-version --allow-same-version" 'bump.log'
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

    # Genie 2's first boot imported v1's rows — the proof the owner's upgrade lacked.
    $importFile = "$env:USERPROFILE\.genie\v1-import.json"
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $importFile)) { Start-Sleep 2 }
    if (-not (Test-Path $importFile)) { throw "Genie 2 wrote no $importFile — the v1 import never ran" }
    $import = Get-Content $importFile -Raw | ConvertFrom-Json
    Write-Output ("IMPORTED FROM v1: " + (Get-Content $importFile -Raw))
    if (-not $import.sawV1) { throw 'the import did not see the v1 database' }
    if ($import.workspaces -ne 1) { throw "expected 1 imported workspace, got $($import.workspaces)" }
    if ($import.agents -ne 2) { throw "expected 2 imported agents, got $($import.agents)" }
    # The Store keeps its files under the runtime dir (paths.ts runtimeDir): ~\.genie\runtime\{workspaces,agents}.json.
    $ws = Get-Content "$env:USERPROFILE\.genie\runtime\workspaces.json" -Raw
    if ($ws -notmatch '01seedv1workspace00000000a') { throw "workspaces.json does not carry the seeded workspace: $ws" }
    $ag = Get-Content "$env:USERPROFILE\.genie\runtime\agents.json" -Raw
    if ($ag -notmatch '"kai"' -or $ag -notmatch '"kai-slave"' -or $ag -notmatch '\.agents/kai/AGENT\.md') { throw "agents.json does not carry kai + kai-slave with the persona: $ag" }
    Write-Output 'v1 IMPORT PROVEN: the seeded workspace and both agents are in Genie 2 after the upgrade, persona made workspace-relative'

    $reapFile = "$env:USERPROFILE\.genie\v1-reap.json"
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $reapFile)) { Start-Sleep 2 }
    if (-not (Test-Path $reapFile)) { throw "Genie 2 wrote no $reapFile — the v1 reap never ran (the orphan control was there)" }
    $reap = Get-Content $reapFile -Raw | ConvertFrom-Json
    Write-Output ("REAPED BY GENIE 2: found " + $reap.found + ", killed " + $reap.killed + ": " + (($reap.victims | ForEach-Object { $_.why + ' ' + $_.executable }) -join ' | '))
    if ($reap.found -lt 1) { throw 'the reap found nothing, but an orphaned shell was left for it' }
    $pingsAfter = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'PING.EXE' -and $_.CommandLine -like '*-n 3600*' })
    if ($pingsAfter.Count -ne 0) { throw "the orphan control survived the reap: $($pingsAfter.Count) long ping(s) still running" }
    Write-Output 'v1 REAP PROVEN: the orphaned shell and its child were found, killed and reported by Genie 2 at first boot'

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
