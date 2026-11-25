# vm-windows-update.ps1 — A HOST UPDATE DRAINS AND SWAPS, PROVEN (Tynn #1036 P6-2, task #1499; the CI row `host-update`).
#
# Needs only Windows PowerShell 5.1, a logged-on Windows desktop session (the host's keychain, the window) and this
# repository checked out with `npm ci` run. It assumes no particular machine: from the checkout's root, in that session,
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vm-windows-update.ps1
#
# It installs into the session user's %LOCALAPPDATA%\Programs\Genie, serves its feed on 127.0.0.1:8099, and uninstalls at the end.
#
# Nothing may be published without the owner's approval, so the release is a LOCAL one: electron-builder's own latest.yml +
# installer, served by serve-feed.mjs, and the installed app's app-update.yml pointed at it. Every call the real GitHub channel
# makes is made here (provider, latest.yml, download, sha512, quit, NSIS /S, relaunch) against a different URL.
#
# The update carries ANOTHER genie-host: $Next is built with GENIE_TEST_HOST_MARK (vite.main.config.ts; nothing that ships sets
# it), so its host.js differs from $Base's, and its latest.yml names that host (scripts/feed-host-identity.mjs, as the
# release does). The installed Genie classifies the update full. With the seeded agent running when install is asked, the row:
#
#   the host logged a full install ("this host exits"); the drain recorded the agent in running-at-quit.json before the old
#   host was gone; the old genie-host and every agent provider from before are gone; a NEW genie-host runs the update's host
#   (its host.js under ~/.genie/host/<the update's hash>, its binary the copied runtime, and it logs the update's mark); the
#   base's copy is gone; the agent came back exactly once, under the new host, and the record is spent; no pty helper
#   outlived the install; Genie.exe is $Next. Everything the run started is ended through scripts/end-own-tree.mjs.
#
# Break probes (HOST_UPDATE_BREAK, or host-update-break.txt at the root: In-Session passes no environment):
#   client-only   the update is built with no mark (the same host): the row must fail on the kept host.
#   drop-restore  the drain's record is emptied while the installer runs: the row must fail on the agent that did not come back.
#
# If the two builds' hosts are the same with no probe asking for it, there is no host update to prove: the run stops and says
# so (### host-update=NOT-A-HOST-UPDATE). Prints `### host-update=PASS` at the end; a failure throws.
param([string] $Base = '2.0.0', [string] $Next = '2.0.1')
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
    # electron-builder stamps the PE with a FOUR-part version ("0.0.0.0" for 0.0.0, measured); package.json has three.
    $v = (Get-Item $exe).VersionInfo.ProductVersion
    if (-not $v) { return $null }
    return (($v.Trim() -split '\.')[0..2] -join '.')
}
function Command-Line($id) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue; if ($p) { return [string]$p.CommandLine } else { return '' } }
# Whether $child is $ancestor or started under it, by the parent pids Windows records (bounded: a chain is never this long).
function Descends($child, $ancestor) {
    $parents = @{}
    foreach ($p in @(Get-CimInstance Win32_Process)) { $parents[[int]$p.ProcessId] = [int]$p.ParentProcessId }
    $at = [int]$child
    for ($i = 0; $i -lt 16; $i++) {
        if ($at -eq [int]$ancestor) { return $true }
        if (-not $parents.ContainsKey($at) -or $parents[$at] -eq $at -or $parents[$at] -eq 0) { return $false }
        $at = $parents[$at]
    }
    return $false
}
# The agent providers: the stub runs under genie-host's own executable as Node (ELECTRON_RUN_AS_NODE), never node.exe, so it
# is found by its script, whatever runs it (measured in P6-1: a node.exe filter found 0 while the agent ran).
function Stub-Providers() { return @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*stub-codex.mjs*' }) }
# The ids in a JSON array file, one per output line, read by node: in PowerShell 5.1 ConvertFrom-Json does not unroll an
# array, so @(... | ConvertFrom-Json).Count reads `[]` as ONE (RULES.md: a gauge that reads one as nothing). No file, no ids.
function Json-Ids($file) { if (-not (Test-Path $file)) { return @() }; return @(& node -e "for (const id of JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))) console.log(id)" $file) }
function Host-Record-Pid() { try { return [int]((Get-Content $hostRecord -Raw | ConvertFrom-Json).pid) } catch { return 0 } }

$installDir = "$env:LOCALAPPDATA\Programs\Genie"
$exe = Join-Path $installDir 'Genie.exe'
$genieHome = Join-Path $env:USERPROFILE '.genie'
$hostRecord = Join-Path $genieHome 'runtime\host.json'
$runningAtQuit = Join-Path $genieHome 'runtime\running-at-quit.json'
$interruptedAtQuit = Join-Path $genieHome 'runtime\interrupted-at-quit.json'
$lifecycle = Join-Path $genieHome 'runtime\lifecycle.log'
$hostLog = Join-Path $genieHome 'logs\genie-host.log'
# A CLEAN machine first. NSIS reuses the registered InstallLocation when the appId matches (that is how a real upgrade stays in
# Programs\Genie), so a stale install anywhere, left by an earlier failed run, silently becomes the target. Measured
# 2026-10-10: a leftover Programs\genie2 swallowed two runs. Uninstall every registered Genie, then sweep the dirs.
function Uninstall-AnyGenie() {
    foreach ($p in (Genie-Processes "$env:LOCALAPPDATA\Programs")) { & cmd /c "taskkill /PID $($p.Id) /T /F >nul 2>&1" }
    $keys = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue)
    foreach ($k in $keys) {
        $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
        if (-not $p.DisplayName -or -not ($p.DisplayName -eq 'Genie' -or $p.DisplayName -like 'Genie *')) { continue }
        # A stale entry can have an EMPTY InstallLocation (measured: Join-Path refuses it). No location, no uninstaller: drop the key.
        $loc = [string]$p.InstallLocation
        $u = if ($loc) { Join-Path $loc 'Uninstall Genie.exe' } else { $null }
        Write-Output ("pre-clean: uninstalling " + $p.DisplayName + " " + $p.DisplayVersion + " at '" + $loc + "'")
        if ($u -and (Test-Path $u)) { Start-Process $u -ArgumentList '/S' -Wait; Start-Sleep 2 } else { Remove-Item $k.PSPath -Recurse -Force -ErrorAction SilentlyContinue }
    }
    foreach ($d in @("$env:LOCALAPPDATA\Programs\Genie", "$env:LOCALAPPDATA\Programs\genie2", "$env:LOCALAPPDATA\Programs\genie")) {
        if (Test-Path $d) { Write-Output "pre-clean: removing leftover $d"; Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
    }
    # electron-builder's NSIS remembers the install directory in a SECOND key, HKCU\Software\<appId GUID>\InstallLocation, and
    # every later installer with the same appId goes where it says (measured 2026-10-10).
    foreach ($k in @(Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^[0-9a-fA-F-]{36}$' })) {
        $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
        if ($p.InstallLocation -and ($p.InstallLocation -like '*\Programs\genie*' -or $p.InstallLocation -like '*\Programs\Genie*')) {
            Write-Output ("pre-clean: removing install-memory key HKCU\Software\" + $k.PSChildName + " (" + $p.InstallLocation + ")")
            Remove-Item $k.PSPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
function Genie-Processes($dir) { return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$dir\*" }) }

# THE BREAK PROBE, if one is asked: from the environment, or a file at the root (In-Session passes no environment).
$breakFile = Join-Path $root 'host-update-break.txt'
$break = if ($env:HOST_UPDATE_BREAK) { $env:HOST_UPDATE_BREAK } elseif (Test-Path $breakFile) { (Get-Content $breakFile -Raw).Trim() } else { '' }
if ($break) { Write-Output "BREAK PROBE asked: $break" }
# A DEBUGGER PORT OF ITS OWN: no other row uses it (test/ci-debug-ports-unique.test.ts); the driver checks the page is this run's launch.
$debugPort = 9416
$env:CDP_PORT = "$debugPort"
function Assert-PortFree {
    $answered = $false
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$debugPort/json/version" | Out-Null; $answered = $true } catch { }
    if ($answered) { throw "something already answers on this row's debugger port $debugPort (not this run's Genie)" }
}
# Put back whatever happens, after the `finally` below has ended the feed.
Copy-Item package.json package.json.pristine -Force
Copy-Item package-lock.json package-lock.json.pristine -Force
$current = $Base
$feed = $null
$app = $null
$script:began = $null
$script:ended = $false
$script:relaunchedPids = @()
$script:userEnvSet = $false
try {
    Run "npm version $Base --no-git-tag-version --allow-same-version" 'bump-base.log'
    Step "package $current and install it"
    if (Test-Path release) { Remove-Item -Recurse -Force release }
    # The base carries no mark.
    Remove-Item Env:GENIE_TEST_HOST_MARK -ErrorAction SilentlyContinue
    Run 'npm run build' 'build-current.log'
    $baseHostHash = (Get-FileHash -Algorithm SHA256 'dist\main\host.js').Hash.ToLower().Substring(0, 12)
    Write-Output ("the base build's genie-host: " + $baseHostHash)
    # A BUILD MADE AS ONE THAT SHIPS (no GENIE_TEST_HOST_MARK) CARRIES NO MARK: its host.js has no row mark in it.
    if (Select-String -Path 'dist\main\host.js' -Pattern 'host-update-' -SimpleMatch -Quiet) { throw 'the base build, made with no mark, carries a host-update mark in host.js' }
    Run 'npx electron-builder --publish never --config.win.signExecutable=false' 'package-current.log'
    $setup = @(Get-ChildItem "release\Genie-$current-setup.exe")[0]
    if (-not $setup) { throw "no release\Genie-$current-setup.exe" }
    Uninstall-AnyGenie
    # A clean home: the base's copy is the only one, and no record from an earlier run is restored.
    foreach ($d in @((Join-Path $genieHome 'host'), $runningAtQuit, $interruptedAtQuit)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
    $inst = Start-Process $setup.FullName -ArgumentList '/S' -Wait -PassThru
    Write-Output ("installer exit code: " + $inst.ExitCode)
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $exe)) { Start-Sleep 2 }
    if (-not (Test-Path $exe)) {
        Write-Output "--- $env:LOCALAPPDATA\Programs ---"; Get-ChildItem "$env:LOCALAPPDATA\Programs" -ErrorAction SilentlyContinue | ForEach-Object { "  " + $_.Name }
        throw "no $exe after the silent install (exit code $($inst.ExitCode))"
    }
    Write-Output ("installed: " + (Installed-Version))
    if ((Installed-Version) -ne $current) { throw "installed version is $(Installed-Version), expected $current" }

    Step "package $Next as the update, with another genie-host"
    $mark = if ($break -eq 'client-only') { '' } else { "host-update-$Next" }
    Copy-Item package.json package.json.orig -Force
    Copy-Item package-lock.json package-lock.json.orig -Force
    try {
        Run "npm version $Next --no-git-tag-version" 'bump.log'
        $env:GENIE_TEST_HOST_MARK = $mark
        Run 'npm run build' 'build-next.log'
        Run 'npx electron-builder --publish never --config.win.signExecutable=false' 'package-next.log'
    } finally {
        Remove-Item Env:GENIE_TEST_HOST_MARK -ErrorAction SilentlyContinue
        Move-Item package.json.orig package.json -Force
        Move-Item package-lock.json.orig package-lock.json -Force
    }
    $nextSetup = @(Get-ChildItem "release\Genie-$Next-setup.exe")[0]
    if (-not $nextSetup) { throw "no release\Genie-$Next-setup.exe" }
    $nextHostHash = (Get-FileHash -Algorithm SHA256 'dist\main\host.js').Hash.ToLower().Substring(0, 12)
    Write-Output ("the update's genie-host: " + $nextHostHash + " (mark '" + $mark + "')")
    # The control for the base's absence: the same search finds the mark in a build made with one.
    if ($mark -and -not (Select-String -Path 'dist\main\host.js' -Pattern $mark -SimpleMatch -Quiet)) { throw "the update's host.js does not carry its mark '$mark'" }
    if ($nextHostHash -eq $baseHostHash -and $break -ne 'client-only') { Write-Output '### host-update=NOT-A-HOST-UPDATE'; throw "the two builds carry the same host ($baseHostHash): the mark did not reach host.js" }
    Run 'node scripts\feed-host-identity.mjs release\latest.yml' 'feed-host.log'
    $latest = Get-Content release\latest.yml -Raw
    if ($latest -notmatch "genieHostHash: '$nextHostHash'") { throw "latest.yml does not name the update's host $nextHostHash" }
    if ($latest -notmatch "version: $([regex]::Escape($Next))") { throw "latest.yml does not name $Next" }
    Write-Output "latest.yml:"; Write-Output $latest

    Step 'serve the feed, point the installed app at it'
    $feed = Start-Process -FilePath node -ArgumentList 'scripts\serve-feed.mjs', 'release', '8099' -PassThru `
        -RedirectStandardOutput feed.log -RedirectStandardError feed-err.log
    # Asked until it answers, bounded (measured, 1124-000813-f161b2: as a CI row the feed was not up 2 s after its start).
    $probe = $null
    $feedUntil = (Get-Date).AddSeconds(60)
    while (-not $probe -and (Get-Date) -lt $feedUntil) {
        Start-Sleep 2
        if ($feed.HasExited) { Get-Content feed.log, feed-err.log -ErrorAction SilentlyContinue; throw "the feed exited ($($feed.ExitCode))" }
        try { $probe = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8099/latest.yml' -TimeoutSec 5 } catch { $probe = $null }
    }
    if (-not $probe) { Get-Content feed.log, feed-err.log -ErrorAction SilentlyContinue; throw 'the feed did not answer on 127.0.0.1:8099 within 60 s' }
    Write-Output ("feed answers: " + $probe.StatusCode + " " + $probe.RawContentLength + " bytes")
    $cfg = Join-Path $installDir 'resources\app-update.yml'
    Set-Content -Path $cfg -Value "provider: generic`nurl: http://127.0.0.1:8099/`nupdaterCacheDirName: genie2-updater`n" -Encoding ascii
    Write-Output "app-update.yml now:"; Get-Content $cfg

    Step "launch the installed $current and drive the update"
    $env:GENIE2_CODEX_BINARY = "$root\scripts\stub-codex.mjs"
    # THE RELAUNCHED GENIE FINDS THE STUB PROVIDER TOO (measured, 1124-084713-52fc4e): the installer starts the updated window
    # as the signed-in user through Explorer, so it and its new host have Explorer's environment, not this script's; the
    # restored agent's start failed at its handshake on the new host with no process. Set for the user (SetEnvironmentVariable
    # tells Explorer), the stand-in reaches it as an installed codex would; removed at the end, pass or fail.
    [Environment]::SetEnvironmentVariable('GENIE2_CODEX_BINARY', $env:GENIE2_CODEX_BINARY, 'User')
    $script:userEnvSet = $true
    $env:GENIE_PAGE_PROBE = '1'
    Remove-Item Env:UPDATE_TICKS_FILE -ErrorAction SilentlyContinue
    $script:began = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    # THE SEED'S WORKSPACE IS A NEW DIRECTORY, NEVER THE CHECKOUT (the full gate 1124-020718-168937): in a gate shard earlier rows
    # have seeded the checkout and changed its project.json, so a seed of it is refused.
    $workspace = Join-Path ([System.IO.Path]::GetTempPath()) ("genie-host-update-workspace-" + $PID)
    if (Test-Path $workspace) { Remove-Item -Recurse -Force $workspace }
    New-Item -ItemType Directory -Force $workspace | Out-Null
    Push-Location $workspace
    try { & node (Join-Path $root 'scripts\smoke-seed.mjs'); $seedExit = $LASTEXITCODE } finally { Pop-Location }
    if ($seedExit -ne 0) { throw "the seed failed in $workspace (exit $seedExit)" }
    Remove-Item -Force -ErrorAction SilentlyContinue installed-out.log, installed-err.log
    Assert-PortFree
    $app = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$debugPort" -PassThru `
        -RedirectStandardOutput installed-out.log -RedirectStandardError installed-err.log
    $env:EXPECT_VERSION = $Next
    # NOT the driver's "one helper under the install dir" control: since the host split a terminal's pty helper runs from
    # genie-host's copy, not the install (measured, 1124-071406-5b696f: 0 under the install dir, three runs). The row
    # instead records every pty helper there is when install is asked, and none may outlive the update.
    Remove-Item Env:EXPECT_HELPERS -ErrorAction SilentlyContinue
    # The host the update must replace, recorded before anything is asked of the updater: the base's, from its copy.
    $deadline = (Get-Date).AddSeconds(90)
    $hostBefore = $null
    while ((Get-Date) -lt $deadline -and -not $hostBefore) {
        Start-Sleep 2
        $hp = Host-Record-Pid
        if ($hp) { $hostBefore = Get-Process -Id $hp -ErrorAction SilentlyContinue }
    }
    if (-not $hostBefore) { throw 'no live genie-host recorded in host.json before the update' }
    $hostBeforeLine = Command-Line $hostBefore.Id
    Write-Output ("genie-host before the update: pid " + $hostBefore.Id + ", started " + $hostBefore.StartTime + ": " + $hostBeforeLine)
    if ($hostBeforeLine -notlike "*\host\$baseHostHash\dist\main\host.js*") { throw "the base genie-host does not run the base's copy (host\$baseHostHash): $hostBeforeLine" }
    $env:CDP_OWN_PID = "$($app.Id)"
    # THE PROVIDERS AND PTY HELPERS ARE SAMPLED WHILE THE DRIVER RUNS, never after it: a full install drains at once, so by
    # the time update-cdp.mjs exits they are already gone (measured, 1124-081929-7eb671: none found after it, on both
    # platforms, while the client-only probe, whose agent is kept, found its provider).
    $driver = Start-Process -FilePath node -ArgumentList 'scripts\update-cdp.mjs' -PassThru -NoNewWindow `
        -RedirectStandardOutput update-cdp.log -RedirectStandardError update-cdp-err.log
    $null = $driver.Handle
    $seenStubs = @{}
    $seenHelpers = @{}
    while (-not $driver.HasExited) {
        foreach ($p in @(Get-CimInstance Win32_Process)) {
            if ($p.CommandLine -and $p.CommandLine -like '*stub-codex.mjs*') { $seenStubs[[int]$p.ProcessId] = $true }
            if ($p.Name -like 'fancy-pty-helper*') { $seenHelpers[[int]$p.ProcessId] = $true }
        }
        Start-Sleep -Milliseconds 500
    }
    $driver.WaitForExit()
    $drive = $driver.ExitCode
    Get-Content update-cdp.log, update-cdp-err.log -ErrorAction SilentlyContinue
    $helpersBefore = @($seenHelpers.Keys | ForEach-Object { [int]$_ })
    Write-Output ("pty helpers seen while the driver ran: " + $helpersBefore.Count + " (" + ($helpersBefore -join ', ') + ")")
    $beforeIds = @($seenStubs.Keys | ForEach-Object { [int]$_ })
    Write-Output ("agent providers when install was asked: " + ($beforeIds -join ', '))
    if ($drive -ne 0) {
        Write-Output "--- installed stderr ---"; Get-Content installed-err.log -Tail 200 -ErrorAction SilentlyContinue
        Write-Output "--- feed ---"; Get-Content feed.log -Tail 20 -ErrorAction SilentlyContinue
        if (-not $app.HasExited) { Kill-Tree $app.Id }
        throw "update-cdp.mjs exited $drive"
    }
    if ($beforeIds.Count -lt 1) { throw 'no agent provider was running when install was asked: there is nothing for the drain to carry' }

    Step 'the drain: the old host records who comes back, and goes'
    $deadline = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $hostBefore.Id -ErrorAction SilentlyContinue)) { Start-Sleep 1 }
    if (Get-Process -Id $hostBefore.Id -ErrorAction SilentlyContinue) { Get-Content $hostLog -Tail 40 -ErrorAction SilentlyContinue; throw "the old genie-host pid $($hostBefore.Id) did not exit within 150 s of the install" }
    Write-Output ("the old genie-host pid " + $hostBefore.Id + " is gone")
    if (-not (Test-Path $runningAtQuit)) { throw "the drain wrote no $runningAtQuit" }
    $atQuit = @(Json-Ids $runningAtQuit)
    Write-Output ("the drain's record of who comes back: " + ($atQuit -join ', '))
    if ($atQuit.Count -lt 1) { throw 'the drain recorded no agent to come back' }
    if ($break -eq 'drop-restore') {
        Write-Output 'BREAK PROBE: the drain record emptied while the installer runs'
        Set-Content -Path $runningAtQuit -Value '[]' -Encoding ascii -NoNewline
        Set-Content -Path $interruptedAtQuit -Value '[]' -Encoding ascii -NoNewline
    }

    Step "the installer applies $Next, the app relaunches"
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
    if ($relaunched.Count -eq 0) { throw 'the updated app did not relaunch' }
    $script:relaunchedPids = @($relaunched | ForEach-Object { $_.Id })
    foreach ($p in $relaunched) { $c = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue; if ($c) { $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.ParentProcessId)" -ErrorAction SilentlyContinue; Write-Output ("  relaunched " + $p.Id + ", parent " + $c.ParentProcessId + " " + $(if ($pp) { $pp.Name } else { '(gone)' })) } }
    $relaunchAt = ($relaunched | ForEach-Object { $_.StartTime } | Sort-Object | Select-Object -First 1)
    Write-Output ("the window came back at " + $relaunchAt + ": pid(s) " + ($script:relaunchedPids -join ', '))

    Step 'the swap: a new genie-host, from the update''s copy'
    $deadline = (Get-Date).AddSeconds(90)
    $hostAfter = $null
    while ((Get-Date) -lt $deadline -and -not $hostAfter) {
        Start-Sleep 2
        $hp = Host-Record-Pid
        if ($hp -and $hp -ne $hostBefore.Id) { $hostAfter = Get-Process -Id $hp -ErrorAction SilentlyContinue }
    }
    if (-not $hostAfter) { $hostAfter = Get-Process -Id (Host-Record-Pid) -ErrorAction SilentlyContinue }
    if (-not $hostAfter) { Get-Content $hostLog -Tail 40 -ErrorAction SilentlyContinue; throw 'no live genie-host recorded in host.json after the update' }
    $hostAfterLine = Command-Line $hostAfter.Id
    $hostAfterExe = [string]$hostAfter.Path
    Write-Output ("genie-host after the update: pid " + $hostAfter.Id + ", started " + $hostAfter.StartTime + ", runs " + $hostAfterExe + ": " + $hostAfterLine)
    if ($hostAfter.Id -eq $hostBefore.Id) { throw "genie-host is still pid $($hostBefore.Id): the update did not swap the host" }
    if (Get-Process -Id $hostBefore.Id -ErrorAction SilentlyContinue) { throw "the old genie-host pid $($hostBefore.Id) is running again" }
    $said = Select-String -Path @($hostLog, $lifecycle) -Pattern 'updater: it has the install; this host exits' -SimpleMatch -ErrorAction SilentlyContinue
    if (-not $said) { Get-Content $hostLog -Tail 40 -ErrorAction SilentlyContinue; throw 'genie-host did not log a full install' }
    Write-Output ("the old host said: " + ($said | Select-Object -Last 1).Line)
    if ($hostAfterLine -notlike "*\host\$nextHostHash\dist\main\host.js*") { throw "the new genie-host does not run the update's copy (host\$nextHostHash): $hostAfterLine" }
    if ($hostAfterExe -notlike "$genieHome\host\runtime-*-host\genie-host.exe") { throw "the new genie-host does not run from the copied runtime: $hostAfterExe" }
    $marked = Select-String -Path $lifecycle -Pattern "host build mark: $mark" -SimpleMatch -ErrorAction SilentlyContinue
    if (-not $mark -or -not $marked) { throw "the new genie-host did not say the update's mark '$mark'" }
    Write-Output ("the new host said: " + ($marked | Select-Object -Last 1).Line)
    if (Test-Path (Join-Path $genieHome "host\$baseHostHash")) { throw "the base's copy host\$baseHostHash is still there" }

    Step 'the agent: drained, and back exactly once, under the new host'
    $deadline = (Get-Date).AddSeconds(60)
    $revived = @()
    while ((Get-Date) -lt $deadline -and $revived.Count -eq 0) {
        Start-Sleep 2
        $revived = @(Stub-Providers | Where-Object { $beforeIds -notcontains [int]$_.ProcessId })
    }
    # Time for a second start to show, if there is one.
    Start-Sleep 10
    $stubsNow = Stub-Providers
    $survivors = @($stubsNow | Where-Object { $beforeIds -contains [int]$_.ProcessId })
    $revived = @($stubsNow | Where-Object { $beforeIds -notcontains [int]$_.ProcessId })
    $stubsNow | ForEach-Object { Write-Output ("  provider: " + $_.ProcessId + " " + $_.Name + " parent " + $_.ParentProcessId + " started " + $_.CreationDate) }
    Write-Output ("providers from before still running: " + $survivors.Count + "; started since: " + $revived.Count)
    if ($survivors.Count -ne 0) { $survivors | ForEach-Object { Write-Output ("  survivor: " + $_.ProcessId + " " + $_.CommandLine) }; throw "$($survivors.Count) agent provider(s) from before survived the update" }
    if ($revived.Count -ne 1) {
        Write-Output "--- the new host's agent starts (lifecycle.log) ---"
        Select-String -Path $lifecycle -Pattern 'restore:|agent start|spawn kind=agent' -ErrorAction SilentlyContinue | Select-Object -Last 12 | ForEach-Object { '  ' + $_.Line }
        throw "the agent that was running came back $($revived.Count) times (want exactly 1)"
    }
    if (-not (Descends $revived[0].ProcessId $hostAfter.Id)) { throw "the agent came back as pid $($revived[0].ProcessId), not under the new genie-host $($hostAfter.Id)" }
    $spent = @(Json-Ids $runningAtQuit)
    if ($spent.Count -ne 0) { throw "the drain's record still names $($spent -join ', ') after the restore" }
    $helpers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'fancy-pty-helper*' -and $helpersBefore -contains [int]$_.ProcessId })
    Write-Output ("pty helpers from before the update still running: " + $helpers.Count)
    if ($helpers.Count -ne 0) { $helpers | ForEach-Object { Write-Output ("  survivor: " + $_.ProcessId + " " + $_.ExecutablePath) }; throw "$($helpers.Count) pty helper(s) survived the update" }

    Step 'tear down: the window, genie-host and what they started (scripts/end-own-tree.mjs), then uninstall'
    $script:ended = $true
    $rootArgs = @('--root', "$($hostAfter.Id)")
    foreach ($r in $script:relaunchedPids) { $rootArgs += @('--root', "$r") }
    node scripts/end-own-tree.mjs --since "$($script:began)" @rootArgs
    if ($LASTEXITCODE -ne 0) { throw 'the run left processes running (scripts/end-own-tree.mjs named them above)' }
    $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$installDir\*" })
    if ($left.Count) { throw "$($left.Count) process(es) survived" }
    Start-Process (Join-Path $installDir 'Uninstall Genie.exe') -ArgumentList '/S' -Wait
    Start-Sleep 2
    Write-Output ("install dir gone: " + (-not (Test-Path $exe)))

    Write-Output ""
    Write-Output "HOST UPDATE PROVEN: $current -> $Next, genie-host $($hostBefore.Id) ($baseHostHash) drained and replaced by $($hostAfter.Id) ($nextHostHash), the agent back once"
    Write-Output "### host-update=PASS"
} finally {
    if ($feed -and -not $feed.HasExited) { Kill-Tree $feed.Id }
    # A run that failed before its teardown ends what it started all the same: the windows it saw and genie-host.
    if ($script:began -and -not $script:ended) {
        $roots = @($script:relaunchedPids)
        if ($app) { $roots += $app.Id }
        $hp = Host-Record-Pid
        if ($hp) { $roots += $hp }
        $endArgs = @('--since', "$($script:began)")
        foreach ($r in $roots) { if ($r) { $endArgs += @('--root', "$r") } }
        if ($endArgs.Count -gt 2) { node scripts/end-own-tree.mjs @endArgs }
    }
    if ($script:userEnvSet) { [Environment]::SetEnvironmentVariable('GENIE2_CODEX_BINARY', $null, 'User') }
    Move-Item package.json.pristine package.json -Force
    Move-Item package-lock.json.pristine package-lock.json -Force
    Stop-Transcript | Out-Null
}
