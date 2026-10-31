# THE PERIODIC FREEZES ON WINDOWS, MEASURED ON genie-test-windows (beta.53, 2026-10-31). Never on the owner's desktop.
#
#   scripts/vm-fifo-first.sh windows ../_wt/<tree> 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts\perf-lag\run-vm-win.ps1 -Items b52:..\perf-b52:0.25,b53:.:0.25'
#
# Each item is <label>:<tree>:<scale>. A tree other than `.` is unpacked from <tree>.tgz beside this one (shipped inside
# this tree as perf-trees\<name>.tgz). Every tree: npm ci, then a build whose renderer is NOT minified, so a profile names
# its functions. Each item: a fresh seed (eleven agents streaming, threads the owner's size x scale, the owner's attention
# and mail stores), Genie launched with main's inspector on 9229 and CDP on 9222, freeze.mjs, Genie ended.
param([string]$Items = 'b53:.:0.25', [int]$PhaseSeconds = 90, [string]$Phases = 'dashboard,workspace,dashboard,workspace')
$ErrorActionPreference = 'Continue'
$here = (Get-Location).Path
$out = Join-Path $here 'perf-out'
New-Item -ItemType Directory -Force $out | Out-Null

function End-Genie {
    Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 30; $i++) { if (-not (Get-Process electron -ErrorAction SilentlyContinue)) { return }; Start-Sleep -Seconds 1 }
}

$built = @{}
function Prepare-Tree([string]$tree) {
    $full = if ($tree -eq '.') { $here } else { Join-Path $here $tree }
    if ($built.ContainsKey($full)) { return $full }
    if ($tree -ne '.' -and -not (Test-Path (Join-Path $full 'package.json'))) {
        $tgz = Join-Path $here ("perf-trees\" + (Split-Path $tree -Leaf) + '.tgz')
        New-Item -ItemType Directory -Force $full | Out-Null
        tar -xzf $tgz -C $full
        if ($LASTEXITCODE -ne 0) { Write-Host "unpack failed: $tgz"; exit 1 }
    }
    Push-Location $full
    Write-Host "=== npm ci in $full ($(Get-Date -Format T))"
    npm ci --no-audit --no-fund *> (Join-Path $out ("ci-" + (Split-Path $full -Leaf) + '.log'))
    if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $out ("ci-" + (Split-Path $full -Leaf) + '.log')) -Tail 30; Pop-Location; exit 1 }
    # Electron 45 has no postinstall: the binary is fetched by the first require('electron') (test/global-setup.ts).
    # The first require prints "Downloading Electron binary..." before the path: the path is the last line.
    $bin = ([string](node -e "process.stdout.write('\n' + require('electron'))" 2>$null | Where-Object { $_ -match 'electron' } | Select-Object -Last 1)).Trim()
    if (-not (Test-Path $bin)) { Write-Host "electron binary missing: $bin"; Pop-Location; exit 1 }
    Write-Host "=== electron $bin"
    Write-Host "=== build in $full ($(Get-Date -Format T))"
    $log = Join-Path $out ("build-" + (Split-Path $full -Leaf) + '.log')
    npx vite build --minify false *> $log
    if ($LASTEXITCODE -eq 0) { npm run build:main *>> $log }
    if ($LASTEXITCODE -eq 0) { npm run build:preload *>> $log }
    if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 30; Pop-Location; exit 1 }
    Pop-Location
    $built[$full] = $true
    return $full
}

Write-Output "cpus $env:NUMBER_OF_PROCESSORS; node $(node --version)"
foreach ($item in $Items.Split(',')) {
    $parts = $item.Split(':')
    $label = $parts[0]; $tree = $parts[1]; $scale = $parts[2]
    $full = Prepare-Tree $tree
    End-Genie
    foreach ($p in @("$HOME\.genie", "$HOME\lagws", "$env:APPDATA\genie", "$env:APPDATA\Genie", "$env:APPDATA\genie2")) { if (Test-Path $p) { Remove-Item -Recurse -Force $p } }
    Write-Output "=== seed $label ($tree, scale $scale) $(Get-Date -Format T)"
    node scripts\perf-lag\seed.mjs $scale | Select-Object -Last 1
    node scripts\perf-lag\seed-extra.mjs
    $env:GENIE2_CODEX_BINARY = Join-Path $here 'scripts\perf-lag\stub-codex-busy.mjs'
    Remove-Item -Force (Join-Path $here 'scripts\perf-lag\.busy-ms') -ErrorAction SilentlyContinue
    $env:LAUNCHED_AT_MS = [string][long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    Write-Output "=== launch $label"
    $electron = Join-Path $full 'node_modules\electron\dist\electron.exe'
    Start-Process -FilePath $electron -ArgumentList '--inspect=9229', '.', '--remote-debugging-port=9222' -WorkingDirectory $full -RedirectStandardOutput (Join-Path $out "$label-electron.log") -RedirectStandardError (Join-Path $out "$label-electron.err") | Out-Null
    Push-Location $out
    $job = Start-Job -ScriptBlock { param($dir, $script, $label, $ph, $phases, $at) Set-Location $dir; $env:LAUNCHED_AT_MS = $at; node $script $label $ph $phases 2>&1 } -ArgumentList $out, (Join-Path $here 'scripts\perf-lag\freeze.mjs'), $label, $PhaseSeconds, $Phases, $env:LAUNCHED_AT_MS
    $limit = 300 + 30 + $PhaseSeconds * $Phases.Split(',').Count + 240
    if (-not (Wait-Job $job -Timeout $limit)) { Write-Output "freeze.mjs timed out after $limit s"; Stop-Job $job }
    Receive-Job $job
    Pop-Location
    End-Genie
    # The stall watchdog's own lines (main/stall-watchdog.ts), where the tree has it: what beta.54 would leave on the owner's disk.
    $life = "$HOME\.genie\runtime\lifecycle.log"
    if (Test-Path $life) { Write-Output "=== watchdog lines ($label)"; Select-String -Path $life -Pattern 'stall |ipc (slow|waiting)|net (slow|waiting)|unresponsive|responsive|process gone' | Select-Object -Last 60 | ForEach-Object { $_.Line } }
    Select-String -Path (Join-Path $out "$label-electron.*") -Pattern 'fatal|out of memory|heap limit|uncaught' -ErrorAction SilentlyContinue | Select-Object -First 8 | ForEach-Object { $_.Line }
}
Get-ChildItem $out | Select-Object Name, Length | Format-Table -AutoSize | Out-String -Width 200
