# THE KEYCHAIN ON WINDOWS, IN EACH KIND OF SESSION. Run from the repo root on genie-test-windows only (it writes test words to Credential Manager).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\perf-lag\keychain-sessions-windows.ps1 -Phase ssh
#       This session as it is (over SSH): the round trip, a 4,096-byte value and the size limit. Also says what kind of logon it is.
#   ... -Phase interactive
#       The same, in the logged-on person's session, as a scheduled task "run only when logged on". This is what a real desktop's host inherits. Exit 4 if nobody is logged on.
#   ... -Phase logon-install    then log off and on, or reboot with autologon, then   ... -Phase logon-read
#       A task at logon that keeps trying until Credential Manager answers: how long a host started at logon could be refused, and in what words.
#
# Prints `### keychain ...` lines from scripts/perf-lag/keychain-measure.mjs and `### keychain-sessions ...` here. The tasks are removed afterwards. No secret is involved.
#   ... -Phase autologon        (the password on stdin, never an argument) sets Windows to log genie on at the next boot, in this VM only
#   ... -Phase wait-logon       waits for a logged-on session after that boot
#   ... -Phase persist-write    then a reboot, then   ... -Phase persist-read    a value written in one boot and read in the next, each in the logged-on session
#   ... -Phase autologon-clear  takes it away again
#   ... -Phase script -Script scripts\x.mjs [-Minutes 25]    any script (.mjs by node, .ps1 by PowerShell), in the logged-on person's session, its output printed when it ends and its exit code passed on
# The whole sequence, reboot included: scripts/vm-keychain-windows.sh in the envelope.
param([Parameter(Mandatory = $true)][ValidateSet('ssh', 'interactive', 'persist-write', 'persist-read', 'logon-install', 'logon-read', 'autologon', 'autologon-clear', 'wait-logon', 'script')][string]$Phase, [string]$Script = '', [int]$Minutes = 25)
# Continue: quser and schtasks write to stderr in ordinary answers, and under Stop PowerShell 5.1 turns that into a throw (quser with nobody on: "No User exists", batch F0).
$ErrorActionPreference = 'Continue'
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
function Active-Sessions { @(cmd /c 'quser 2>nul' | Where-Object { $_ -match '\bActive\b' }) }
$repo = (Get-Location).Path
$node = (Get-Command node).Source
$env:KEYCHAIN_MEASURE_ALLOW = '1'
$logonFile = Join-Path $env:PUBLIC 'genie-keychain-at-logon.txt'

function Say-Session {
    $groups = (whoami /groups) -join "`n"
    $kinds = @('INTERACTIVE', 'NETWORK', 'SERVICE', 'BATCH', 'REMOTE INTERACTIVE') | Where-Object { $groups -match "NT AUTHORITY\\$_\b" }
    $elevated = ((whoami /groups) -match 'S-1-16-12288').Count -gt 0
    Write-Output "### keychain-sessions session user=$(whoami) kinds=$($kinds -join ',') elevated=$elevated"
    Write-Output "--- VaultSvc: $((Get-Service VaultSvc).Status)"
}

# The measure in the logged-on person's session, as a task "run only when logged on". Exit 4 if nobody is logged on.
function In-Session([string]$measurePhase) {
    $someone = Active-Sessions
    if ($someone.Count -eq 0) { Write-Output '### keychain-sessions interactive=NEEDS-A-LOGGED-ON-SESSION  quser shows nobody active: log someone on, or set autologon'; return 4 }
    Write-Output "--- active: $($someone -join '; ')"
    $out = Join-Path $env:PUBLIC 'genie-keychain-interactive.txt'
    $done = "$out.done"
    Remove-Item -Force -ErrorAction SilentlyContinue $out, $done
    $cmd = Join-Path $env:PUBLIC 'genie-keychain-interactive.cmd'
    Set-Content -Encoding ASCII -Path $cmd -Value @"
@echo off
cd /d "$repo"
set KEYCHAIN_MEASURE_ALLOW=1
whoami /groups > "$out" 2>&1
"$node" scripts/perf-lag/keychain-measure.mjs $measurePhase >> "$out" 2>&1
echo %ERRORLEVEL% > "$done"
"@
    $name = 'GenieKeychainInteractive'
    schtasks /Create /TN $name /TR "`"$cmd`"" /SC ONCE /ST 23:59 /IT /F /RL LIMITED | Out-Null
    try {
        schtasks /Run /TN $name | Out-Null
        $deadline = (Get-Date).AddSeconds(240)
        while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
        if (-not (Test-Path $done)) { Write-Output '### keychain-sessions interactive=FAIL  the task did not finish within 240 s'; if (Test-Path $out) { Get-Content $out }; return 1 }
        $text = Get-Content $out
        $kinds = @('INTERACTIVE', 'NETWORK', 'BATCH') | Where-Object { ($text -join "`n") -match "NT AUTHORITY\\$_\b" }
        Write-Output "### keychain-sessions interactive-session kinds=$($kinds -join ',')"
        $text | Where-Object { $_ -notmatch '^(GROUP INFORMATION|Group Name|=|$)' -and $_ -notmatch 'S-1-' }
        return [int](Get-Content $done).Trim()
    } finally { schtasks /Delete /TN $name /F 2>$null | Out-Null }
}

