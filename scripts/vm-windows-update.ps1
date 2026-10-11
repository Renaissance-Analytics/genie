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
$current = (Get-Content package.json | ConvertFrom-Json).version
$feed = $null
try {
    Step "package $current and install it"
    if (Test-Path release) { Remove-Item -Recurse -Force release }
    Run 'npm run build' 'build-current.log'
    Run 'npx electron-builder --publish never' 'package-current.log'
    $setup = @(Get-ChildItem "release\Genie-$current-setup.exe")[0]
    if (-not $setup) { throw "no release\Genie-$current-setup.exe" }
    if (Test-Path $uninst) { Start-Process $uninst -ArgumentList '/S' -Wait; Start-Sleep 2 }
    Start-Process $setup.FullName -ArgumentList '/S' -Wait
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
