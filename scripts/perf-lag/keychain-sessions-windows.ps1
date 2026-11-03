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
#   ... -Phase script -Script scripts\x.mjs [-Minutes 25]    any script, in the logged-on person's session, its output printed when it ends and its exit code passed on
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

# A whole script in the logged-on session. What the host it starts inherits is that session, which is what Credential Manager needs.
function Script-In-Session {
    if (-not $Script) { Write-Output '### keychain-sessions script=FAIL  name a -Script'; exit 2 }
    if ((Active-Sessions).Count -eq 0) { Write-Output '### keychain-sessions script=NEEDS-A-LOGGED-ON-SESSION'; exit 4 }
    $out = Join-Path $env:PUBLIC 'genie-session-script.txt'
    $done = "$out.done"
    Remove-Item -Force -ErrorAction SilentlyContinue $out, $done
    $cmd = Join-Path $env:PUBLIC 'genie-session-script.cmd'
    Set-Content -Encoding ASCII -Path $cmd -Value @"
@echo off
cd /d "$repo"
"$node" "$Script" > "$out" 2>&1
echo %ERRORLEVEL% > "$done"
"@
    $name = 'GenieSessionScript'
    schtasks /Create /TN $name /TR "`"$cmd`"" /SC ONCE /ST 23:59 /IT /F /RL LIMITED | Out-Null
    try {
        schtasks /Run /TN $name | Out-Null
        $deadline = (Get-Date).AddMinutes($Minutes)
        while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
        if (Test-Path $out) { Get-Content $out }
        if (-not (Test-Path $done)) { Write-Output "### keychain-sessions script=FAIL  it did not finish within $Minutes minutes"; exit 1 }
        exit [int](Get-Content $done).Trim()
    } finally { schtasks /Delete /TN $name /F 2>$null | Out-Null }
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