# Everything new in a file since last time, as it comes. The script holds it open, so it is read shared. A hang must say where it hung, and this printed nothing for 42 minutes in batch HH.
$script:positions = @{}
function Drain([string]$file, [string]$prefix = '') {
    if (-not (Test-Path $file)) { return }
    try {
        $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
        try {
            $at = if ($script:positions.ContainsKey($file)) { $script:positions[$file] } else { 0 }
            if ($stream.Length -le $at) { return }
            $stream.Seek($at, [System.IO.SeekOrigin]::Begin) | Out-Null
            $bytes = New-Object byte[] ($stream.Length - $at)
            $count = $stream.Read($bytes, 0, $bytes.Length)
            $text = [System.Text.Encoding]::UTF8.GetString($bytes, 0, $count)
            # Only whole lines: the rest waits for the next look.
            $end = $text.LastIndexOf("`n")
            if ($end -lt 0) { return }
            $script:positions[$file] = $at + [System.Text.Encoding]::UTF8.GetByteCount($text.Substring(0, $end + 1))
            foreach ($line in ($text.Substring(0, $end) -split "`r?`n")) { Write-Output "$prefix$line" }
        } finally { $stream.Dispose() }
    } catch { Write-Output "--- could not read $file : $($_.Exception.Message)" }
}

function Say-What-Is-Running([string]$why) {
    Write-Output "--- $why"
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(node|electron|genie|powershell|cmd|consent|credentialuibroker|werfault)' -and $_.ProcessId -ne $PID } | ForEach-Object {
        $line = "$($_.Name) $($_.ProcessId) (parent $($_.ParentProcessId), session $($_.SessionId)) $($_.CommandLine)"
        Write-Output ('    ' + $line.Substring(0, [Math]::Min(220, $line.Length)))
    }
}

# A whole script in the logged-on session. What the host it starts inherits is that session, which is what Credential Manager needs. Its output and the session's windows are printed as they come; at the deadline
# what is running and what Genie logged are printed too, the session's task is ended, and this exits non-zero.
function Script-In-Session {
    if (-not $Script) { Write-Output '### keychain-sessions script=FAIL  name a -Script'; exit 2 }
    if ((Active-Sessions).Count -eq 0) { Write-Output '### keychain-sessions script=NEEDS-A-LOGGED-ON-SESSION'; exit 4 }
    $out = Join-Path $env:PUBLIC 'genie-session-script.txt'
    $done = "$out.done"
    $windows = Join-Path $env:PUBLIC 'genie-session-windows.txt'
    Remove-Item -Force -ErrorAction SilentlyContinue $out, $done, $windows
    $cmd = Join-Path $env:PUBLIC 'genie-session-script.cmd'
    $runner = if ($Script -like '*.ps1') { 'powershell -NoProfile -ExecutionPolicy Bypass -File' } else { "`"$node`"" }
    Set-Content -Encoding ASCII -Path $cmd -Value @"
@echo off
cd /d "$repo"
set QUIT_CDP_ALLOW=1
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$repo\scripts\perf-lag\session-watch-windows.ps1" -Done "$done" -Log "$windows" -Shot "$repo\session-shot"
$runner "$Script" > "$out" 2>&1
echo %ERRORLEVEL% > "$done"
"@
    $name = 'GenieSessionScript'
    schtasks /Create /TN $name /TR "`"$cmd`"" /SC ONCE /ST 23:59 /IT /F /RL LIMITED | Out-Null
    $began = Get-Date
    $deadline = $began.AddMinutes($Minutes)
    $beat = $began
    try {
        schtasks /Run /TN $name | Out-Null
        Write-Output "--- in the session: $Script, up to $Minutes minutes"
        while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 3
            Drain $out
            Drain $windows '--- session '
            if (((Get-Date) - $beat).TotalSeconds -ge 120) {
                $beat = Get-Date
                $state = (schtasks /Query /TN $name /FO LIST | Select-String 'Status').ToString().Trim()
                Write-Output "--- still running after $([int]((Get-Date) - $began).TotalMinutes) min: task $state; output file $(if (Test-Path $out) { (Get-Item $out).Length } else { 'not there' }) bytes"
            }
        }
        Start-Sleep -Seconds 1
        Drain $out
        Drain $windows '--- session '
        if (-not (Test-Path $done)) {
            Write-Output "### keychain-sessions script=FAIL  $Script did not finish within $Minutes minutes"
            Say-What-Is-Running 'what is running'
            Write-Output "--- the task: $((schtasks /Query /TN $name /FO LIST | Select-String 'Status|Last Result') -join '; ')"
            foreach ($log in @((Join-Path $env:USERPROFILE '.genie\runtime\lifecycle.log'), (Join-Path $env:USERPROFILE '.genie\logs\genie-host.log'))) {
                if (Test-Path $log) { Write-Output "--- the end of $log"; Get-Content $log -Tail 30 | ForEach-Object { Write-Output ('    ' + $_.Substring(0, [Math]::Min(220, $_.Length))) } }
            }
            exit 1
        }
        exit [int](Get-Content $done).Trim()
    } finally {
        schtasks /End /TN $name 2>$null | Out-Null
        schtasks /Delete /TN $name /F 2>$null | Out-Null
        # What the task started outlives the task. Not this process, nor the alias's proxy.
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$($Script -replace '/', '*')*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        if (-not (Test-Path $done)) { Set-Content -Path $done -Value 1 -ErrorAction SilentlyContinue }
    }
}

