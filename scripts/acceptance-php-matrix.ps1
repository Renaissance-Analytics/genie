# PHP acceptance (genie#1043): opcache on with 1 worker, off with 4, on with 4 — on the NTS build Genie manages, and on the
# ZTS build a FrankenPHP-era machine has on PATH (genie#669) — to tell which change does what, on which PHP.
npm ci --no-audit --no-fund *> "$env:TEMP\ci.log"
if ($LASTEXITCODE -ne 0) { Get-Content "$env:TEMP\ci.log" -Tail 20; exit 1 }
$runs = @(@('nts', 'on', '1'), @('nts', 'off', '4'), @('nts', 'on', '4'), @('ts', 'on', '4'))
foreach ($r in $runs) {
    Write-Output "=== $($r[0]): opcache $($r[1]), workers $($r[2])"
    $env:ACCEPT_PHP_BUILD = $r[0]
    $env:ACCEPT_PHP_OPCACHE = $r[1]
    $env:ACCEPT_PHP_WORKERS = $r[2]
    npx tsx scripts/acceptance-php.ts
}
exit 0
