# vm-client-only-update.ps1 — A CLIENT-ONLY UPDATE, PROVEN (Tynn #413, host split P6).
#
# Needs only Windows PowerShell 5.1, a logged-on Windows desktop session (the host's keychain, the window) and this
# repository checked out with `npm ci` run. It assumes no particular machine: from the checkout's root, in that session,
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vm-client-only-update.ps1
#
# It installs into the session user's %LOCALAPPDATA%\Programs\Genie, serves its feed on 127.0.0.1:8099, and uninstalls at the end.
#
# As vm-windows-update.ps1 (a LOCAL release: electron-builder's own latest.yml + installer, served by serve-feed.mjs), but the
# update carries THE SAME genie-host: $Next differs from $Base in its version only. Its latest.yml names that host
# (scripts/feed-host-identity.mjs, as the release does), so the installed Genie classifies it client-only. The row:
#
#   the same genie-host pid, and the same agent provider pids, before and after the update; no agent started again; the
#   installed Genie.exe is $Next; the host logged that only the window was updated; and THE AGENT STREAMED THROUGH IT
#   (Tynn #1036 P6-1): its provider is the stub in TICKER mode, mid-turn when install is asked, and a window of $Next on the
#   same host finds every tick streamed while there was no window in its ledger, in order (update-ticks-after-cdp.mjs).
#   Everything the run started is ended through scripts/end-own-tree.mjs (Tynn #1031), pass or fail.
#
#   UPDATE_TICKS_BREAK=stop-provider is the row's break probe: the provider is ended during the install, and the row fails
#   on the stream.
#
# If the two builds' host bundles differ (the version leaks into host.js), there is no client-only update to prove: the run
# stops and says so (### client-only=NOT-CLIENT-ONLY). Prints `### client-only=PASS` at the end; a failure throws.
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
    # electron-builder's NSIS remembers the install directory in a SECOND key, HKCU\Software\<appId
    # GUID>\InstallLocation, and every later installer with the same appId goes where it says
    # (measured 2026-10-10: Uninstall entry and directories gone, the next install still landed
    # in Programs\genie2 because this key said so).
    foreach ($k in @(Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^[0-9a-fA-F-]{36}$' })) {
        $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
        if ($p.InstallLocation -and ($p.InstallLocation -like '*\Programs\genie*' -or $p.InstallLocation -like '*\Programs\Genie*')) {
            Write-Output ("pre-clean: removing install-memory key HKCU\Software\" + $k.PSChildName + " (" + $p.InstallLocation + ")")
            Remove-Item $k.PSPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
function Genie-Processes($dir) { return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$dir\*" }) }
# Put back whatever happens, after the `finally` below has ended the feed.
Copy-Item package.json package.json.pristine -Force
Copy-Item package-lock.json package-lock.json.pristine -Force
$current = $Base
$feed = $null
$script:began = $null
$script:ended = $false
$script:viewer = $null
$script:relaunchedPids = @()
$ticker = Join-Path ([System.IO.Path]::GetTempPath()) 'genie-stub-codex-ticker'
try {
    Run "npm version $Base --no-git-tag-version --allow-same-version" 'bump-base.log'
    Step "package $current and install it"
    if (Test-Path release) { Remove-Item -Recurse -Force release }
    Run 'npm run build' 'build-current.log'
    $baseHostHash = (Get-FileHash -Algorithm SHA256 'dist\main\host.js').Hash.ToLower().Substring(0, 12)
    Write-Output ("the base build's genie-host: " + $baseHostHash)
    Run 'npx electron-builder --publish never --config.win.signExecutable=false' 'package-current.log'
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
        Run 'npx electron-builder --publish never --config.win.signExecutable=false' 'package-next.log'
    } finally {
        Move-Item package.json.orig package.json -Force
        Move-Item package-lock.json.orig package-lock.json -Force
    }
    $nextSetup = @(Get-ChildItem "release\Genie-$Next-setup.exe")[0]
    if (-not $nextSetup) { throw "no release\Genie-$Next-setup.exe" }
    $nextHostHash = (Get-FileHash -Algorithm SHA256 'dist\main\host.js').Hash.ToLower().Substring(0, 12)
    Write-Output ("the update's genie-host: " + $nextHostHash)
    if ($nextHostHash -ne $baseHostHash) { Write-Output '### client-only=NOT-CLIENT-ONLY'; throw "the two builds carry different hosts ($baseHostHash, $nextHostHash): the version reaches host.js, so no update is client-only" }
    Run 'node scripts\feed-host-identity.mjs release\latest.yml' 'feed-host.log'
    $latest = Get-Content release\latest.yml -Raw
    if ($latest -notmatch "genieHostHash: '$baseHostHash'") { throw 'latest.yml does not name the host' }
    Write-Output "latest.yml:"; Write-Output $latest
    if ($latest -notmatch "version: $([regex]::Escape($Next))") { throw "latest.yml does not name $Next" }

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
    Write-Output "app-update.yml as shipped:"; Get-Content $cfg
    Set-Content -Path $cfg -Value "provider: generic`nurl: http://127.0.0.1:8099/`nupdaterCacheDirName: genie2-updater`n" -Encoding ascii
    Write-Output "app-update.yml now:"; Get-Content $cfg

    Step "launch the installed $current and drive the update"
    $env:GENIE2_CODEX_BINARY = "$root\scripts\stub-codex.mjs"
    $env:GENIE_PAGE_PROBE = '1'
    # STREAMING THROUGH THE INSTALL (Tynn #1036 P6-1): the stub provider in TICKER mode, switched on by a marker holding this
    # script's pid (scripts/stub-codex.mjs reads it when a provider starts), and where the agent's ledger stood when install
    # was asked, written by update-cdp.mjs.
    Set-Content -Path $ticker -Value "$PID" -Encoding ascii -NoNewline
    $env:UPDATE_TICKS_FILE = Join-Path $root 'update-ticks.json'
    Remove-Item -Force -ErrorAction SilentlyContinue $env:UPDATE_TICKS_FILE
    $script:began = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    # THE SEED'S WORKSPACE IS A NEW DIRECTORY, NEVER THE CHECKOUT (the full gate 1124-020718-168937): smoke-seed.mjs takes its
    # cwd as the workspace, and in a gate shard earlier rows have seeded the checkout and changed its project.json, so a seed of
    # it is refused. The home stays the session's own: the installer installs for the signed-in user, whatever the variables say.
    $workspace = Join-Path ([System.IO.Path]::GetTempPath()) ("genie-update-workspace-" + $PID)
    if (Test-Path $workspace) { Remove-Item -Recurse -Force $workspace }
    New-Item -ItemType Directory -Force $workspace | Out-Null
    Push-Location $workspace
    try { & node (Join-Path $root 'scripts\smoke-seed.mjs'); $seedExit = $LASTEXITCODE } finally { Pop-Location }
    if ($seedExit -ne 0) { throw "the seed failed in $workspace (exit $seedExit)" }
    Remove-Item -Force -ErrorAction SilentlyContinue installed-out.log, installed-err.log
    $app = Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222' -PassThru `
        -RedirectStandardOutput installed-out.log -RedirectStandardError installed-err.log
    $env:EXPECT_VERSION = $Next
    # With fancy-pty installed, the driver's §7.2 control (one open terminal → one helper under
    # the install dir) is asserted, not merely reported.
    Remove-Item Env:EXPECT_HELPERS -ErrorAction SilentlyContinue
    # The host the update must leave running: recorded before anything is asked of the updater.
    $hostRecord = Join-Path $env:USERPROFILE '.genie\runtime\host.json'
    $deadline = (Get-Date).AddSeconds(90)
    $hostBefore = $null
    while ((Get-Date) -lt $deadline -and -not $hostBefore) {
        Start-Sleep 2
        try { $hostBefore = Get-Process -Id (Get-Content $hostRecord -Raw | ConvertFrom-Json).pid -ErrorAction Stop } catch { $hostBefore = $null }
    }
    if (-not $hostBefore) { throw 'no live genie-host recorded in host.json before the update' }
    Write-Output ("genie-host before the update: pid " + $hostBefore.Id + ", started " + $hostBefore.StartTime)
    & cmd /c "node scripts\update-cdp.mjs 2>&1"
    $drive = $LASTEXITCODE
    if ($drive -ne 0) {
        # 200 lines, not 60: the first fancy-pty failure's engine words (if any) were above a
        # 60-line tail that showed only the updater's download notice (Fancy asked for this).
        Write-Output "--- installed stderr ---"; Get-Content installed-err.log -Tail 200 -ErrorAction SilentlyContinue
        Write-Output "--- installed stdout ---"; Get-Content installed-out.log -Tail 80 -ErrorAction SilentlyContinue
        Write-Output "--- feed ---"; Get-Content feed.log -Tail 20 -ErrorAction SilentlyContinue
        if (-not $app.HasExited) { Kill-Tree $app.Id }
        throw "update-cdp.mjs exited $drive"
    }
    # THE ROW'S BREAK PROBE: the stream interrupted during the install (its provider ended), which the row must fail on. From
    # UPDATE_TICKS_BREAK, or update-ticks-break.txt at the root (In-Session passes no environment, as ci-rows.txt says).
    $breakFile = Join-Path $root 'update-ticks-break.txt'
    $break = if ($env:UPDATE_TICKS_BREAK) { $env:UPDATE_TICKS_BREAK } elseif (Test-Path $breakFile) { (Get-Content $breakFile -Raw).Trim() } else { '' }
    if ($break -eq 'stop-provider') {
        foreach ($s in @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*stub-codex.mjs*' })) {
            Write-Output ("BREAK PROBE: ending the provider, pid " + $s.ProcessId + ", during the install")
            Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
        }
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

    # THE ROW (Tynn #413): the same host, and the same agent, through the update.
    $relaunchAt = ($relaunched | ForEach-Object { $_.StartTime } | Sort-Object | Select-Object -First 1)
    $script:relaunchedPids = @($relaunched | ForEach-Object { $_.Id })
    Write-Output ("the window came back on its own at " + $relaunchAt + ": pid(s) " + ($script:relaunchedPids -join ', '))

    # THE CONVERSATION, CONTINUING (Tynn #1036 P6-1): the installer starts the window with no debugger port, so that window
    # is ended by its tree (genie-host and its providers are not in it) and $Next opened again with one, over the same host.
    Step "the agent's ledger, in a window of $Next"
    foreach ($p in $relaunched) { Kill-Tree $p.Id }
    Start-Sleep 3
    $script:viewer = Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222' -PassThru `
        -RedirectStandardOutput viewer-out.log -RedirectStandardError viewer-err.log
    & cmd /c "node scripts\update-ticks-after-cdp.mjs 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "the agent's stream did not run through the install (update-ticks-after-cdp.mjs exited $LASTEXITCODE)" }
    Start-Sleep 15
    $hostAfter = $null
    try { $hostAfter = Get-Process -Id (Get-Content $hostRecord -Raw | ConvertFrom-Json).pid -ErrorAction Stop } catch { $hostAfter = $null }
    if (-not $hostAfter) { throw 'no live genie-host recorded in host.json after the update' }
    Write-Output ("genie-host after the update: pid " + $hostAfter.Id + ", started " + $hostAfter.StartTime + "; the window relaunched at " + $relaunchAt)
    if ($hostAfter.Id -ne $hostBefore.Id -or $hostAfter.StartTime -ne $hostBefore.StartTime) { throw "genie-host changed: pid $($hostBefore.Id) before, $($hostAfter.Id) after" }
    # The stub provider runs under genie-host's own executable as Node (ELECTRON_RUN_AS_NODE, session-host.ts providerLaunchOptions),
    # never node.exe: found by its script, whatever runs it (measured: a node.exe filter found 0 while the agent ran).
    $stubs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*stub-codex.mjs*' })
    $stubs | ForEach-Object { Write-Output ("  provider: " + $_.ProcessId + " " + $_.Name + " parent " + $_.ParentProcessId + " started " + $_.CreationDate + " path " + $_.ExecutablePath) }
    $kept = @($stubs | Where-Object { $_.CreationDate -lt $relaunchAt })
    $restarted = @($stubs | Where-Object { $_.CreationDate -ge $relaunchAt })
    Write-Output ("agent providers from before the update still running: " + $kept.Count + "; started since: " + $restarted.Count)
    $kept | ForEach-Object { Write-Output ("  kept: " + $_.ProcessId + " started " + $_.CreationDate) }
    if ($kept.Count -lt 1) { throw 'the agent that was running did not keep running through the update' }
    if ($restarted.Count -ne 0) { throw "$($restarted.Count) agent provider(s) were started again: the agent was restarted, not kept" }
    $hostLog = Join-Path $env:USERPROFILE '.genie\logs\genie-host.log'
    $said = Select-String -Path @($hostLog, (Join-Path $env:USERPROFILE '.genie\runtime\lifecycle.log')) -Pattern 'only the window is updated, so this host stays' -ErrorAction SilentlyContinue
    if (-not $said) { Get-Content $hostLog -Tail 40 -ErrorAction SilentlyContinue; throw 'genie-host did not log a client-only install' }
    Write-Output ("genie-host said: " + ($said | Select-Object -Last 1).Line)

    Step 'tear down: the window, genie-host and what they started (scripts/end-own-tree.mjs), then uninstall'
    $script:ended = $true
    node scripts/end-own-tree.mjs --since "$($script:began)" --tree "$($script:viewer.Id)" --root "$($hostAfter.Id)"
    if ($LASTEXITCODE -ne 0) { throw 'the run left processes running (scripts/end-own-tree.mjs named them above)' }
    $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$installDir\*" })
    if ($left.Count) { throw "$($left.Count) process(es) survived" }
    Start-Process (Join-Path $installDir 'Uninstall Genie.exe') -ArgumentList '/S' -Wait
    Start-Sleep 2
    Write-Output ("install dir gone: " + (-not (Test-Path $exe)))

    Write-Output ""
    Write-Output "CLIENT-ONLY UPDATE PROVEN: $current -> $Next, genie-host pid $($hostBefore.Id) and the agent kept running through it"
    Write-Output "### client-only=PASS"
} finally {
    if ($feed -and -not $feed.HasExited) { Kill-Tree $feed.Id }
    Remove-Item -Force -ErrorAction SilentlyContinue $ticker
    # A run that failed before its teardown ends what it started all the same: the windows it saw and genie-host.
    if ($script:began -and -not $script:ended) {
        $roots = @($script:relaunchedPids)
        if ($app) { $roots += $app.Id }
        if ($script:viewer) { $roots += $script:viewer.Id }
        try { $hp = (Get-Content (Join-Path $env:USERPROFILE '.genie\runtime\host.json') -Raw | ConvertFrom-Json).pid; if ($hp) { $roots += $hp } } catch { }
        $endArgs = @('--since', "$($script:began)")
        foreach ($r in $roots) { if ($r) { $endArgs += @('--root', "$r") } }
        if ($endArgs.Count -gt 2) { node scripts/end-own-tree.mjs @endArgs }
    }
    Move-Item package.json.pristine package.json -Force
    Move-Item package-lock.json.pristine package-lock.json -Force
    Stop-Transcript | Out-Null
}
