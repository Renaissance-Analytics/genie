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
# UTF-8 OUT, ALWAYS (the second Azure run: "ROW trust-step PASS 85" arrived as "trust-step PASS 85"). In-Session sends
# this script's output to a file and relays it as UTF-8; Windows PowerShell 5.1 writes a redirected stream in the
# console's code page, so a printed em dash became bytes that are not UTF-8 and the relay's count of what it had read
# drifted past the next line's first four bytes. Set for this process and for the native commands it starts.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..'))
$Repo = (Get-Location).Path
$Out = Join-Path $Repo 'ci-out'
# WHAT THE SETUP WRITES goes under ci-out\setup, never beside the rows' own logs: a row's log is open for the whole row,
# and the build row's helper once wrote ci-out\build.log too ("being used by another process", the build row failed in
# 0 s; reproduced with both PowerShell engines, and gone with the helper's file under setup\).
$Setup = Join-Path $Out 'setup'

$Rows = @(
    'deps', 'electron-binary',
    'unit-build', 'unit',
    'build', 'seed', 'no-pty', 'smoke', 'layout', 'app-stopped',
    'local-door-break', 'local-door', 'host-late-ready', 'files-watch', 'chat-drafts', 'gapp-open', 'artboard', 'ui-lag',
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
# THE SETUP A SHORT RUN STANDS ON, RUN FIRST AND SAID (the targeted Azure run of 2026-11-11: three rows failed in 60 s
# each with "exit -4058", ENOENT, because nothing had fetched Electron's binary: Electron 44 fetches it on first use, and
# in a full run the rows before had done that). Every -Only or -From run starts with deps and electron-binary, and with
# build when a chosen row needs the built app; each prints its own ROW line.
if ($Only -or $From) {
    # $prereq, not $setup: PowerShell's names ignore case, and $setup IS $Setup, the ci-out\setup folder (the Azure run of
    # -Only unit on 101287c4: the folder became this list, ci-out was never made, every row read as timed out).
    $prereq = @('deps', 'electron-binary')
    if (@($selected | Where-Object { @('deps', 'electron-binary', 'unit-build', 'unit') -notcontains $_ }).Count -gt 0) { $prereq += 'build' }
    $selected = @($prereq | Where-Object { $selected -notcontains $_ }) + $selected
}

foreach ($dir in @($Out, $Setup)) { New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null }
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
    npm ci --no-audit --no-fund *> (Join-Path $Setup 'npm-ci.log')
    if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $Setup 'npm-ci.log') -Tail 40; Block $script:Installed }
    $script:Installed = 'ok'
}

# ELECTRON'S BINARY. Electron 44 has no install script: `require('electron')` fetches the binary the first time something
# asks for its path. Row scripts that start node_modules\electron\dist\electron.exe by its path never ask, so it is
# fetched here (install.js, the package's own fetch, checksum-checked), and its absence is said by name.
$script:ElectronExe = Join-Path $Repo 'node_modules\electron\dist\electron.exe'
$script:Electron = ''
function Need-Electron {
    if ($script:Electron -eq 'ok') { return }
    if ($script:Electron) { Block $script:Electron }
    Need-Install
    if (-not (Test-Path $script:ElectronExe)) {
        node node_modules/electron/install.js *> (Join-Path $Setup 'electron-install.log')
        Get-Content (Join-Path $Setup 'electron-install.log') -Tail 5
    }
    if (-not (Test-Path $script:ElectronExe)) { $script:Electron = "$($script:ElectronExe) missing (node_modules/electron/install.js did not fetch it: see ci-out\electron-install.log)"; Block $script:Electron }
    Write-Output "--- Electron: $($script:ElectronExe) ($([int]((Get-Item $script:ElectronExe).Length / 1MB)) MB)"
    $script:Electron = 'ok'
}

$script:Built = ''
function Need-Build {
    if ($script:Built -eq 'ok') { return }
    if ($script:Built) { Block $script:Built }
    Need-Install
    Need-Electron
    $script:Built = 'the build failed'
    npm run build *> (Join-Path $Setup 'build.log')
    if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $Setup 'build.log') -Tail 40; Block $script:Built }
    $script:Built = 'ok'
}

