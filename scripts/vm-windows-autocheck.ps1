# vm-windows-autocheck.ps1 — THE INSTALLED APP FINDS THE NEXT BUILD BY ITSELF. Runs INSIDE genie-test-windows (PowerShell 5.1).
#
#   .ai/sandbox/test-vm/run-with-watchdog.sh 25 genie-test-windows repos/genie2 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vm-windows-autocheck.ps1'
#
# genie2#91: 2.0.0-beta.5 never checked for updates unless asked, so an installed Genie 2 could not learn that the
# next build existed; v1 checked at boot. This proves the fix on the INSTALLED app against a real feed, with nobody
# calling check():
#   1. package the tree at its current version and install it silently
#   2. bump to -Next (the next prerelease number), package again → release\ holds Next + latest.yml; restore the bump
#   3. serve release\ on 127.0.0.1:8099; point the installed app's app-update.yml at it
#   4. launch the installed app with CDP; update-cdp.mjs in AUTO_CHECK mode waits for the state to become
#      `available` on its own, asserts the version, that nothing downloaded, and that the Deck shows the door
#   5. tear down and uninstall
param([string] $Next = '')
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
Start-Transcript -Path (Join-Path $root 'autocheck.log') -Force | Out-Null
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
function Genie-Processes($dir) { return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$dir\*" }) }
function Uninstall-AnyGenie() {
    foreach ($p in (Genie-Processes "$env:LOCALAPPDATA\Programs")) { Kill-Tree $p.Id }
    $keys = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue)
    foreach ($k in $keys) {
        $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
        if (-not $p.DisplayName -or -not ($p.DisplayName -eq 'Genie' -or $p.DisplayName -like 'Genie *')) { continue }
        $loc = [string]$p.InstallLocation
        $u = if ($loc) { Join-Path $loc 'Uninstall Genie.exe' } else { $null }
        Write-Output ("pre-clean: uninstalling " + $p.DisplayName + " " + $p.DisplayVersion + " at '" + $loc + "'")
        if ($u -and (Test-Path $u)) { Start-Process $u -ArgumentList '/S' -Wait; Start-Sleep 2 } else { Remove-Item $k.PSPath -Recurse -Force -ErrorAction SilentlyContinue }
    }
    foreach ($d in @("$env:LOCALAPPDATA\Programs\Genie", "$env:LOCALAPPDATA\Programs\genie2", "$env:LOCALAPPDATA\Programs\genie")) {
        if (Test-Path $d) { Write-Output "pre-clean: removing leftover $d"; Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
    }
    foreach ($k in @(Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^[0-9a-fA-F-]{36}$' })) {
        $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
        if ($p.InstallLocation -and ($p.InstallLocation -like '*\Programs\genie*' -or $p.InstallLocation -like '*\Programs\Genie*')) {
            Write-Output ("pre-clean: removing install-memory key HKCU\Software\" + $k.PSChildName + " (" + $p.InstallLocation + ")")
            Remove-Item $k.PSPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    foreach ($d in @("$env:USERPROFILE\.genie\runtime")) {
        if (Test-Path $d) { Write-Output "pre-clean: removing app data $d"; Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

$installDir = "$env:LOCALAPPDATA\Programs\Genie"
$exe = Join-Path $installDir 'Genie.exe'
$uninst = Join-Path $installDir 'Uninstall Genie.exe'
$current = (Get-Content package.json | ConvertFrom-Json).version
if (-not $Next) {
    # 2.0.0-beta.6 → 2.0.0-beta.7: the next prerelease number, so the feed's build sorts above the installed one.
    if ($current -match '^(.*?)(\d+)$') { $Next = $Matches[1] + ([int]$Matches[2] + 1) } else { throw "cannot derive the next version from $current" }
}
Write-Output "current $current -> next $Next"
$feed = $null
try {
    Step "package $current and install it"
    if (Test-Path release) { Remove-Item -Recurse -Force release }
    Run 'npm run build' 'build-current.log'
    Run 'npx electron-builder --publish never' 'package-current.log'
    $setup = @(Get-ChildItem "release\Genie-$current-setup.exe")[0]
    if (-not $setup) { throw "no release\Genie-$current-setup.exe" }
    Uninstall-AnyGenie
    $inst = Start-Process $setup.FullName -ArgumentList '/S' -Wait -PassThru
    Write-Output ("installer exit code: " + $inst.ExitCode)
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $exe)) { Start-Sleep 2 }
    if (-not (Test-Path $exe)) { throw "no $exe after the silent install (exit code $($inst.ExitCode))" }
    foreach ($p in (Genie-Processes $installDir)) { Kill-Tree $p.Id }

    Step "package $Next as the update"
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
    if ($latest -notmatch "version: $([regex]::Escape($Next))") { throw "latest.yml does not name $Next" }

    Step 'serve the feed, point the installed app at it'
    $feed = Start-Process -FilePath node -ArgumentList 'scripts\serve-feed.mjs', 'release', '8099' -PassThru `
        -RedirectStandardOutput feed.log -RedirectStandardError feed-err.log
    Start-Sleep 2
    $probe = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8099/latest.yml'
    Write-Output ("feed answers: " + $probe.StatusCode + " " + $probe.RawContentLength + " bytes")
    $cfg = Join-Path $installDir 'resources\app-update.yml'
    Set-Content -Path $cfg -Value "provider: generic`nurl: http://127.0.0.1:8099/`nupdaterCacheDirName: genie2-updater`n" -Encoding ascii

    Step "launch the installed $current; NOBODY asks it to check"
    $env:GENIE2_CODEX_BINARY = "$root\scripts\stub-codex.cmd"
    Run 'node scripts\smoke-seed.mjs'
    Remove-Item -Force -ErrorAction SilentlyContinue installed-out.log, installed-err.log
    $app = Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222' -PassThru `
        -RedirectStandardOutput installed-out.log -RedirectStandardError installed-err.log
    $env:EXPECT_VERSION = $Next
    $env:AUTO_CHECK = '1'
    Remove-Item Env:EXPECT_HELPERS -ErrorAction SilentlyContinue
    & cmd /c "node scripts\update-cdp.mjs 2>&1"
    $drive = $LASTEXITCODE
    Remove-Item Env:AUTO_CHECK -ErrorAction SilentlyContinue
    if ($drive -ne 0) {
        Write-Output "--- installed stderr ---"; Get-Content installed-err.log -Tail 60 -ErrorAction SilentlyContinue
        Write-Output "--- feed ---"; Get-Content feed.log -Tail 20 -ErrorAction SilentlyContinue
        if (-not $app.HasExited) { Kill-Tree $app.Id }
        throw "update-cdp.mjs (AUTO_CHECK) exited $drive"
    }
    Write-Output "--- feed requests (the app's own, unprompted) ---"; Get-Content feed.log -Tail 10 -ErrorAction SilentlyContinue

    Step 'tear down, uninstall'
    if (-not $app.HasExited) { Kill-Tree $app.Id }
    Start-Sleep 2
    foreach ($p in (Genie-Processes $installDir)) { Kill-Tree $p.Id }
    Start-Process $uninst -ArgumentList '/S' -Wait
    Start-Sleep 2
    Write-Output ("install dir gone: " + (-not (Test-Path $exe)))
    Write-Output ""
    Write-Output "VM AUTO-CHECK OK: the installed $current found $Next on the feed by itself, offered it in the Deck, downloaded nothing"
} finally {
    if ($feed -and -not $feed.HasExited) { Kill-Tree $feed.Id }
    Stop-Transcript | Out-Null
}
