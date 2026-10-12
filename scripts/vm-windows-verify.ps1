# vm-windows-verify.ps1 — runs INSIDE the genie-test-windows VM, over SSH, in PowerShell 5.1.
#
#   scripts/vm-run.sh genie-test-windows repos/genie2 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vm-windows-verify.ps1'
#
# The Windows half of what CI does, plus the one thing CI never does: INSTALL THE INSTALLER
# and drive the installed app. In order:
#
#   1. npm ci · typecheck · unit tests · build                  (what "typecheck+unit" proves)
#   2. seed, open the app from dist/ with CDP, smoke + sweep     (what "a real window" proves)
#   3. electron-builder --publish never → Genie-<v>-setup.exe    (what "it packages" proves)
#   4. run the NSIS installer silently, open the INSTALLED app, drive it over CDP, check the
#      runtime dir landed under %APPDATA% and not under the install dir (§7.1), kill it,
#      prove nothing survived, uninstall                          (what nobody had proved)
#
# Every launch is torn down with taskkill /T on the pid this script started — the VM is the
# place where that is allowed; the owner's desktop is not.
param(
    [switch] $SkipInstaller,     # steps 1–2 only
    [switch] $SkipSource         # steps 3–4 only (dist/ must already exist)
)
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
# Everything below also lands in verify.log next to the tree, so a run whose SSH client died
# (the host-side harness has a timeout; the VM does not) still leaves its whole story on the
# VM's disk, readable over the next SSH session.
Start-Transcript -Path (Join-Path $root 'verify.log') -Force | Out-Null
function Step($n) { Write-Output ""; Write-Output "=== $n ===" }

# npm/npx are .cmd shims; cmd.exe runs them without the EINVAL dance. Output is merged so a
# failure's last lines are in the SSH stream, not in a file nobody reads.
function Run($cmd, $log = $null) {
    if ($log) {
        & cmd /c "$cmd > $log 2>&1"
        if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 40; throw "FAILED ($LASTEXITCODE): $cmd" }
    } else {
        & cmd /c "$cmd 2>&1"
        if ($LASTEXITCODE -ne 0) { throw "FAILED ($LASTEXITCODE): $cmd" }
    }
}

function Kill-Tree($id) {
    & cmd /c "taskkill /PID $id /T /F >nul 2>&1"
}

