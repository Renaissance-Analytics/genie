# Execute the real entry point with only its OS boundaries replaced. No task, registry,
# credential, or logon operation reaches the test runner's machine.
$ErrorActionPreference = 'Stop'
$global:hookState = [ordered]@{
    value = 'old hook'
    keyExists = ($env:HOOK_CASE -ne 'key-denied' -and $env:HOOK_CASE -ne 'new-key')
    creates = @()
    writes = @()
    reads = @()
    removals = @()
    tasks = @()
    otherValue = 'leave this alone'
}
function Get-Location { [pscustomobject]@{ Path = $env:HOOK_REPO } }
function Get-Command { param([string]$Name) [pscustomobject]@{ Source = 'C:\Program Files\nodejs\node.exe' } }
function schtasks {
    $global:hookState.tasks += ,@($args)
    if ($args -contains '/Create') {
        $global:LASTEXITCODE = 5
        Write-Output 'ERROR: Access is denied.'
    } else { $global:LASTEXITCODE = 0 }
}
function Test-Path {
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$Path)
    $target = if ($LiteralPath) { $LiteralPath } else { $Path }
    if ($target -eq 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') { return $global:hookState.keyExists }
    Microsoft.PowerShell.Management\Test-Path -LiteralPath $target
}
function New-Item {
    [CmdletBinding()]
    param([string]$Path, [switch]$Force)
    $global:hookState.creates += @{ path = $Path; force = [bool]$Force }
    if ($env:HOOK_CASE -eq 'key-denied') { Write-Error 'Run key access denied'; return }
    if ($global:hookState.keyExists -and $Force) { $global:hookState.otherValue = $null }
    $global:hookState.keyExists = $true
    [pscustomobject]@{ Name = $Path }
}
function New-ItemProperty {
    [CmdletBinding()]
    param([string]$Path, [string]$Name, [string]$Value, [string]$PropertyType, [switch]$Force)
    $global:hookState.writes += @{ path = $Path; name = $Name; value = $Value; type = $PropertyType; force = [bool]$Force }
    if ($env:HOOK_CASE -eq 'write-denied') { Write-Error 'Run value access denied'; return }
    if ($env:HOOK_CASE -ne 'write-ignored') { $global:hookState.value = $Value }
}
function Get-ItemPropertyValue {
    [CmdletBinding()]
    param([string]$Path, [string]$Name)
    $global:hookState.reads += @{ path = $Path; name = $Name }
    if ($env:HOOK_CASE -eq 'read-denied') { Write-Error 'Run value cannot be read'; return }
    if ($env:HOOK_CASE -eq 'read-missing') { return $null }
    if ($env:HOOK_CASE -eq 'read-mismatch') { return 'a different command' }
    $global:hookState.value
}
function Remove-ItemProperty {
    [CmdletBinding()]
    param([string]$Path, [string]$Name)
    $global:hookState.removals += @{ path = $Path; name = $Name }
    if ($env:HOOK_CASE -eq 'remove-denied') { Write-Error 'Run value cannot be removed'; return }
    if ($env:HOOK_CASE -ne 'remove-ignored') { $global:hookState.value = $null }
}
function Get-ItemProperty {
    [CmdletBinding()]
    param([string]$LiteralPath)
    if ($env:HOOK_CASE -eq 'cleanup-read-denied') { Write-Error 'Run key cannot be read'; return }
    $values = @{ OtherStartup = $global:hookState.otherValue }
    if ($null -ne $global:hookState.value) { $values['GenieKeychainAtLogon'] = $global:hookState.value }
    [pscustomobject]$values
}
function Get-CimInstance {
    param([string]$ClassName)
    [pscustomobject]@{ LastBootUpTime = [datetime]'2026-11-07T00:00:00Z' }
}
$resultCode = 1
if ($env:HOOK_CASE -eq 'already-removed') { $global:hookState.value = $null }
try {
    $global:LASTEXITCODE = 0
    & $env:HOOK_SCRIPT -Phase $env:HOOK_PHASE
    $resultCode = $LASTEXITCODE
} catch {
    Write-Output "harness caught: $($_.Exception.Message)"
} finally {
    $global:hookState | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $env:HOOK_STATE
}
exit $resultCode
