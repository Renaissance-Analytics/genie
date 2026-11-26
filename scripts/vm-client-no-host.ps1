<#
A CLIENT WITH NO HOST, ON WINDOWS (Tynn #1058 L4; the row client-no-host, scripts/ci/windows.ps1). In a test VM only,
In-Session as the standard user genie, never on a person's desktop. Two installs on one machine, each in a code root and
a data root of its own (GENIE_CODE_ROOT, GENIE_HOME), from the package-tracks row's signed packages:

  A, the `client` profile: no host folder, no host. Opened by its launcher (`Genie.exe`), the client starts NO process
     and shows the host directory, empty: "No host on this computer. Pick a host, or add one." Photographed at 1280x800
     through its debugger (host-directory-empty-windows.png). Then the hosts it paired with, seeded as device-hosts.json
     holds them (addresses only), are listed (host-directory-paired-windows.png).
  B, the `both` profile: its launcher starts its host. The client of A, beside it, never touches it: the same pid and the
     same start time before and after, and A has no host.json, no host copy and no genie-host of its own.
  B with its host stopped (`Genie.exe stop-host`): its client opens on the directory with the local host stopped and Start
     (host-directory-stopped-windows.png); Start asks B's launcher (`launcher.ensureHost`), the host starts from its own
     folder and the client links to it.

The client is started here as the launcher starts it (its program in the code root, GENIE_HOME and GENIE_LAUNCHER_EXE,
GENIE_LAUNCHER_HOST_BUILD when there is a host), plus --remote-debugging-port for the pictures. On Windows one launcher
serves a user (its pipe is named for the user's SID) and the clients share the user's single-instance lock, so A's own
launcher runs first and alone, and B's client is closed before A's opens beside B's host.

Not here (step 4 of the split): opening a window on a paired host from a client-only machine, and Tynn's list of hosts.
Prints `### client-no-host=PASS|FAIL <why>`.
#>
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$Repo = (Get-Location).Path
$Out = Join-Path $Repo 'ci-out\client-no-host'
$Pkg = Join-Path $Repo 'release\tracks\packages'
$Launcher = Join-Path $Repo 'release\tracks\trees\launcher\Genie.exe'
$aCode = Join-Path $env:LOCALAPPDATA 'GenieRowA'; $aHome = Join-Path $env:LOCALAPPDATA 'GenieRowAHome'
$bCode = Join-Path $env:LOCALAPPDATA 'GenieRowB'; $bHome = Join-Path $env:LOCALAPPDATA 'GenieRowBHome'
$began = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
# Debugger ports of this row's own (test/ci-debug-ports-unique.test.ts): A's client, then B's.
$PortA = 9461
$PortB = 9462
New-Item -ItemType Directory -Force $Out | Out-Null

function Cleanup {
    $roots = @()
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path.StartsWith($aCode, [StringComparison]::OrdinalIgnoreCase) -or $_.Path.StartsWith($bCode, [StringComparison]::OrdinalIgnoreCase) -or $_.Path -eq $Launcher) })) { $roots += @('--root', "$($p.Id)") }
    if ($roots.Count -gt 0) { node scripts/end-own-tree.mjs --since "$began" @roots | Out-Host }
    Remove-Item Env:GENIE_CODE_ROOT, Env:GENIE_HOME, Env:GENIE_LAUNCHER_EXE, Env:GENIE_LAUNCHER_HOST_BUILD -ErrorAction SilentlyContinue
}
function Fail([string]$why) {
    foreach ($h in @($aHome, $bHome)) { foreach ($f in @('runtime\lifecycle.log', 'logs\genie-host.log', 'logs\genie-client.log', 'logs\genie-launcher.log')) { $p = Join-Path $h $f; if (Test-Path $p) { Write-Output "--- $p"; Get-Content $p -Tail 25 } } }
    Write-Output "### client-no-host=FAIL $why"
    Cleanup
    exit 1
}
function Wait-Line([string]$file, [string]$pattern, [int]$seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        if (Test-Path $file) { $m = Select-String -Path $file -Pattern $pattern | Select-Object -First 1; if ($m) { return $m.Line } }
        Start-Sleep -Seconds 1
    }
    return $null
}
function With-Home([string]$code, [string]$data, [scriptblock]$run) {
    $env:GENIE_CODE_ROOT = $code; $env:GENIE_HOME = $data
    try { & $run } finally { Remove-Item Env:GENIE_CODE_ROOT, Env:GENIE_HOME -ErrorAction SilentlyContinue }
}
function HostsOf([string]$code) { @(Get-Process genie-host -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($code, [StringComparison]::OrdinalIgnoreCase) }) }
function ClientsOf([string]$code) { @(Get-Process genie-client -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($code, [StringComparison]::OrdinalIgnoreCase) }) }
# The client as the launcher starts it (native/launcher/src/control.rs start_component), with its debugger for the pictures.
function Start-Client([string]$code, [string]$data, [string]$hostBuild, [int]$port) {
    $exe = Join-Path $code "client\$build\genie-client.exe"
    if (-not (Test-Path $exe)) { Fail "no client at $exe" }
    $env:GENIE_HOME = $data; $env:GENIE_LAUNCHER_EXE = $Launcher
    if ($hostBuild) { $env:GENIE_LAUNCHER_HOST_BUILD = $hostBuild } else { Remove-Item Env:GENIE_LAUNCHER_HOST_BUILD -ErrorAction SilentlyContinue }
    try { $p = Start-Process -FilePath $exe -ArgumentList @('--open-window', "--remote-debugging-port=$port") -PassThru }
    finally { Remove-Item Env:GENIE_HOME, Env:GENIE_LAUNCHER_EXE, Env:GENIE_LAUNCHER_HOST_BUILD -ErrorAction SilentlyContinue }
    return $p
}
function Stop-Clients([string]$code) { foreach ($c in (ClientsOf $code)) { Stop-Process -Id $c.Id -Force -ErrorAction SilentlyContinue }; for ($i = 0; $i -lt 20 -and (ClientsOf $code).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 } }
function Rows([string]$text) { $line = @($text -split "`n" | Where-Object { $_ -like 'ROWS *' })[0]; if (-not $line) { return $null }; return ($line.Substring(5) | ConvertFrom-Json) }

