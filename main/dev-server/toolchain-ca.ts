import { readFile, rm } from 'node:fs/promises';
import { defaultCommandRunner } from './seams';
import { caBundlePath } from './toolchain-versions';

/**
 * The CA bundle Genie's PHP needs, taken from the machine's own root store.
 *
 * The defect this exists for: the Windows PHP zip ships NO CA bundle, and its
 * compiled-in default points at `C:\\Program Files\\Common Files\\SSL/cert.pem`, which
 * does not exist. Genie's generated `php.ini` named no `curl.cainfo` and no
 * `openssl.cafile`, so EVERY outbound HTTPS request from a hosted PHP site
 * failed — errno 60, "unable to get local issuer certificate" — against every
 * host, not one provider. Reproduced against the real API before the fix:
 * `FAIL errno=60` with Genie's config, `OK http=405` with a bundle.
 *
 * It hides well: a developer's own PHP (Herd, XAMPP) has a bundle configured, so
 * the CLI and `artisan serve` work, and only `hostServe: php` fails.
 *
 * EXPORTED, not shipped. A bundled Mozilla list goes stale between releases —
 * and on a machine behind a TLS-inspecting corporate proxy it fails for every
 * host, because the issuing root exists only in that machine's own store. The OS
 * store is the one place both ordinary and corporate anchors are already right.
 *
 * Node and Python were checked and need nothing: both carry their own trust.
 *
 * WHY POWERSHELL WRITES THE FILE and Node never sees the bytes: the first cut
 * printed the roots to stdout and parsed them here. `defaultCommandRunner` keeps
 * only the LAST 8,000 bytes of stdout, so a 130 KB export silently became its
 * own tail — 4 roots out of 80, the first one starting mid-base64. It exited 0
 * and wrote a plausible file. A bundle missing 95% of its anchors is worse than
 * none, because the ini now claims trust is configured and the next person to
 * look stops here. Nothing large crosses stdout any more; the command reports a
 * COUNT, and the file is verified after it is written.
 */

/** A read-only command that writes the machine's root store to `destPath`, or
 *  null on a platform where PHP already resolves the system bundle. */
export interface CaExportPlan {
    command: string;
    args: string[];
    destPath: string;
}

/**
 * PURE. How to export this machine's root store to a file.
 *
 * Windows only. On mac/Linux openssl's compiled-in defaults already find the
 * system bundle, which is why this bug is Windows-only — and why writing an ini
 * line there would override something that is already correct.
 *
 * A READ of the certificate store. It never imports, removes or modifies a
 * certificate: changing the machine's trust is not something a dev tool may do,
 * least of all as a side effect of installing PHP. `LocalMachine\\Root` is
 * readable by any user, so this needs no elevation.
 */
export function planCaExport(platform: string, destPath: string): CaExportPlan | null {
    if (platform !== 'win32') return null;
    // Single-quoted for PowerShell, with any embedded quote doubled — a version
    // directory is Genie-generated, but a path is never pasted into a shell
    // unescaped on the assumption that it is safe.
    const dest = "'" + destPath.replace(/'/g, "''") + "'";
    const script = [
        '$ErrorActionPreference = "Stop"',
        '$all = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection',
        // Windows Update FIRST, and it is the load-bearing source. The local
        // store is lazily populated — 81 roots here against 554 from WU — and a
        // static PEM cannot fetch a missing one the way CryptoAPI does.
        // Guarded: offline, or WU blocked by policy, must still produce the
        // bundle the local store can supply.
        'try {',
        '  $sst = Join-Path $env:TEMP ("genie-roots-" + [Guid]::NewGuid().ToString("N") + ".sst")',
        '  $null = & certutil -generateSSTFromWU $sst 2>&1',
        '  if (Test-Path $sst) { $all.Import($sst); Remove-Item $sst -Force -ErrorAction SilentlyContinue }',
        '} catch { }',
        // …then the machine's own store, NOT instead of it: a TLS-inspecting
        // corporate proxy's root exists only here (7 such roots on this machine).
        // Unguarded — a failure here means there is genuinely nothing to write.
        'foreach ($c in Get-ChildItem Cert:\\LocalMachine\\Root) { $null = $all.Add($c) }',
        '$seen = @{}',
        '$sb = New-Object System.Text.StringBuilder',
        '$n = 0',
        // Deduped by thumbprint: the two sources overlap almost entirely, and a
        // bundle listing most roots twice cannot be read to answer "what do I
        // trust".
        'foreach ($c in $all) {',
        '  if ($seen.ContainsKey($c.Thumbprint)) { continue }',
        '  $seen[$c.Thumbprint] = $true',
        '  [void]$sb.AppendLine("# " + $c.Subject)',
        '  [void]$sb.AppendLine("-----BEGIN CERTIFICATE-----")',
        '  [void]$sb.AppendLine([Convert]::ToBase64String($c.RawData, [Base64FormattingOptions]::InsertLineBreaks))',
        '  [void]$sb.AppendLine("-----END CERTIFICATE-----")',
        '  $n++',
        '}',
        `[IO.File]::WriteAllText(${dest}, $sb.ToString())`,
        'Write-Output $n',
    ].join('; ');
    return {
        command: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', script],
        destPath,
    };
}

/** PURE. How many usable certificates a written bundle actually contains. */
export function countCertificates(pem: string): number {
    return (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
}

/**
 * Build a version's `cacert.pem` and return its path, or null if none could be
 * produced.
 *
 * Null is a real answer and the caller must honour it by leaving both ini
 * settings unset: naming a bundle that is not there turns errno 60 into errno
 * 77 and fixes nothing.
 *
 * The written file is READ BACK and counted before it is accepted. A zero-cert
 * or truncated bundle is deleted rather than left on disk, because a `cacert.pem`
 * that exists is taken as evidence the trust problem was solved.
 *
 * Never throws: a PHP that installs without a bundle is today's behaviour, while
 * an install that FAILS over one would be a regression.
 */
export async function writeCaBundle(
    versionDir: string,
    platform: string,
    deps: {
        run?: (cmd: string, args: string[]) => Promise<{ code: number }>;
        read?: (path: string) => Promise<string>;
        remove?: (path: string) => Promise<void>;
    } = {},
): Promise<string | null> {
    const dest = caBundlePath(versionDir, platform);
    const plan = planCaExport(platform, dest);
    if (!plan) return null;

    const run =
        deps.run ??
        ((cmd: string, args: string[]) => defaultCommandRunner.run(cmd, args, { timeoutMs: 120_000 }));
    const read = deps.read ?? ((p: string) => readFile(p, 'utf8'));
    const remove = deps.remove ?? ((p: string) => rm(p, { force: true }));

    try {
        const res = await run(plan.command, plan.args);
        if (res.code !== 0) return null;
        // Verify what landed, not what the command claimed. Exit 0 with a
        // truncated file is exactly the failure this function was rewritten for.
        const written = await read(dest);
        if (countCertificates(written) === 0) {
            await remove(dest).catch(() => {});
            return null;
        }
        return dest;
    } catch {
        await remove(dest).catch(() => {});
        return null;
    }
}