# HOW THIS MACHINE DRAWS, SAID ONCE (as scripts/ci/linux.sh does). ui-lag and artboard have absolute time bounds set
# on a machine that keeps up at idle; a VM with no GPU does not (the first Azure run: artboard failed its 250 ms clock).
# GENIE_CI_RENDERING=software makes both judge their absolute bounds against the same run's idle pass; their ratios,
# counts and byte budgets are judged as everywhere. Software: a virtual machine whose only display adapters are a
# virtual or basic one (Microsoft Hyper-V Video, Microsoft Basic Display Adapter, Basic Render). Given wins.
function Declare-Rendering {
    if ($env:GENIE_CI_RENDERING) { Write-Output "--- rendering: $env:GENIE_CI_RENDERING (given)"; return }
    $model = "$((Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).Model)"
    $adapters = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name)" })
    $real = @($adapters | Where-Object { $_ -notmatch 'Hyper-V Video|Basic Display|Basic Render|Remote Display' })
    $vm = $model -match 'Virtual Machine|VirtualBox|VMware|KVM'
    if ($vm -and $real.Count -eq 0) {
        $env:GENIE_CI_RENDERING = 'software'
        $script:Notes += "MEASURED ON A SOFTWARE-RENDERED MACHINE ($model; display: $($adapters -join ', ')): ui-lag and artboard judged their absolute time bounds against this run's idle pass, not the absolute budgets"
    } else {
        $env:GENIE_CI_RENDERING = 'hardware'
    }
    Write-Output "--- rendering: $env:GENIE_CI_RENDERING (model: $model; display: $($adapters -join ', '))"
}

$script:Machine = ''
function Need-TestMachine {
    if ($script:Machine -eq 'ok') { return }
    if ($script:Machine) { Block $script:Machine }
    $script:Machine = 'not a test machine'
    Declare-TestMachine
    Declare-Rendering
    $script:Machine = 'ok'
}

# THE APP, OPENED ONCE for the rows from no-pty to layout, as ci.yml's "open the app and drive it" step, and stopped by
# app-stopped (which fails when any of its electron processes outlives the stop, as that step did).
$script:App = $null
$script:AppHome = ''
$script:AppState = ''
function Need-App {
    if ($script:AppState -eq 'ok') { return }
    if ($script:AppState) { Block $script:AppState }
    Need-Build; Need-Electron; Need-TestMachine
    # A HOME OF ITS OWN for this run (Tynn #692, as linux.sh: a loop of runs in one session found the last run's app,
    # host and state). The seed and the app get it through USERPROFILE, HOME, APPDATA and LOCALAPPDATA; this process's
    # own are put back once the app has started with them.
    $script:AppState = 'something already answers on the debugger port 9222 (an app this run did not start)'
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:9222/json/version' | Out-Null; Block $script:AppState } catch { if ($script:Blocked) { throw } }
    $script:AppHome = Join-Path ([System.IO.Path]::GetTempPath()) ("genie-ci-app-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    foreach ($d in @("$($script:AppHome)\AppData\Roaming", "$($script:AppHome)\AppData\Local")) { New-Item -ItemType Directory -Force $d | Out-Null }
    Write-Output "--- the app's own home: $($script:AppHome)"
    $saved = @{ USERPROFILE = $env:USERPROFILE; HOME = $env:HOME; APPDATA = $env:APPDATA; LOCALAPPDATA = $env:LOCALAPPDATA }
    try {
        $env:USERPROFILE = $script:AppHome; $env:HOME = $script:AppHome
        $env:APPDATA = "$($script:AppHome)\AppData\Roaming"; $env:LOCALAPPDATA = "$($script:AppHome)\AppData\Local"
        $script:AppState = 'the seed could not be written'
        node scripts/smoke-seed.mjs *> (Join-Path $Setup 'seed.out')
        if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $Setup 'seed.out') -Tail 20; Block $script:AppState }
        $env:GENIE2_CODEX_BINARY = "$Repo\scripts\stub-codex.mjs"
        $env:GENIE_PAGE_PROBE = '1'
        # Electron by its own path, not through npx: npm would look for its cache and config under the moved APPDATA.
        # node itself is C:\tools\node on the machine PATH and reads nothing from APPDATA to run the seed.
        $script:App = Start-Process -FilePath $script:ElectronExe -ArgumentList '.', '--remote-debugging-port=9222' -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $Out 'electron-out.log') -RedirectStandardError (Join-Path $Out 'electron-err.log')
    } finally {
        foreach ($k in $saved.Keys) { Set-Item -Path "env:$k" -Value $saved[$k] }
    }
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

