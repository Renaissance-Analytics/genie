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
param([Parameter(Mandatory = $true)][ValidateSet('ssh', 'interactive', 'logon-install', 'logon-read')][string]$Phase)
$ErrorActionPreference = 'Stop'
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

switch ($Phase) {
    'ssh' {
        Say-Session
        & $node scripts/perf-lag/keychain-measure.mjs before
        exit $LASTEXITCODE
    }
    'interactive' {
        $someone = @(quser 2>$null | Where-Object { $_ -match '\bActive\b' })
        if ($someone.Count -eq 0) { Write-Output '### keychain-sessions interactive=NEEDS-A-LOGGED-ON-SESSION  quser shows nobody active: log someone on, or set autologon'; exit 4 }
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
"$node" scripts/perf-lag/keychain-measure.mjs before >> "$out" 2>&1
echo %ERRORLEVEL% > "$done"
"@
        $name = 'GenieKeychainInteractive'
        schtasks /Create /TN $name /TR "`"$cmd`"" /SC ONCE /ST 23:59 /IT /F /RL LIMITED | Out-Null
        try {
            schtasks /Run /TN $name | Out-Null
            $deadline = (Get-Date).AddSeconds(240)
            while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
            if (-not (Test-Path $done)) { Write-Output '### keychain-sessions interactive=FAIL  the task did not finish within 240 s'; if (Test-Path $out) { Get-Content $out }; exit 1 }
            $text = Get-Content $out
            $kinds = @('INTERACTIVE', 'NETWORK', 'BATCH') | Where-Object { ($text -join "`n") -match "NT AUTHORITY\\$_\b" }
            Write-Output "### keychain-sessions interactive-session kinds=$($kinds -join ',')"
            $text | Where-Object { $_ -notmatch '^(GROUP INFORMATION|Group Name|=|$)' -and $_ -notmatch 'S-1-' }
            exit [int](Get-Content $done).Trim()
        } finally { schtasks /Delete /TN $name /F 2>$null | Out-Null }
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
