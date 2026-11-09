param([string]$ReleaseDir = 'release')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$releaseRoot = (Resolve-Path -LiteralPath $ReleaseDir).Path
$appDir = Join-Path $releaseRoot 'win-unpacked'
$evidenceDir = Join-Path $releaseRoot 'signature-evidence'
$uninstaller = Join-Path $evidenceDir 'nsis-uninstaller.exe'

# Positive inventory: an empty or incomplete tree cannot pass a recursive signature scan.
foreach ($relative in @('Genie.exe', 'resources/bin/genie-launch.exe', 'resources/app.asar.unpacked/node_modules/@particle-academy/prism-acp/native/win32-x64/prism-acp-supervisor.exe', 'resources/app.asar.unpacked/node_modules/@particle-academy/prism-acp/native/win32-arm64/prism-acp-supervisor.exe')) {
    $required = Join-Path $appDir $relative
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing required Windows binary: $required" }
}
if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw "Missing signed NSIS uninstaller evidence: $uninstaller" }
$installers = @(Get-ChildItem -LiteralPath $releaseRoot -File -Filter '*-setup.exe')
if ($installers.Count -ne 1) { throw "Expected exactly one Windows setup installer, found $($installers.Count)" }

# Include every shipped exe/dll, including extraResources (launcher, Caddy), native helpers,
# Electron DLLs and the late-added NSIS elevate.exe. No vendor/path exclusions.
$payload = @(Get-ChildItem -LiteralPath $appDir -Recurse -File | Where-Object { $_.Extension.ToLowerInvariant() -in @('.exe', '.dll') })
$files = @($payload.FullName) + @($installers.FullName) + @($uninstaller)
$records = foreach ($file in ($files | Sort-Object -Unique)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid') { throw "Invalid Windows signature ($($signature.Status)): $file" }
    $certificate = $signature.SignerCertificate
    if ($null -eq $certificate -or $certificate.Subject -notmatch '(?:^|,\s*)CN=(?:"Renaissance Analytics"|Renaissance Analytics)(?:,|$)' -or
        $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Renaissance Analytics') {
        throw "Wrong signer CN (expected Renaissance Analytics): $file"
    }
    if ($null -eq $signature.TimeStamperCertificate) { throw "Missing Authenticode timestamp: $file" }
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    Write-Host "VALID: $file | $($certificate.Subject) | timestamp: $($signature.TimeStamperCertificate.Subject) | SHA256: $hash"
    [pscustomobject]@{ File = $file; Status = [string]$signature.Status; Signer = $certificate.Subject;
        TimestampSigner = $signature.TimeStamperCertificate.Subject; SHA256 = $hash }
}
$records | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $evidenceDir 'windows-signatures.json') -Encoding utf8
Write-Host "Verified $(@($records).Count) Windows signatures: Valid, Renaissance Analytics CN, timestamp present."