# The count of electron processes from this checkout left after the stop, in $script:AppLeft; what it saw on the way
# is PRINTED with Write-Host. Not returned: a PowerShell function returns everything it writes to the pipeline, so a
# `return $n` after Write-Output lines hands back an array, and `-gt 0` on an array filters it instead of comparing (the
# first Azure run read "14 ... 9 ... 0 left" as a failure: the 0 was the count). The failure the gauge must be able to
# find (processes left over) is a count of ONE or more: `@(...)`, then `.Count`, never `(pipeline).Count`.
$script:AppLeft = 0
function Stop-App {
    $script:AppLeft = 0
    if (-not $script:App) { return }
    $before = @(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Repo*" })
    Write-Host "electron processes from this checkout before stopping the app: $($before.Count)"
    if (-not $script:App.HasExited) { taskkill /PID $script:App.Id /T /F *> $null }
    $ours = @(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Repo*" })
    Write-Host "electron processes from this checkout still running after the tree kill: $($ours.Count)"
    if ($ours.Count -gt 0) {
        # Which ones outlived the tree kill, and whose children they were: said, so a product finding has its evidence.
        $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
        foreach ($p in $ours) {
            $c = $all | Where-Object { $_.ProcessId -eq $p.Id } | Select-Object -First 1
            $parent = $all | Where-Object { $_.ProcessId -eq $c.ParentProcessId } | Select-Object -First 1
            $cmd = "$($c.CommandLine)"; if ($cmd.Length -gt 220) { $cmd = $cmd.Substring(0, 220) }
            Write-Host "  outlived: pid $($p.Id) parent $($c.ParentProcessId) ($(if ($parent) { $parent.Name } else { 'gone' })): $cmd"
        }
    }
    $ours | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $script:App = $null
    $script:AppState = 'the app was stopped (app-stopped); the rows that drive it run before that row'
    # Its genie-host: started detached, from its copy under the app's home, so neither the tree kill nor the checkout's
    # path finds it. By the pid its host.json names, and anything else running from that home.
    if ($script:AppHome) {
        $hostJson = Join-Path $script:AppHome '.genie\runtime\host.json'
        if (Test-Path $hostJson) { $hp = (Get-Content $hostJson -Raw | ConvertFrom-Json).pid; if ($hp) { Stop-Process -Id $hp -Force -ErrorAction SilentlyContinue } }
        @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($script:AppHome, [System.StringComparison]::OrdinalIgnoreCase) }) | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like "$Repo*" -or ($script:AppHome -and $_.Path.StartsWith($script:AppHome, [System.StringComparison]::OrdinalIgnoreCase))) })
    $script:AppLeft = $left.Count
    Write-Host "electron processes from this checkout left after the stop: $($script:AppLeft)"
}

# --- the rows: each throws on failure ---------------------------------------------------------------------------------

function Row-deps { Need-Install }
function Row-electron-binary { Need-Electron }
function Row-unit-build { Need-Install; Need-Electron; Run 'npm run build:main' { npm run build:main } }