if (-not (Test-Path (Join-Path $Repo 'release\tracks\build.txt'))) { Fail 'no release\tracks\build.txt: see the package-tracks row' }
$build = (Get-Content -Raw (Join-Path $Repo 'release\tracks\build.txt')).Trim()
if (-not (Test-Path $Launcher)) { Fail "no launcher at $Launcher" }
foreach ($d in @($aCode, $aHome, $bCode, $bHome)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }

# --- 1. A, client only: opened by its own launcher, it starts no process and shows the directory --------------------
Write-Output "--- 1. A: the client profile ($aCode), build $build"
With-Home $aCode $aHome { & $Launcher install --profile client --from $Pkg --yes | Out-Host }
if (-not (Test-Path (Join-Path $aCode "client\$build\.complete"))) { Fail 'A has no client' }
if (Test-Path (Join-Path $aCode 'host')) { Fail 'A, a client-only install, has a host folder' }
$hostsBefore = @(Get-Process genie-host -ErrorAction SilentlyContinue).Count
With-Home $aCode $aHome { $script:aLauncher = Start-Process -FilePath $Launcher -PassThru }
$aLife = Join-Path $aHome 'runtime\lifecycle.log'
$shown = Wait-Line $aLife 'host directory shown' 120
if (-not $shown) { Fail "A's client, opened by its launcher, did not show the host directory within 120 s" }
Write-Output "A: $shown"
if ($shown -notmatch '\(empty\)') { Fail "A's directory is not empty: $shown" }
if (-not (Select-String -Path $aLife -SimpleMatch 'started by the launcher' -Quiet)) { Fail "A's client was not started by its launcher" }
Start-Sleep -Seconds 3
if (Test-Path (Join-Path $aHome 'runtime\host.json')) { Fail 'A wrote a host.json: something started a host for a client-only install' }
if (Test-Path (Join-Path $aHome 'host')) { Fail 'A made a host copy' }
if ((HostsOf $aCode).Count -gt 0 -or @(Get-Process genie-host -ErrorAction SilentlyContinue).Count -ne $hostsBefore) { Fail 'a genie-host started for A' }
$aKids = @(Get-CimInstance Win32_Process | Where-Object { $c = $_; (ClientsOf $aCode | Where-Object { $_.Id -eq $c.ParentProcessId }).Count -gt 0 -and $c.Name -notlike 'genie-client*' })
if ($aKids.Count -gt 0) { Fail "A's client started processes of its own: $(($aKids | ForEach-Object { "$($_.Name) $($_.ProcessId)" }) -join ', ')" }
Write-Output 'A: no host.json, no host copy, no genie-host, no child process but its own renderers'
Stop-Clients $aCode
Stop-Process -Id $script:aLauncher.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# --- 2. B, both: its launcher starts its host ---------------------------------------------------------------------
Write-Output "--- 2. B: the both profile ($bCode)"
With-Home $bCode $bHome { & $Launcher install --profile both --from $Pkg --yes | Out-Host }
With-Home $bCode $bHome { $script:bLauncher = Start-Process -FilePath $Launcher -PassThru }
$bLife = Join-Path $bHome 'runtime\lifecycle.log'
$linked = Wait-Line $bLife 'agent host (adopted|started|replaced) pid=' 180
if (-not $linked) { Fail "B's client never linked to B's host" }
if ($linked -notmatch 'agent host adopted pid=') { Fail "B's client did not adopt its launcher's host: $linked" }
$bHost = @(HostsOf $bCode)[0]
if (-not $bHost) { Fail "no genie-host runs from $bCode" }
$bHostStart = $bHost.StartTime
Write-Output "B: genie-host pid $($bHost.Id) from $($bHost.Path), started $($bHostStart.ToString('o'))"
# Just close the UI: B's client goes, its host and launcher stay (the clients share this user's single-instance lock).
Stop-Clients $bCode

