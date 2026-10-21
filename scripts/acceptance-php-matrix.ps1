# PHP acceptance (genie#1043): opcache on with 1 worker, off with 4, on with 4 — on the NTS build Genie manages, and on the
# ZTS build a FrankenPHP-era machine has on PATH (genie#669) — to tell which change does what, on which PHP. Then GENIE'S
# TOOLCHAIN PHP (part B): ZTS with opcache off (the control — what moic.gen ran), and ZTS and NTS started with the
# product's own command (opcache by -d flags).
npm ci --no-audit --no-fund *> "$env:TEMP\ci.log"
if ($LASTEXITCODE -ne 0) { Get-Content "$env:TEMP\ci.log" -Tail 20; exit 1 }
$runs = @(@('nts', 'on', '1', 'managed'), @('nts', 'off', '4', 'managed'), @('nts', 'on', '4', 'managed'), @('ts', 'on', '4', 'managed'), @('ts', 'off', '4', 'managed'), @('ts', 'on', '4', 'toolchain'), @('nts', 'on', '4', 'toolchain'))
foreach ($r in $runs) {
    Write-Output "=== $($r[0]): opcache $($r[1]), workers $($r[2]), $($r[3])"
    $env:ACCEPT_PHP_BUILD = $r[0]
    $env:ACCEPT_PHP_OPCACHE = $r[1]
    $env:ACCEPT_PHP_WORKERS = $r[2]
    $env:ACCEPT_PHP_MODE = $r[3]
    npx tsx scripts/acceptance-php.ts
}
exit 0
