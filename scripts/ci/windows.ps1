<#
GENIE'S WINDOWS CI, ON OUR OWN MACHINE (Tynn issue #692; the owner, 2026-11-11: "ALL CI IS LOCAL OR IN AZURE").

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\windows.ps1                 every row, in ci.yml's order
    ... -File scripts\ci\windows.ps1 -Only unit,smoke                                           only these rows
    ... -File scripts\ci\windows.ps1 -From local-door                                           this row and every row after it
    ... -File scripts\ci\windows.ps1 -List                                                      the row names, in order

ON AN AZURE WINDOWS VM (the envelope's scripts/azure/run-job.sh), as the standard user `genie`, never an Administrator.
The window rows need the person's desktop (Electron windows, Credential Manager), so the whole script runs in genie's
logged-on session. A job file of one line does it:

    In-Session scripts/ci/windows.ps1 150

In-Session passes no arguments, so a run that wants fewer rows writes them first, in the same job file:

    Set-Content ci-rows.txt '-Only unit,smoke'; In-Session scripts/ci/windows.ps1 60

NEVER on a person's desktop: the rows open real windows, start real hosts, write to ~\.genie and end processes.

Each row is a step of ci.yml's Windows jobs (`unit (windows)`, `a real window (windows)`, the Windows leg of `it
packages`), with the same command, and it passes or fails on the same thing. One line per row, `ROW <name> PASS|FAIL
<seconds>`, then `CI WINDOWS PASS|FAIL`; the exit code is 1 when any row failed. A row's whole output is in
ci-out\<name>.log, and its end is printed when it fails. A failed row does not stop the run.

WHERE IT DIFFERS FROM ci.yml, and why:
  - GitHub's runner set CI=true, and the row scripts took it as "this is a test machine". Here the machine says so
    itself (Declare-TestMachine): its user is `genie`, the test VMs' user, or GENIE_TEST_MACHINE=1 was given. CI is
    not set.
  - GitHub's Windows runner runs as Administrator; this runs as a standard user, as a person does.
  - flows and zip64 have no Windows job in ci.yml, so they are not here either.

Windows PowerShell 5.1 runs it (In-Session starts .ps1 files with powershell.exe): nothing here needs PowerShell 7.
#>
param(
    [string]$Only = '',
    [string]$From = '',
    [switch]$List
)
$ErrorActionPreference = 'Continue'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..'))
$Repo = (Get-Location).Path
$Out = Join-Path $Repo 'ci-out'

$Rows = @(
    'unit-build', 'unit',
    'build', 'seed', 'no-pty', 'smoke', 'layout', 'app-stopped',
    'local-door-break', 'local-door', 'files-watch', 'chat-drafts', 'gapp-open', 'artboard', 'ui-lag',
    'trust-step', 'spawn-host', 'safe-mode', 'hang', 'renderer-crash',
    'package', 'sign-plan', 'packed-tree', 'update-metadata', 'package-fuse', 'packaged-launcher'
)

if ($List) { $Rows | ForEach-Object { Write-Output $_ }; exit 0 }

# The arguments In-Session could not pass, from the file the job wrote.
$argsFile = Join-Path $Repo 'ci-rows.txt'
if (-not $Only -and -not $From -and (Test-Path $argsFile)) {
    $line = (Get-Content $argsFile -Raw).Trim()
    if ($line -match '^-Only\s+(\S+)$') { $Only = $Matches[1] }
    elseif ($line -match '^-From\s+(\S+)$') { $From = $Matches[1] }
    else { Write-Output "ci-rows.txt says '$line': it must be '-Only <row,row>' or '-From <row>'"; exit 64 }
    Write-Output "--- rows from ci-rows.txt: $line"
}

$selected = @()
if ($Only) {
    $asked = $Only -split ','
    foreach ($r in $asked) { if ($Rows -notcontains $r) { Write-Output "no such row: $r (see -List)"; exit 64 } }
    $selected = @($Rows | Where-Object { $asked -contains $_ })
} elseif ($From) {
    if ($Rows -notcontains $From) { Write-Output "no such row: $From (see -List)"; exit 64 }
    $selected = @($Rows[([array]::IndexOf($Rows, $From))..($Rows.Count - 1)])
} else {
    $selected = $Rows
}

New-Item -ItemType Directory -Force $Out | Out-Null
$script:Failed = @()
$script:Notes = @()
$script:Blocked = ''

# A need that failed says why once; each row that needed it says `not run: <why>` on its ROW line.
function Block([string]$why) { $script:Blocked = $why; Write-Output "--- $why"; throw "NOT RUN: $why" }

# A native command's exit code as a row's result: a non-zero exit ends the row, with the command named.
function Run([string]$what, [scriptblock]$cmd) {
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

# THIS IS A TEST MACHINE, SAID ONCE AND ONLY WHEN IT IS TRUE. Each window row script refuses to run anywhere else, each
# with its own variable; GitHub's CI=true used to satisfy them all. They are set here from one statement: the user is
# `genie` (the Azure test VMs' standard user), or GENIE_TEST_MACHINE=1 was given by whoever started the run.
function Declare-TestMachine {
    if ($env:GENIE_TEST_MACHINE -ne '1') {
        if ($env:USERNAME -ne 'genie') { Block "not a test machine (user $env:USERNAME): the window rows run only on one; GENIE_TEST_MACHINE=1 says this machine is" }
        $env:GENIE_TEST_MACHINE = '1'
        Write-Output '--- a test machine: its user is genie'
    }
    foreach ($v in 'LOCAL_DOOR_CDP_ALLOW', 'GENIE_FILES_MEASURE_ALLOW', 'GENIE_DRAFTS_MEASURE_ALLOW', 'GENIE_ARTBOARD_MEASURE_ALLOW', 'GENIE_UI_LAG_ALLOW', 'CRASH_CDP_ALLOW', 'QUIT_CDP_ALLOW', 'SITE_PANEL_CDP_ALLOW', 'BROWSER_PROCESS_CDP_ALLOW') {
        Set-Item -Path "env:$v" -Value '1'
    }
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Write-Output "--- running as $env:USERDOMAIN\$env:USERNAME, elevated: $admin"
    if ($admin) { $script:Notes += 'this run was ELEVATED (an Administrator token): a person is not; the rows measured an administrator' }
}

$script:Installed = ''
function Need-Install {
    if ($script:Installed -eq 'ok') { return }
    if ($script:Installed) { Block $script:Installed }
    $script:Installed = 'npm ci failed'
    Write-Output "--- node $(node --version), npm $(npm --version), $((Get-CimInstance Win32_OperatingSystem).Caption) $((Get-CimInstance Win32_OperatingSystem).BuildNumber)"
    npm ci --no-audit --no-fund *> (Join-Path $Out 'npm-ci.log')
    if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $Out 'npm-ci.log') -Tail 40; Block $script:Installed }
    $script:Installed = 'ok'
}

$script:Built = ''
function Need-Build {
    if ($script:Built -eq 'ok') { return }
    if ($script:Built) { Block $script:Built }
    Need-Install
    $script:Built = 'the build failed'
    npm run build *> (Join-Path $Out 'build.log')
    if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $Out 'build.log') -Tail 40; Block $script:Built }
    $script:Built = 'ok'
}

$script:Machine = ''
function Need-TestMachine {
    if ($script:Machine -eq 'ok') { return }
    if ($script:Machine) { Block $script:Machine }
    $script:Machine = 'not a test machine'
    Declare-TestMachine
    $script:Machine = 'ok'
}

# THE APP, OPENED ONCE for the rows from no-pty to layout, as ci.yml's "open the app and drive it" step, and stopped by
# app-stopped (which fails when any of its electron processes outlives the stop, as that step did).
$script:App = $null
$script:AppState = ''
function Need-App {
    if ($script:AppState -eq 'ok') { return }
    if ($script:AppState) { Block $script:AppState }
    Need-Build; Need-TestMachine
    $script:AppState = 'the seed could not be written'
    if (-not (Test-Path (Join-Path $Out 'seed.done'))) {
        node scripts/smoke-seed.mjs *> (Join-Path $Out 'seed.out')
        if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $Out 'seed.out') -Tail 20; Block $script:AppState }
        Set-Content (Join-Path $Out 'seed.done') ''
    }
    $env:GENIE2_CODEX_BINARY = "$Repo\scripts\stub-codex.mjs"
    $env:GENIE_PAGE_PROBE = '1'
    $script:App = Start-Process -FilePath 'npx.cmd' -ArgumentList 'electron', '.', '--remote-debugging-port=9222' -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $Out 'electron-out.log') -RedirectStandardError (Join-Path $Out 'electron-err.log')
    Write-Output "--- the app is starting (pid $($script:App.Id))"
    $waited = 0
    while ($true) {
        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:9222/json/version' | Out-Null; break } catch { }
        if ($script:App.HasExited) { $script:AppState = "the app ended before it opened a window (exit $($script:App.ExitCode)): see ci-out\electron-err.log"; Block $script:AppState }
        if ($waited -ge 90) { $script:AppState = 'the app did not answer on its debugger port (9222) within 90 s'; Block $script:AppState }
        Start-Sleep -Seconds 1; $waited++
    }
    Write-Output "--- the app answers on 9222 after $waited s"
    $script:AppState = 'ok'
}

function Stop-App {
    if (-not $script:App) { return 0 }
    $before = @(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Repo*" })
    Write-Output "electron processes from this checkout before stopping the app: $($before.Count)"
    if (-not $script:App.HasExited) { taskkill /PID $script:App.Id /T /F *> $null }
    $ours = @(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Repo*" })
    Write-Output "electron processes from this checkout still running after the tree kill: $($ours.Count)"
    $ours | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $script:App = $null
    $script:AppState = 'the app was stopped (app-stopped); the rows that drive it run before that row'
    $left = @(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Repo*" })
    return $left.Count
}

# --- the rows: each throws on failure ---------------------------------------------------------------------------------

function Row-unit-build { Need-Install; Run 'npm run build:main' { npm run build:main } }

# The Windows suite, with its sampler beside it and the 30 s per-test budget ci.yml gives it (the Windows runner is
# slower to start processes); the slow-test table after it, observe only.
function Row-unit {
    Need-Install
    $samples = Join-Path $Out 'proc-samples.log'
    $results = Join-Path $Out 'vitest-results.json'
    $shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
    $sampler = Start-Process $shell -ArgumentList '-NoProfile', '-File', 'scripts/ci/proc-sampler.ps1', '-Out', $samples -PassThru -WindowStyle Hidden
    try {
        npm test -- --testTimeout=30000 --reporter=default --reporter=json "--outputFile.json=$results"
        $code = $LASTEXITCODE
    } finally {
        Stop-Process -Id $sampler.Id -Force -ErrorAction SilentlyContinue
    }
    if ($code -ne 0) { node scripts/ci/proc-sampler-summary.mjs $samples $results }
    node scripts/ci/slow-tests.mjs $results (Join-Path $Out 'slow-tests.tsv')
    if ($code -ne 0) { throw "npm test failed (exit $code)" }
}

function Row-build { Need-Build }
function Row-seed { Need-App }
function Row-no-pty { Need-App; Run 'agents-hold-no-pty-cdp' { node scripts/agents-hold-no-pty-cdp.mjs } }
function Row-smoke { Need-App; Run 'smoke-cdp' { node scripts/smoke-cdp.mjs } }
function Row-layout { Need-App; Run 'layout-sweep' { node scripts/layout-sweep.mjs } }
function Row-app-stopped {
    if (-not $script:App) { Block 'the app was not opened in this run (no row before this one opened it)' }
    $left = Stop-App
    if ($left -gt 0) { throw "the app is still running after the row stopped it ($left electron processes)" }
}

# THE ADMISSION BREAK CONTROL: the door's own check broken on purpose must fail row 1 with the refusal's words.
function Row-local-door-break {
    Need-Build; Need-TestMachine
    $log = Join-Path $Out 'local-door-break.out'
    node scripts/local-door-cdp.mjs --break-admission *> $log
    $probe = $LASTEXITCODE
    Get-Content $log
    if ($probe -ne 1 -or -not (Select-String -Path $log -Pattern 'FAIL 1:' -Quiet) -or -not (Select-String -Path $log -Pattern 'actual refusal:.*not an admitted' -Quiet)) { throw "the admission break control did not fail as it must (exit $probe)" }
}
# Exit 2 is "some rows could not be measured here": recorded as INCOMPLETE, as ci.yml did, and not a failure.
function Row-local-door {
    Need-Build; Need-TestMachine
    node scripts/local-door-cdp.mjs
    $code = $LASTEXITCODE
    if ($code -eq 2) { $script:Notes += 'local-door is INCOMPLETE (exit 2): see the UNMEASURED rows in ci-out\local-door.log'; return }
    if ($code -ne 0) { throw "local-door-cdp failed (exit $code)" }
}
function Row-files-watch { Need-Build; Need-TestMachine; Run 'files-watch-cdp' { node scripts/files-watch-cdp.mjs } }
function Row-chat-drafts { Need-Build; Need-TestMachine; Run 'chat-drafts-cdp' { node scripts/chat-drafts-cdp.mjs } }
function Row-gapp-open { Need-Build; Need-TestMachine; Run 'gapp-open-cdp' { node scripts/gapp-open-cdp.mjs } }
function Row-artboard { Need-Build; Need-TestMachine; Run 'artboard-cdp' { node scripts/artboard-cdp.mjs --trace-main } }
function Row-ui-lag { Need-Build; Need-TestMachine; Run 'ui-lag-cdp' { node scripts/ui-lag-cdp.mjs --budget } }
function Row-trust-step { Need-Build; Need-TestMachine; Run 'trust-step-cdp' { node scripts/trust-step-cdp.mjs } }
# The app opened for no-pty..layout wrote this log: the spawn host started, and never fell back.
function Row-spawn-host {
    $log = Join-Path $HOME '.genie\runtime\lifecycle.log'
    if (-not (Test-Path $log)) { Block 'no lifecycle.log: the app was not opened in this run (the seed row opens it)' }
    Select-String -Path $log -Pattern 'spawn host' | Select-Object -Last 5 | ForEach-Object { $_.Line }
    if (-not (Select-String -Path $log -Pattern 'spawn host ready pid=' -Quiet)) { throw 'no "spawn host ready" in lifecycle.log' }
    if (Select-String -Path $log -Pattern 'spawn host could not start' -Quiet) { throw '"spawn host could not start" in lifecycle.log' }
}
function Row-safe-mode { Need-Build; Need-TestMachine; Run 'safe-mode-cdp' { node scripts/safe-mode-cdp.mjs } }
function Row-hang { Need-Build; Need-TestMachine; Run 'hang-cdp' { node scripts/hang-cdp.mjs } }
function Row-renderer-crash { Need-Build; Need-TestMachine; Run 'renderer-crash-cdp' { node scripts/renderer-crash-cdp.mjs } }

# IT PACKAGES, the Windows leg: the installers built unsigned, then what ci.yml checked in what was packaged.
function Row-package {
    Need-Build
    Run 'fetch-caddy' { npx tsx scripts/fetch-caddy.ts }
    Run 'electron-builder' { npx electron-builder --publish never --config.win.signExecutable=false }
}
function Need-Packaged { if (-not (Test-Path 'release\win-unpacked')) { Block 'nothing was packaged (no release\win-unpacked): see the package row' } }
function Row-sign-plan { Need-Packaged; Run 'win-sign-plan --check' { node scripts/win-sign-plan.mjs release/win-unpacked electron-builder.yml --check } }
function Row-packed-tree { Need-Packaged; Run 'packed-tree-check' { node scripts/packed-tree-check.mjs release/win-unpacked } }
function Row-update-metadata { Need-Packaged; Run 'verify-windows-update' { node scripts/verify-windows-update.cjs release test/fixtures/windows-update-beta59.json } }
function Row-package-fuse {
    Need-Packaged
    $app = @(Get-ChildItem release\win-unpacked\*.exe)[0].FullName
    npx --yes @electron/fuses read --app "$app" | Tee-Object -FilePath (Join-Path $Out 'fuses.txt')
    if (-not (Select-String -Path (Join-Path $Out 'fuses.txt') -Pattern 'EnableCookieEncryption is Enabled' -Quiet)) { throw 'the cookie fuse is not on in what was packaged' }
}
# The packaged app starts genie-host through genie-launch.exe, from its copy, with its supervisor ready. ci.yml's step,
# command for command, on a home of its own under ci-out.
function Row-packaged-launcher {
    Need-Packaged
    $saved = @{ USERPROFILE = $env:USERPROFILE; HOME = $env:HOME; APPDATA = $env:APPDATA; LOCALAPPDATA = $env:LOCALAPPDATA }
    try {
        $launcher = "release\win-unpacked\resources\bin\genie-launch.exe"
        if (-not (Test-Path $launcher)) { throw "genie-launch.exe is not in the packaged app ($launcher)" }
        Write-Output "packaged: $launcher ($((Get-Item $launcher).Length) bytes)"
        $h = Join-Path $Out "packaged-home"
        foreach ($d in @("$h\AppData\Roaming", "$h\AppData\Local")) { New-Item -ItemType Directory -Force $d | Out-Null }
        $env:USERPROFILE = $h; $env:HOME = $h; $env:APPDATA = "$h\AppData\Roaming"; $env:LOCALAPPDATA = "$h\AppData\Local"
        # AS AN INSTALLED GENIE IS (beta.61, measured on an install): the app's archive lists prism-acp's supervisor for both
        # architectures, and the install holds only this machine's, in an otherwise empty folder for the other. win-unpacked
        # holds both, so the other is removed here, or this check cannot see what an installed Genie does.
        $otherArch = "release\win-unpacked\resources\app.asar.unpacked\node_modules\@particle-academy\prism-acp\native\win32-arm64\prism-acp-supervisor.exe"
        if (-not (Test-Path $otherArch)) { throw "the other architecture's supervisor is not in win-unpacked ($otherArch): this check no longer matches an install" }
        Remove-Item -Force $otherArch
        $app = Start-Process -FilePath (Resolve-Path "release\win-unpacked\Genie.exe") -PassThru
        $log = "$h\.genie\runtime\lifecycle.log"
        $line = $null
        for ($i = 0; $i -lt 90 -and -not $line; $i++) { Start-Sleep -Seconds 1; if (Test-Path $log) { $line = Select-String -Path $log -Pattern "host spawn via=" | Select-Object -Last 1 } }
        # A SPAWN IS NOT A HOST (Tynn #597): the window's own link to it says the host loaded and answered. Read before anything is killed.
        $up = $null
        for ($i = 0; $i -lt 90 -and $line -and -not $up; $i++) { Start-Sleep -Seconds 1; $up = Select-String -Path $log -Pattern "agent host (started|replaced|adopted) pid=" | Select-Object -Last 1 }
        $hostLog = "$h\.genie\logs\genie-host.log"
        if (-not $up) { Write-Output "--- lifecycle.log"; if (Test-Path $log) { Get-Content $log -Tail 30 }; Write-Output "--- genie-host.log"; if (Test-Path $hostLog) { Get-Content $hostLog -Tail 40 } }
        $hostJson = "$h\.genie\runtime\host.json"
        # THE HOST RUNS FROM ITS COPY, WITH ITS SUPERVISOR (beta.61's blocker): the copy was made, the host's process is in
        # it, and the host said its supervisor is ready, naming a file in the copy. Read before anything is killed.
        $copyFailed = if (Test-Path $log) { Select-String -Path $log -SimpleMatch "the copy could not be made" | Select-Object -Last 1 } else { $null }
        $hostPath = $null
        if (Test-Path $hostJson) { $hp = (Get-Content $hostJson | ConvertFrom-Json).pid; if ($hp) { $hostPath = (Get-Process -Id $hp -ErrorAction SilentlyContinue).Path } }
        $ready = $null
        for ($i = 0; $i -lt 60 -and $up -and -not $ready; $i++) { $ready = Select-String -Path $log -SimpleMatch "containment ready supervisor=" | Select-Object -Last 1; if (-not $ready) { Start-Sleep -Seconds 1 } }
        $unready = if (Test-Path $log) { Select-String -Path $log -SimpleMatch "containment unready" | Select-Object -Last 1 } else { $null }
        if (Test-Path $hostJson) { $hp = (Get-Content $hostJson | ConvertFrom-Json).pid; if ($hp) { Stop-Process -Id $hp -Force -ErrorAction SilentlyContinue } }
        if (-not $app.HasExited) { taskkill /PID $app.Id /T /F *> $null }
        if (-not $line) { throw "the packaged app logged no host spawn within 90 s" }
        Write-Output "the packaged app: $($line.Line)"
        if ($line.Line -notmatch "via=genie-launch") { throw "the packaged app started genie-host WITHOUT genie-launch.exe" }
        if (-not $up) { throw "the packaged app's genie-host did not come up within 90 s of its spawn (see genie-host.log above)" }
        Write-Output "the packaged app: $($up.Line)"
        if ($copyFailed) { throw "the packaged app could not make genie-host's copy: $($copyFailed.Line)" }
        Write-Output "genie-host runs from: $hostPath"
        if (-not $hostPath -or -not $hostPath.StartsWith("$h\.genie\host\", [System.StringComparison]::OrdinalIgnoreCase)) { throw "genie-host is not running from its copy under $h\.genie\host\ (it runs from '$hostPath')" }
        if ($unready) { throw "genie-host's supervisor is not ready: $($unready.Line)" }
        if (-not $ready) { throw "genie-host did not say its supervisor is ready within 60 s" }
        Write-Output "the packaged app: $($ready.Line)"
        if ($ready.Line -notmatch [regex]::Escape("$h\.genie\host\")) { throw "genie-host's supervisor is not in its copy: $($ready.Line)" }
        # taskkill above sets $LASTEXITCODE (part of the tree already gone), and the step's result is the last exit code:
        # 3 of ~20 runs failed after both checks printed. Every failure above has thrown, so reaching here is a pass.
    } finally {
        foreach ($k in $saved.Keys) { Set-Item -Path "env:$k" -Value $saved[$k] }
    }
}

# --- run them ---------------------------------------------------------------------------------------------------------

Write-Output "CI WINDOWS rows: $($selected -join ' ')"
foreach ($name in $selected) {
    $started = Get-Date
    $script:Blocked = ''
    Write-Output "=== $name"
    $log = Join-Path $Out "$name.log"
    $ok = $true
    try {
        & "Row-$name" *>&1 | Tee-Object -FilePath $log | Out-Null
    } catch {
        $ok = $false
        Add-Content -Path $log -Value "THREW: $($_.Exception.Message)"
    }
    $secs = [int]((Get-Date) - $started).TotalSeconds
    if ($ok) {
        Write-Output "ROW $name PASS $secs"
    } elseif ($script:Blocked) {
        Write-Output "ROW $name FAIL $secs (not run: $($script:Blocked))"
        $script:Failed += $name
    } else {
        Write-Output "--- the end of ci-out\$name.log"
        Get-Content $log -Tail 60
        Write-Output "ROW $name FAIL $secs"
        $script:Failed += $name
    }
}
if ($script:App) { Stop-App | Out-Null }

foreach ($n in $script:Notes) { Write-Output "NOTE $n" }
if ($script:Failed.Count -gt 0) {
    Write-Output "FAILED ROWS: $($script:Failed -join ' ')"
    Write-Output 'CI WINDOWS FAIL'
    exit 1
}
Write-Output 'CI WINDOWS PASS'
exit 0