# --- 3. A's directory beside B's host: empty, then the paired hosts ------------------------------------------------
Write-Output "--- 3. A's client beside B's host"
$aClient = Start-Client $aCode $aHome $null $PortA
node scripts/host-directory-cdp.mjs $PortA $Out host-directory-empty-windows.png | Tee-Object -Variable emptyOut | Out-Host
if ($LASTEXITCODE -ne 0) { Fail 'the empty directory was not photographed (above)' }
$r = Rows ($emptyOut -join "`n")
if ($r.empty -ne 'No host on this computer. Pick a host, or add one.') { Fail "the empty state says '$($r.empty)'" }
if (-not $r.add) { Fail 'no Add a host' }
# Paired with two hosts, as main/device-tokens.ts writes it: addresses only, the tokens in a keychain A does not have.
Set-Content -Path (Join-Path $aHome 'runtime\device-hosts.json') -Value '{"hosts":["wss://studio.example:7443","ws://10.0.0.5:7443"]}' -Encoding ascii
node scripts/host-directory-cdp.mjs $PortA $Out host-directory-paired-windows.png reload | Tee-Object -Variable pairedOut | Out-Host
if ($LASTEXITCODE -ne 0) { Fail 'the paired directory was not photographed (above)' }
$r = Rows ($pairedOut -join "`n")
$ids = @($r.rows | ForEach-Object { $_.id }) -join ','
if ($ids -ne 'wss://studio.example:7443,ws://10.0.0.5:7443') { Fail "the paired rows are '$ids'" }
if (@($r.rows | Where-Object { $_.state -ne 'paired' }).Count -gt 0) { Fail 'a paired row is not shown as paired' }
$now = Get-Process -Id $bHost.Id -ErrorAction SilentlyContinue
if (-not $now -or $now.StartTime -ne $bHostStart) { Fail "B's host (pid $($bHost.Id)) did not stay as it was while A's client ran" }
if ((HostsOf $aCode).Count -gt 0 -or (Test-Path (Join-Path $aHome 'runtime\host.json'))) { Fail 'A started a host beside B' }
Write-Output "B's host untouched: pid $($bHost.Id), started $($bHostStart.ToString('o'))"
Stop-Clients $aCode

# --- 4. B with its host stopped: the directory, then Start through the launcher -------------------------------------
Write-Output "--- 4. B's host stopped"
With-Home $bCode $bHome { & $Launcher stop-host | Out-Host }
for ($i = 0; $i -lt 60 -and (Get-Process -Id $bHost.Id -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
if (Get-Process -Id $bHost.Id -ErrorAction SilentlyContinue) { Fail "B's host did not stop" }
$bClient = Start-Client $bCode $bHome $build $PortB
node scripts/host-directory-cdp.mjs $PortB $Out host-directory-stopped-windows.png start | Tee-Object -Variable stoppedOut | Out-Host
if ($LASTEXITCODE -ne 0) { Fail 'the stopped host was not photographed and started (above)' }
$r = Rows ($stoppedOut -join "`n")
$local = @($r.rows | Where-Object { $_.id -eq 'local' })[0]
if (-not $local -or $local.state -ne 'stopped' -or $local.action -ne 'start') { Fail "the local host's row is $($local | ConvertTo-Json -Compress)" }
$relinked = $null
for ($i = 0; $i -lt 120 -and -not $relinked; $i++) { $relinked = @(Select-String -Path $bLife -Pattern 'agent host adopted pid=' | Select-Object -Skip 1 -First 1)[0]; if (-not $relinked) { Start-Sleep -Seconds 1 } }
if (-not $relinked) { Fail "B's client did not link to the host Start started" }
$fresh = @(HostsOf $bCode)[0]
if (-not $fresh -or $fresh.Id -eq $bHost.Id) { Fail 'no new host runs from B after Start' }
Write-Output "Start: the launcher started genie-host pid $($fresh.Id) from $($fresh.Path); the client: $($relinked.Line)"

Cleanup
Write-Output "### client-no-host=PASS a client-only install started no process and showed the host directory (empty, then its paired hosts) beside an untouched host of another install (pid $($bHost.Id)); with that host stopped its client showed it stopped and Start had the launcher start it"
exit 0
