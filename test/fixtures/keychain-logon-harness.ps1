# Execute the real entry point with only its OS boundaries replaced. No task, registry,
# credential, or logon operation reaches the test runner's machine.
$ErrorActionPreference = 'Stop'
$global:hookState = [ordered]@{
    value = 'old hook'
    writes = @()
    reads = @()
    removals = @()
    tasks = @()
    otherValue = 'leave this alone'
}
function schtasks {
    $global:hookState.tasks += ,@($args)
    $global:LASTEXITCODE = 5
    Write-Output 'ERROR: Access is denied.'
}
function New-Item {
    [CmdletBinding()]
    param([string]$Path, [switch]$Force)
    if ($env:HOOK_CASE -eq 'key-denied') { Write-Error 'Run key access denied'; return }
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
    $global:hookState.value = $null
}
function Get-CimInstance {
    param([string]$ClassName)
    [pscustomobject]@{ LastBootUpTime = [datetime]'2026-11-07T00:00:00Z' }
}
$resultCode = 1
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