# The Windows suite, with its sampler beside it and the 30 s per-test budget ci.yml gives it (the Windows runner is
# slower to start processes); the slow-test table after it, observe only.
function Row-unit {
    Need-Install; Need-Electron
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
    Stop-App
    if ($script:AppLeft -gt 0) { throw "the app is still running after the row stopped it ($($script:AppLeft) electron processes)" }
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
# A host that comes up late is waited for (Tynn #700): the window must not give up on a genie-host that is still starting.
function Row-host-late-ready { Need-Build; Need-TestMachine; Run 'host-late-ready-cdp' { node scripts/host-late-ready-cdp.mjs } }
function Row-files-watch { Need-Build; Need-TestMachine; Run 'files-watch-cdp' { node scripts/files-watch-cdp.mjs } }
function Row-chat-drafts { Need-Build; Need-TestMachine; Run 'chat-drafts-cdp' { node scripts/chat-drafts-cdp.mjs } }
function Row-gapp-open { Need-Build; Need-TestMachine; Run 'gapp-open-cdp' { node scripts/gapp-open-cdp.mjs } }
function Row-artboard { Need-Build; Need-TestMachine; Run 'artboard-cdp' { node scripts/artboard-cdp.mjs --trace-main } }
function Row-ui-lag { Need-Build; Need-TestMachine; Run 'ui-lag-cdp' { node scripts/ui-lag-cdp.mjs --budget } }
function Row-trust-step { Need-Build; Need-TestMachine; Run 'trust-step-cdp' { node scripts/trust-step-cdp.mjs } }
# The app opened for no-pty..layout wrote this log: the spawn host started, and never fell back.
function Row-spawn-host {
    if (-not $script:AppHome) { Block 'the app was not opened in this run (the seed row opens it)' }
    $log = Join-Path $script:AppHome '.genie\runtime\lifecycle.log'
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
    $exe = @(Get-ChildItem release\win-unpacked\*.exe)[0].FullName
    npx --yes @electron/fuses read --app "$exe" | Tee-Object -FilePath (Join-Path $Out 'fuses.txt')
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
        $packaged = Start-Process -FilePath (Resolve-Path "release\win-unpacked\Genie.exe") -PassThru
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
        if (-not $packaged.HasExited) { taskkill /PID $packaged.Id /T /F *> $null }
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

# EVERY ROW HAS A CEILING (Tynn #692: trust-step printed its title and then nothing until the Azure job's 90 minutes ran
# out; no row after it ran). In seconds: the row script's own timeout (as linux.sh gives it, ci.yml's Windows job had
# none) plus 60 s, or the job's limit, or a stated one. On expiry a watchdog process marks the row and ends every
# process this script started except the shared app and the machine sampler (each with its tree, taskkill /T), so the
# row's command returns, the row prints `(timed out after N s)`, and the run goes on.
function Ceiling([string]$name) {
    switch ($name) {
        { $_ -in 'deps', 'packaged-launcher' } { return 900 }
        { $_ -in 'electron-binary', 'package-fuse', 'sign-plan', 'packed-tree', 'update-metadata', 'host-late-ready', 'seed' } { return 300 }
        { $_ -in 'unit-build', 'build' } { return 600 }
        'unit' { return 1800 }
        { $_ -in 'spawn-host', 'app-stopped' } { return 120 }
        { $_ -in 'no-pty', 'smoke', 'layout', 'local-door-break', 'local-door', 'gapp-open', 'trust-step' } { return 360 }
        'files-watch' { return 240 }
        { $_ -in 'chat-drafts', 'artboard' } { return 420 }
        { $_ -in 'ui-lag', 'renderer-crash' } { return 480 }
        { $_ -in 'safe-mode', 'hang' } { return 600 }
        'package' { return 1500 }
        default { return 600 }
    }
}
function Start-Watchdog([int]$limit, [string]$mark, [string]$token) {
    if ($limit -lt 1) { throw "a row's ceiling must be at least 1 s, not '$limit'" }
    $keep = if ($script:App) { $script:App.Id } else { 0 }
    $sampler = if ($script:Sampler) { $script:Sampler.Id } else { 0 }
    $cmd = "Start-Sleep -Seconds $limit; Set-Content -LiteralPath '$mark' -Value '$token'; " +
        "Get-CimInstance Win32_Process -Filter 'ParentProcessId=$PID' | Where-Object { `$_.ProcessId -ne `$PID -and `$_.ProcessId -ne $keep -and `$_.ProcessId -ne $sampler } | " +
        "ForEach-Object { taskkill /PID `$_.ProcessId /T /F *> `$null }"
    # Encoded, so no quoting between here and the child can change a character of it.
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd))
    Start-Process powershell -ArgumentList '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded -WindowStyle Hidden -PassThru
}

# --- run them ---------------------------------------------------------------------------------------------------------

