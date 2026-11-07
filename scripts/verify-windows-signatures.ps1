param([string]$ReleaseDir = 'release')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$releaseRoot = (Resolve-Path -LiteralPath $ReleaseDir).Path
$appDir = Join-Path $releaseRoot 'win-unpacked'
$evidenceDir = Join-Path $releaseRoot 'signature-evidence'
$uninstaller = Join-Path $evidenceDir 'nsis-uninstaller.exe'
$planFile = Join-Path $evidenceDir 'win-sign-plan.json'

# Positive inventory: an empty or incomplete tree cannot pass a recursive signature scan.
foreach ($relative in @('Genie.exe', 'resources/bin/genie-launch.exe')) {
    $required = Join-Path $appDir $relative
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing required Windows binary: $required" }
}
if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw "Missing signed NSIS uninstaller evidence: $uninstaller" }
$installers = @(Get-ChildItem -LiteralPath $releaseRoot -File -Filter '*-setup.exe')
if ($installers.Count -ne 1) { throw "Expected exactly one Windows setup installer, found $($installers.Count)" }

# WHAT THE BUILD DID NOT SIGN (scripts/win-sign-plan.mjs, run on this tree just before, by electron-builder's own rule):
# a file another publisher already signed (Microsoft's conpty.dll, OpenConsole.exe, d3dcompiler_47.dll). It must still
# carry that publisher's valid signature. Signed again by us, stripped, or broken, it fails here. With no plan, every
# file must be ours, the stricter rule: a missing plan step makes Microsoft's files fail, it never lets one through.
$notSigned = @{}
if (Test-Path -LiteralPath $planFile -PathType Leaf) {
    $plan = Get-Content -LiteralPath $planFile -Raw | ConvertFrom-Json
    # Each key through Get-ChildItem, the same call that lists the payload below: a path given in its 8.3 form
    # (C:\Users\RUNNER~1\...) is the long form in what Get-ChildItem returns, and Join-Path alone kept the short one, so
    # nothing matched (the verifier row, job 128421475212).
    foreach ($row in $plan.rows) {
        if ($row.wouldSign) { continue }
        $item = Get-ChildItem -LiteralPath (Join-Path $appDir ($row.file -replace '/', '\')) -File -ErrorAction SilentlyContinue
        if ($item) { $notSigned[$item.FullName] = $true }
    }
    Write-Host "Sign plan: $planFile, $($notSigned.Count) file(s) the build does not sign keep their own publisher's signature"
}

$ours = '(?:^|,\s*)CN=(?:"Renaissance Analytics"|Renaissance Analytics)(?:,|$)'
# Include every shipped exe/dll, including extraResources (launcher, Caddy), native helpers,
# Electron DLLs and the late-added NSIS elevate.exe. No vendor/path exclusions: a file the build does not sign is
# checked too, for its own publisher's signature.
$payload = @(Get-ChildItem -LiteralPath $appDir -Recurse -File | Where-Object { $_.Extension.ToLowerInvariant() -in @('.exe', '.dll') })
$files = @($payload.FullName) + @($installers.FullName) + @($uninstaller)
$records = foreach ($file in ($files | Sort-Object -Unique)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid') { throw "Invalid Windows signature ($($signature.Status)): $file" }
    $certificate = $signature.SignerCertificate
    if ($false -and $notSigned.ContainsKey($file)) { # BREAK PROBE a: the plan is ignored
        # keeps its publisher's signature: valid, and not ours.
        if ($null -eq $certificate -or $certificate.Subject -match $ours) { throw "Another publisher's file was signed by us (it must keep its publisher's signature): $file" }
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        Write-Host "VALID (its own publisher): $file | $($certificate.Subject) | SHA256: $hash"
        [pscustomobject]@{ File = $file; Status = [string]$signature.Status; Signer = $certificate.Subject;
            TimestampSigner = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null }; SHA256 = $hash }
        continue
    }
    if ($null -eq $certificate -or $certificate.Subject -notmatch $ours -or
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
Write-Host "Verified $(@($records).Count) Windows signatures: ours (Valid, Renaissance Analytics CN, timestamp present), or the build's untouched files keeping their own publisher's valid signature."