function Run-In-Session([string]$measurePhase) {
    $code = 1
    In-Session $measurePhase | ForEach-Object { if ($_ -is [int]) { $code = $_ } else { Write-Output $_ } }
    exit $code
}

switch ($Phase) {
    'ssh' {
        Say-Session
        & $node scripts/perf-lag/keychain-measure.mjs before
        exit $LASTEXITCODE
    }
    'interactive' { Run-In-Session 'before' }
    'script' { Script-In-Session }
    'persist-write' { Run-In-Session 'persist-write' }
    'persist-read' { Run-In-Session 'persist-read' }
    'autologon' {
        $password = [Console]::In.ReadLine()
        if (-not $password) { Write-Output '### keychain-sessions autologon=FAIL  no password on stdin'; exit 1 }
        Set-ItemProperty -Path $winlogon -Name AutoAdminLogon -Value '1'
        Set-ItemProperty -Path $winlogon -Name DefaultUserName -Value $env:USERNAME
        Set-ItemProperty -Path $winlogon -Name DefaultDomainName -Value $env:COMPUTERNAME
        Set-ItemProperty -Path $winlogon -Name DefaultPassword -Value $password
        # A session whose screen stays on: VBoxManage's screenshot of a hang was black.
        powercfg /change monitor-timeout-ac 0
        powercfg /change standby-timeout-ac 0
        Write-Output "### keychain-sessions autologon=PASS  $env:USERNAME logs on at the next boot"
    }
    'autologon-clear' {
        Set-ItemProperty -Path $winlogon -Name AutoAdminLogon -Value '0'
        Remove-ItemProperty -Path $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue
        Write-Output '### keychain-sessions autologon-clear=PASS'
    }
    'wait-logon' {
        $began = Get-Date
        $deadline = $began.AddSeconds(240)
        $someone = Active-Sessions
        while ($someone.Count -eq 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2; $someone = Active-Sessions }
        if ($someone.Count -eq 0) { Write-Output '### keychain-sessions wait-logon=FAIL  nobody logged on within 240 s of ssh coming back'; exit 1 }
        Write-Output "### keychain-sessions wait-logon=PASS  after $([int]((Get-Date) - $began).TotalSeconds) s: $($someone -join '; ')"
    }
    'logon-install' {
        Remove-Item -Force -ErrorAction SilentlyContinue $logonFile
        $cmd = Join-Path $env:PUBLIC 'genie-keychain-at-logon.cmd'
        Set-Content -Encoding ASCII -Path $cmd -Value "@echo off`r`n`"$node`" `"$repo\scripts\perf-lag\keychain-at-logon.mjs`" `"$logonFile`" `"$repo`""
        schtasks /Create /TN GenieKeychainAtLogon /TR "`"$cmd`"" /SC ONLOGON /IT /F /RL LIMITED /RU $env:USERNAME | Out-Null
        Write-Output '### keychain-sessions logon-install=PASS  now log off and on, or reboot with autologon, then -Phase logon-read'
    }
    'logon-read' {
        try {
            if (-not (Test-Path $logonFile)) { Write-Output '### keychain-sessions logon-read=FAIL  no result: nobody has logged on since the install'; exit 1 }
            Get-Content $logonFile
            $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
            Write-Output "--- last boot $($boot.ToString('o'))"
        } finally { schtasks /Delete /TN GenieKeychainAtLogon /F 2>$null | Out-Null }
    }
}