# THE MACHINE BESIDE EVERY ROW (Tynn #660): scripts/ci/machine-sampler.ps1 writes one MACHINE line every ~2 s for the
# whole run into ci-out\machine-samples.log, and ends with this script. The watchdog spares it ($script:Sampler).
$MachineSamples = Join-Path $Out 'machine-samples.log'
$script:Sampler = Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/ci/machine-sampler.ps1', '-Out', $MachineSamples, '-ParentId', $PID -PassThru -WindowStyle Hidden
Write-Output "CI WINDOWS rows: $($selected -join ' ')"

# >>> THE ROW LOOP (test/ci-infra-rerun-windows.test.ts runs this block, as it is, with stub rows)
#
# STALL-AWARE ROWS (Tynn #660; the owner: "we are wasting so much time on failing test infrastructure"). A row that
# FAILS while the machine sampler recorded a stall during it (scripts/ci/stall.mjs: the disk queue up with the CPU
# idle, as on the 62c gates' D8ads_v5, or the VM paused) is INFRA: said, and run ONCE more on this machine; its ROW line
# is the rerun's, marked INFRA, and the summary names it. A row that fails with no stall is never run again: its failure
# is the code's. A row an earlier row's need stopped (`not run`) is not its own failure and is not run again either.
# What stall.mjs found, or that it found nothing in N samples, is printed under the failure.
$script:RowResults = [ordered]@{}
$script:Infra = @()
$script:NeedStates = @('Installed', 'Electron', 'Built', 'Machine', 'AppState')
function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Get-Needs { $h = @{}; foreach ($n in $script:NeedStates) { $h[$n] = [string](Get-Variable -Scope Script -Name $n -ValueOnly -ErrorAction SilentlyContinue) }; return $h }
# A need that FAILED during a row is asked again by its rerun, never read from that failure (a half-started app is ended).
function Reset-NeedsFailedHere($before) {
    $now = Get-Needs
    foreach ($n in $script:NeedStates) {
        if ($now[$n] -ne $before[$n] -and $now[$n] -ne 'ok') {
            if ($n -eq 'AppState' -and $script:App) { Stop-App }
            Set-Variable -Scope Script -Name $n -Value $before[$n]
        }
    }
}

# ONE RUN OF ONE ROW, its output appended to ci-out\<name>.log and the end of it printed when it fails. Sets
# $script:RowVerdict (PASS or FAIL), $script:RowLine (its ROW line, printed by Invoke-Rows) and $script:RowOwn ($false when
# an earlier row's need stopped it).
function Invoke-Row([string]$name) {
    $started = Get-Date
    $script:Blocked = ''
    $script:RowOwn = $true
    $log = Join-Path $Out "$name.log"
    $ok = $true
    $limit = [int](Ceiling $name)
    $mark = Join-Path $Setup "timed-out-$name"
    # This row's own token: a mark left by anything else, or by an earlier row of the same name, is not this row's.
    $token = [guid]::NewGuid().ToString('N')
    Remove-Item -LiteralPath $mark -Force -ErrorAction SilentlyContinue
    $before = Get-Needs
    $watch = Start-Watchdog $limit $mark $token
    try {
        & "Row-$name" *>&1 | ForEach-Object { "$_" } | Out-File -FilePath $log -Encoding utf8 -Append
    } catch {
        $ok = $false
        Add-Content -Path $log -Value "THREW: $($_.Exception.Message)"
    } finally {
        # The watchdog and its tree; not what it already ended.
        if (-not $watch.HasExited) { taskkill /PID $watch.Id /T /F *> $null }
    }
    # A ROW THAT ENDS BEFORE ITS CEILING CANNOT READ AS TIMED OUT: the mark must exist as a file, hold this row's token,
    # and the ceiling's time must have passed. A scalar test each, never Test-Path of a list (an array of results reads
    # as true however they came out).
    $elapsed = ((Get-Date) - $started).TotalSeconds
    $timedOut = (Test-Path -LiteralPath $mark -PathType Leaf) -and ((Get-Content -LiteralPath $mark -Raw).Trim() -eq $token) -and ($elapsed -ge $limit - 5)
    if ($timedOut) { $ok = $false }
    $secs = [int]$elapsed
    if ($ok) { $script:RowVerdict = 'PASS'; $script:RowLine = "ROW $name PASS $secs"; return }
    $script:RowVerdict = 'FAIL'
    if ($timedOut) {
        Write-Output "--- the end of ci-out\$name.log"
        Get-Content $log -Tail 40
        $script:RowLine = "ROW $name FAIL $secs (timed out after $limit s)"
    } elseif ($script:Blocked) {
        # Its own when one of its needs failed in it; an earlier row's when it only read that failure.
        $now = Get-Needs
        $script:RowOwn = @($script:NeedStates | Where-Object { $now[$_] -ne $before[$_] -and $now[$_] -ne 'ok' }).Count -gt 0
        $script:RowLine = "ROW $name FAIL $secs (not run: $($script:Blocked))"
    } else {
        Write-Output "--- the end of ci-out\$name.log"
        Get-Content $log -Tail 60
        # What the row's own app wrote, under smoke-out, during this row: the cause of a window that never came is there.
        Get-ChildItem (Join-Path $Repo 'smoke-out') -File -Filter '*.log' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $started } | ForEach-Object {
            Write-Output "--- the end of smoke-out\$($_.Name)"
            Get-Content $_.FullName -Tail 40
        }
        $script:RowLine = "ROW $name FAIL $secs"
    }
}