# Launch an Electron process with CDP on 9222, drive it with the smoke scripts, tear it down,
# and prove the teardown. $label names the screenshots so the two runs do not overwrite.
function Drive($file, $argList, $label) {
    Remove-Item -Force -ErrorAction SilentlyContinue "$label-out.log", "$label-err.log"
    $app = Start-Process -FilePath $file -ArgumentList $argList -PassThru `
        -RedirectStandardOutput "$label-out.log" -RedirectStandardError "$label-err.log"
    $ok = $false
    try {
        # §1 on a real process table, FIRST, while nothing else has started an agent or a pty:
        # a running agent adds no console host, a Workspace terminal adds exactly one, stop
        # leaves nothing. The smoke that follows starts its own agent and is not disturbed.
        Run "node scripts\agents-hold-no-pty-cdp.mjs"
        Run "node scripts\smoke-cdp.mjs"
        Run "node scripts\layout-sweep.mjs"
        $ok = $true
    } finally {
        if (-not $ok) {
            Write-Output "--- $label stderr ---"; Get-Content "$label-err.log" -Tail 60 -ErrorAction SilentlyContinue
            Write-Output "--- $label stdout ---"; Get-Content "$label-out.log" -Tail 20 -ErrorAction SilentlyContinue
        }
        Kill-Tree $app.Id
        Start-Sleep -Seconds 2
        $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and ($_.Path -like "$root\node_modules\electron\*" -or $_.Path -like "$env:LOCALAPPDATA\Programs\Genie\*")
        })
        if ($left.Count) { $left | ForEach-Object { Kill-Tree $_.Id }; throw "$($left.Count) process(es) survived the teardown of $label" }
        Write-Output "$label torn down: 0 processes survived"
        Get-ChildItem smoke-*.png -ErrorAction SilentlyContinue | ForEach-Object {
            Move-Item -Force $_.FullName ($_.Name -replace '^smoke-', "$label-")
        }
    }
}

$env:GENIE2_CODEX_BINARY = "$root\scripts\stub-codex.cmd"

if (-not $SkipSource) {
    Step 'npm ci'
    Run 'npm ci --no-audit --no-fund' 'ci.log'
    Write-Output ("node " + (& node --version) + ", npm " + (& cmd /c 'npm --version 2>nul'))
    # Electron's binary arrives through its postinstall (a ~110 MB download). On the first VM run
    # it was silently absent after a green `npm ci`, and the smoke then died on the debugger
    # port with "Electron failed to install correctly". Say so here, with the postinstall's own
    # lines, and run the install step once more where its output can be read.
    if (-not (Test-Path node_modules\electron\path.txt)) {
        Write-Output "electron binary MISSING after npm ci; what ci.log says about it:"
        Select-String -Path ci.log -Pattern 'electron|error|ERR!' | Select-Object -First 30 | ForEach-Object { "   " + $_.Line }
        Step 'electron postinstall, explicitly'
        Run 'node node_modules\electron\install.js'
        if (-not (Test-Path node_modules\electron\path.txt)) { throw 'electron binary still missing after install.js' }
    }
    Write-Output ("electron binary: " + (Get-Content node_modules\electron\path.txt))

    Step 'typecheck'
    Run 'npm run typecheck'

    # The unit tests timed out twice on 2026-10-11 (5 s tests, 10 s hooks, vitest transform 73 s instead of ~5)
    # when run here, right after npm ci + the electron download + typecheck, and passed 1487/1487 in 32 s when run
    # right after npm ci alone. So the load this VM is under at this moment is PRINTED, not guessed: Defender's
    # scanner CPU (cumulative) and three 5 s samples of total CPU. A red suite below reads these lines first.
    Step 'host load before unit tests'
    $mp = Get-Process MsMpEng -ErrorAction SilentlyContinue
    if ($mp) { Write-Output ('MsMpEng cpu={0:N1}s ws={1:N0}MB' -f $mp.CPU, ($mp.WorkingSet64/1MB)) } else { Write-Output 'MsMpEng: not running' }
    # (CIM, not Get-Counter: the counter path needs backslashes that do not survive every editor, and a
    # measurement that throws must never be what fails the gate.)
    try {
        1..3 | ForEach-Object { $c = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; Write-Output ('{0}  cpu total={1:N0}%' -f (Get-Date -Format HH:mm:ss), $c); Start-Sleep 5 }
        $top = Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object { '{0}={1:N0}s' -f $_.ProcessName, $_.CPU }
        Write-Output ('top cpu since boot: ' + ($top -join ', '))
    } catch { Write-Output ('host load sample failed: ' + $_.Exception.Message) }

    Step 'unit tests'
    Run 'npm test' 'test.log'
    Get-Content test.log -Tail 12

    # The two LIVE terminal checks, through the real engine (node-pty via fancy-term-host).
    # verify:leak is the measurement genie#805 lacked, and Windows (conpty) is where that
    # incident's numbers came from, so this is the baseline that can actually go red.
    Step 'live terminal + leak baseline'
    Run 'npm run verify:terminal' 'terminal.log'
    Get-Content terminal.log -Tail 10
    # The leak baseline is RED on Windows by design until fancy-term-host runs on fancy-pty
    # (node-pty/conpty retains ~1 thread, ~18 handles, ~13 MB per exited pty — genie#805, and
    # what took v1 down in genie#867). It is REPORTED here, not a gate, so the checks after it
    # still run; the fancy-pty acceptance turns it back into a throw.
    & cmd /c 'npm run verify:leak > leak.log 2>&1'
    $leak = $LASTEXITCODE
    Get-Content leak.log -Tail 14
    # With fancy-pty installed (fancy-term-host >= 0.10) the leak check IS the gate — the owner's
    # release hold is "until fancy-pty passes the Windows VM acceptance", and this is the number.
    $fancyPty = Test-Path (Join-Path $root 'node_modules\@particle-academy\fancy-pty\package.json')
    if ($leak -eq 0) { Write-Output 'LEAK BASELINE: GREEN' }
    elseif ($fancyPty) { throw "LEAK CHECK RED (exit $leak) with fancy-pty installed — the acceptance gate" }
    else { Write-Output "LEAK BASELINE: RED (exit $leak) — known until fancy-pty; not a gate without it" }

    Step 'build'
    Run 'npm run build' 'build.log'

    Step 'seed'
    Run 'node scripts\smoke-seed.mjs'

    Step 'a real window, from dist/'
    Drive 'npx.cmd' @('electron', '.', '--remote-debugging-port=9222') 'source'
}

if (-not $SkipInstaller) {
    Step 'electron-builder --publish never'
    Run 'npx electron-builder --publish never' 'package.log'
    Get-Content package.log -Tail 8
    $setup = @(Get-ChildItem release\Genie-*-setup.exe)[0]
    if (-not $setup) { throw 'no release\Genie-*-setup.exe' }
    Write-Output ("built: " + $setup.Name + " (" + [math]::Round($setup.Length / 1MB) + " MB)")

    Step 'install it (NSIS, silent, per-user)'
    $installDir = "$env:LOCALAPPDATA\Programs\Genie"
    $uninst = Join-Path $installDir 'Uninstall Genie.exe'
    if (Test-Path $uninst) { Start-Process $uninst -ArgumentList '/S' -Wait; Start-Sleep 2 }
    Start-Process $setup.FullName -ArgumentList '/S' -Wait
    $exe = Join-Path $installDir 'Genie.exe'
    if (-not (Test-Path $exe)) { throw "installed, but $exe is not there" }
    Write-Output "installed: $exe"
    $unpacked = Join-Path $installDir 'resources\app.asar.unpacked\node_modules\node-pty'
    Write-Output ("node-pty unpacked: " + (Test-Path $unpacked))

    Step 'a real window, from the INSTALLED app'
    Run 'node scripts\smoke-seed.mjs'
    Drive $exe @('--remote-debugging-port=9222') 'installed'

    Step '§7.1 runtime dir is under ~/.genie, never under the install dir'
    $runtime = "$env:USERPROFILE\.genie\runtime"
    if (-not (Test-Path $runtime)) { throw "no runtime dir at $runtime" }
    $stray = @(Get-ChildItem $installDir -Recurse -File | Where-Object { $_.Name -match '\.(sock|pid|lock|db)$' })
    if ($stray.Count) { $stray | ForEach-Object { Write-Output "  stray: $($_.FullName)" }; throw "$($stray.Count) runtime file(s) under the install dir" }
    Write-Output "runtime at $runtime; nothing runtime-shaped under $installDir"

    Step 'uninstall'
    Start-Process $uninst -ArgumentList '/S' -Wait
    Start-Sleep 2
    Write-Output ("install dir gone: " + (-not (Test-Path $exe)))
}

Write-Output ""
Write-Output "VM VERIFY OK"
Stop-Transcript | Out-Null
