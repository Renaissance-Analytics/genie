# THE WINDOWS TRACK PACKAGES' SIGNATURES, BEFORE THEIR MANIFESTS ARE SIGNED (Tynn #1058 L8; the spec's "Signed executables").
# release.yml's tracks-windows job runs it on the trees scripts/build-track-packages.mjs laid out and packed
# (release/tracks/trees/<track>), after the launcher was signed (scripts/sign-windows-files.mjs) and the client built with
# --signed. A package's manifest hashes these exact bytes, so a program signed after this point would not match it.
#
#   - Genie's own programs (client\genie-client.exe, host\genie-host.exe, launcher\Genie.exe) are present and signed by
#     Renaissance Analytics, Valid, with a timestamp.
#   - Every other .exe, .dll and .node in the three trees has a Valid signature: ours (with a timestamp), or the one its own
#     publisher gave it. The app's own release verifier (verify-windows-signatures.ps1) holds the finer rule of which files
#     the build signs; these trees are made from that same signed build.
# Evidence: release/signature-evidence/track-signatures.json.
param([string]$Trees = 'release/tracks/trees')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path -LiteralPath $Trees).Path
$ours = '(?:^|,\s*)CN=(?:"Renaissance Analytics"|Renaissance Analytics)(?:,|$)'
$programs = @('client\genie-client.exe', 'host\genie-host.exe', 'launcher\Genie.exe')
foreach ($p in $programs) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $p) -PathType Leaf)) { throw "Missing Genie program in the track trees: $p" }
}
$own = @{}
foreach ($p in $programs) { $own[(Get-Item -LiteralPath (Join-Path $root $p)).FullName] = $true }

$files = @(foreach ($t in @('client', 'host', 'launcher')) {
    Get-ChildItem -LiteralPath (Join-Path $root $t) -Recurse -File | Where-Object { $_.Extension.ToLowerInvariant() -in @('.exe', '.dll', '.node') }
})
if ($files.Count -lt $programs.Count) { throw "Only $($files.Count) program file(s) under $root" }
$records = foreach ($f in $files) {
    $s = Get-AuthenticodeSignature -LiteralPath $f.FullName
    if ($s.Status -ne 'Valid') { throw "Invalid Windows signature ($($s.Status)): $($f.FullName)" }
    $subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }
    $isOurs = $subject -match $ours
    if ($own.ContainsKey($f.FullName) -and -not $isOurs) { throw "Genie's program is not signed by Renaissance Analytics: $($f.FullName) ($subject)" }
    if ($isOurs -and $null -eq $s.TimeStamperCertificate) { throw "Missing Authenticode timestamp: $($f.FullName)" }
    $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
    Write-Host "VALID$(if (-not $isOurs) { ' (its own publisher)' }): $($f.FullName) | $subject | SHA256: $hash"
    [pscustomobject]@{ File = $f.FullName; Signer = $subject; Ours = $isOurs; SHA256 = $hash }
}
$evidence = Join-Path (Split-Path (Split-Path $root -Parent) -Parent) 'signature-evidence'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
@($records) | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $evidence 'track-signatures.json') -Encoding utf8
Write-Host "Verified $(@($records).Count) signatures in the Windows track trees; Genie's three programs are signed by Renaissance Analytics."