function Invoke-Rows {
    foreach ($name in $selected) {
        Write-Output "=== $name"
        $from = Now-Ms
        $before = Get-Needs
        Remove-Item -LiteralPath (Join-Path $Out "$name.log") -Force -ErrorAction SilentlyContinue
        Invoke-Row $name
        if ($script:RowVerdict -eq 'FAIL' -and $script:RowOwn) {
            $stall = @(node scripts/ci/stall.mjs $MachineSamples $from (Now-Ms))
            $stalled = ($LASTEXITCODE -eq 0)
            $stall | ForEach-Object { Write-Output $_ }
            if ($stalled) {
                $secs = ($script:RowLine -split ' ')[3]
                Write-Output "INFRA $name FAIL ${secs}: the machine stalled during the row ($($stall[0])); running it once more on this machine"
                Add-Content -Path (Join-Path $Out "$name.log") -Value "`r`n=== INFRA: the machine stalled during the run above; the rerun follows"
                Reset-NeedsFailedHere $before
                Invoke-Row $name
                if ($script:RowVerdict -ne 'FAIL') {
                    Write-Output "$($script:RowLine) (INFRA: the first run failed during a machine stall; the rerun passed)"
                    $script:Infra += "$name (rerun PASS)"
                } else {
                    Write-Output "$($script:RowLine) (INFRA: the first run failed during a machine stall; the rerun failed too)"
                    $script:Infra += "$name (rerun FAIL)"
                    $script:Failed += $name
                }
                $script:RowResults[$name] = $script:RowVerdict
                continue
            }
        }
        Write-Output $script:RowLine
        $script:RowResults[$name] = $script:RowVerdict
        if ($script:RowVerdict -eq 'FAIL') { $script:Failed += $name }
    }
}

function Write-InfraSummary {
    if ($script:Infra.Count) { Write-Output "INFRA ROWS: $($script:Infra -join ' ')" } else { Write-Output 'INFRA ROWS: none' }
}
# <<< THE ROW LOOP

Invoke-Rows
if ($script:App) { Stop-App }
if ($script:Sampler -and -not $script:Sampler.HasExited) { Stop-Process -Id $script:Sampler.Id -Force -ErrorAction SilentlyContinue }

foreach ($n in $script:Notes) { Write-Output "NOTE $n" }
Write-InfraSummary
# Every selected row has exactly one result; a row with none is a failure of this script, and fails the run.
$missing = @($selected | Where-Object { -not $script:RowResults.Contains($_) })
foreach ($m in $missing) { $script:Failed += $m }
Write-Output "ROWS $($script:RowResults.Count) of $($selected.Count) reported: $(($script:RowResults.Keys | ForEach-Object { "$_=$($script:RowResults[$_])" }) -join ' ')$(if ($missing.Count) { "; NO RESULT: $($missing -join ' ')" })"
if ($script:Failed.Count -gt 0) {
    Write-Output "FAILED ROWS: $($script:Failed -join ' ')"
    Write-Output 'CI WINDOWS FAIL'
    exit 1
}
Write-Output 'CI WINDOWS PASS'
exit 0
