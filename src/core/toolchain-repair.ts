import { compareVersions, VC_RUNTIME_DLLS, type Platform } from './toolchain.js';

/**
 * CHECK AND REPAIR (§6.6) — the pure half. What is wrong with this machine's toolchain, in the three ways Genie 1 found
 * in real use, and what Genie can do about each:
 *
 * 1. **PATH precedence.** An older copy of a tool earlier on PATH shadows the one the package manager just put there:
 *    the update "worked" and the version never moved (the owner's "php is still running with Herd's config" — on
 *    Windows PHP reads php.ini beside the binary that wins, so it is one fault, not two). Repair reorders the PATH of
 *    what GENIE runs, never the person's persisted PATH, and deletes nobody's entry: the other copy stops winning.
 * 2. **PHP's outbound TLS.** The Windows PHP zip ships NO CA bundle and its compiled-in default points at a file that
 *    does not exist, so every outbound HTTPS request from a hosted PHP site failed (errno 60) while the developer's own
 *    Herd PHP worked. Repair EXPORTS the machine's root store (never a stale shipped list — a TLS-inspecting proxy's
 *    root exists only there) to a PEM under Genie's data dir and points `curl.cainfo` / `openssl.cafile` at it in an
 *    ini Genie owns, loaded through `PHP_INI_SCAN_DIR` by the php and php-cgi Genie runs. The person's php.ini is never
 *    written. Windows only: on macOS and Linux openssl's defaults already find the system bundle, and an ini line
 *    there would override something correct.
 * 3. **The Visual C++ runtime** (Windows): PHP installs and cannot start without it. Not repaired silently — offered as
 *    an install, through the same consented path as any tool.
 *
 * HONEST REPAIR applies: each finding's result is MEASURED after the change (the tool re-resolved, the ini re-read
 * through php-cgi itself), never the step's own word.
 */

/** One copy of a tool on PATH, in PATH order, with the version it reports (`null` = it did not answer). */
export interface ToolCopy {
    readonly path: string;
    readonly version: string | null;
}

export type FindingResult =
    | { readonly kind: 'repaired'; readonly detail: string }
    | { readonly kind: 'unchanged'; readonly reason: string }
    | { readonly kind: 'needs-install'; readonly tool: string; readonly reason: string };

export type RepairFinding =
    | { readonly kind: 'path-shadow'; readonly tool: string; readonly first: ToolCopy; readonly newer: ToolCopy; readonly result: FindingResult }
    | { readonly kind: 'php-ca'; readonly problem: string; readonly result: FindingResult }
    | { readonly kind: 'vc-runtime'; readonly missing: readonly string[]; readonly result: FindingResult };

export interface RepairReport {
    readonly findings: readonly RepairFinding[];
    readonly checkedAt: number;
}

/** The binaries whose PATH order is checked: real executables, so each copy can be asked its version by full path. */
export const PRECEDENCE_TOOLS: readonly { readonly tool: string; readonly binary: string; readonly args: readonly string[] }[] = [
    { tool: 'node', binary: 'node', args: ['--version'] },
    { tool: 'php', binary: 'php', args: ['--version'] },
    { tool: 'git', binary: 'git', args: ['--version'] },
    { tool: 'python', binary: 'python', args: ['--version'] },
    { tool: 'go', binary: 'go', args: ['version'] },
];

/**
 * The paths `where` (Windows) or `which -a` (elsewhere) printed, in PATH order, de-duplicated. On Windows only `.exe`
 * copies count: `where` also lists `.cmd`/`.bat` wrappers that cannot be asked a version by path, and a repeated
 * PATH entry is the same copy twice, not two copies.
 */
export function parseLocate(output: string, platform: Platform): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of output.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || /^INFO:|not find|no .* in/i.test(line)) continue;
        if (platform === 'win32' && !/\.exe$/i.test(line)) continue;
        const key = platform === 'win32' ? line.toLowerCase() : line;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(line);
    }
    return out;
}

/**
 * The shadow, if there is one: the FIRST copy on PATH (what every command gets) is older than a later one. The newest
 * later copy is the one an update installed — Genie 2's host tools are update-to-latest. A copy that did not answer is
 * never the "newer" one (it cannot be shown to be), and an unanswering first copy is not called older.
 */
export function findShadow(copies: readonly ToolCopy[]): { first: ToolCopy; newer: ToolCopy } | null {
    const [first, ...rest] = copies;
    if (!first || first.version === null) return null;
    let newer: ToolCopy | null = null;
    for (const c of rest) {
        if (c.version === null) continue;
        if (compareVersions(c.version, first.version) > 0 && (newer === null || compareVersions(c.version, newer.version!) > 0)) newer = c;
    }
    return newer ? { first, newer } : null;
}

/** The directory a file is in, by either separator (a Windows path read on any platform stays a Windows path). */
export function dirOf(path: string): string {
    const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return i <= 0 ? path : path.slice(0, i);
}

/**
 * `dir` moved to the FRONT of a PATH string; every other entry kept, in order. Idempotent. Windows compares entries
 * case-insensitively and ignores a trailing separator, because `C:\Tools\` and `c:\tools` are the same directory.
 */
export function pathWithFirst(path: string, dir: string, platform: Platform): string {
    const sep = platform === 'win32' ? ';' : ':';
    const norm = (p: string) => {
        const t = p.replace(/[\\/]+$/, '');
        return platform === 'win32' ? t.toLowerCase() : t;
    };
    const target = norm(dir);
    const rest = path.split(sep).filter((p) => p.length > 0 && norm(p) !== target);
    return [dir, ...rest].join(sep);
}

/**
 * The persisted PATH entries (Machine, then User — what a NEW process would get) that this process does not have yet,
 * appended. A winget install edits the persisted PATH; Genie's own process was started before it and would otherwise
 * re-probe a tool it just installed as `not-installed`. Appended, never reordered: an earlier precedence repair keeps
 * its place.
 */
export function mergePersistedPath(current: string, persisted: readonly string[], platform: Platform): string {
    const sep = platform === 'win32' ? ';' : ':';
    const norm = (p: string) => (platform === 'win32' ? p.replace(/[\\/]+$/, '').toLowerCase() : p.replace(/\/+$/, ''));
    const have = new Set(current.split(sep).filter(Boolean).map(norm));
    const added: string[] = [];
    for (const raw of persisted) {
        for (const entry of raw.split(sep)) {
            const e = entry.trim();
            if (!e || have.has(norm(e))) continue;
            have.add(norm(e));
            added.push(e);
        }
    }
    return [current, ...added].filter((s) => s.length > 0).join(sep);
}

// --- PHP's CA bundle -------------------------------------------------------------------------------------------------

export interface PhpTlsConfig {
    /** `undefined`: the row is absent (that extension is not loaded); `''`: loaded with no value. */
    readonly cainfo: string | undefined;
    readonly cafile: string | undefined;
}

/**
 * `curl.cainfo` and `openssl.cafile` out of phpinfo — the text form (`php -i`: `curl.cainfo => no value => no value`)
 * or the HTML form (`php-cgi -i`: `<td class="e">curl.cainfo</td><td class="v">no value</td>…`). The LOCAL value (the
 * first one) is what a request gets. `no value` is the empty string.
 */
export function parsePhpTls(output: string): PhpTlsConfig {
    const read = (key: string): string | undefined => {
        const esc = key.replace('.', '\\.');
        const text = new RegExp(`^${esc}\\s*=>\\s*(.*?)\\s*=>`, 'm').exec(output);
        const html = new RegExp(`<td class="e">\\s*${esc}\\s*</td>\\s*<td class="v">([^<]*)</td>`, 'i').exec(output);
        const m = text ?? html;
        if (!m) return undefined;
        const v = m[1]!.trim().replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/^"|"$/g, '');
        return /^no value$/i.test(v) ? '' : v;
    };
    return { cainfo: read('curl.cainfo'), cafile: read('openssl.cafile') };
}

/**
 * What is wrong with PHP's trust, or `null` when nothing is. Windows only (see the header). A setting that is loaded
 * and empty, or names a file that is not there, is the fault: naming a missing bundle turns errno 60 into errno 77 and
 * fixes nothing. Neither row present means neither curl nor openssl is loaded — there is no outbound TLS to repair.
 */
export function phpTlsProblem(config: PhpTlsConfig, platform: Platform, exists: (path: string) => boolean): string | null {
    if (platform !== 'win32') return null;
    const problems: string[] = [];
    for (const [key, value] of [['curl.cainfo', config.cainfo], ['openssl.cafile', config.cafile]] as const) {
        if (value === undefined) continue;
        if (value === '') problems.push(`${key} is not set`);
        else if (!exists(value)) problems.push(`${key} names ${value}, which does not exist`);
    }
    return problems.length > 0 ? `PHP has no CA bundle for outbound HTTPS (${problems.join('; ')}), so every https request from a site fails with "unable to get local issuer certificate"` : null;
}

/** The ini Genie owns: both settings, because `file_get_contents('https://…')` goes through openssl, not curl. */
export function caIniContents(bundlePath: string): string {
    return [
        '; Written by Genie: the CA bundle exported from this machine\'s own root store (Toolchain → Check and repair).',
        '; Your php.ini is untouched; this file is loaded after it through PHP_INI_SCAN_DIR, for the PHP Genie runs.',
        `curl.cainfo = "${bundlePath}"`,
        `openssl.cafile = "${bundlePath}"`,
        '',
    ].join('\n');
}

/**
 * `PHP_INI_SCAN_DIR` with Genie's directory LAST (a later ini wins). With nothing set before, the value starts with the
 * separator: PHP reads an empty entry as its compiled-in scan dir, so Debian's `conf.d` (where its extensions are
 * enabled) is still read — setting the bare directory would silently unload them. Idempotent.
 */
export function phpIniScanDir(existing: string | undefined, dir: string, platform: Platform): string {
    const sep = platform === 'win32' ? ';' : ':';
    const parts = (existing ?? '').split(sep);
    if (existing !== undefined && parts.includes(dir)) return existing;
    return `${existing ?? ''}${sep}${dir}`;
}

/** How many certificates a PEM holds — a written bundle is counted before it is trusted. */
export function countCertificates(pem: string): number {
    return (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
}

/**
 * The read-only export of this machine's roots to `dest` (Genie 1's, measured there): Windows Update's root list first
 * — the local store is lazily populated, 81 roots against 554 — then the machine's own store, which is where a
 * corporate proxy's root lives; de-duplicated by thumbprint. PowerShell writes the FILE and prints only a count: a
 * 130 KB export through stdout was once silently truncated to 4 roots. It never imports or removes a certificate.
 */
export function caExportArgv(dest: string): [string, string[]] {
    const quoted = `'${dest.replace(/'/g, "''")}'`;
    const script = [
        '$ErrorActionPreference = "Stop"',
        '$all = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection',
        'try {',
        '  $sst = Join-Path $env:TEMP ("genie-roots-" + [Guid]::NewGuid().ToString("N") + ".sst")',
        '  $null = & certutil -generateSSTFromWU $sst 2>&1',
        '  if (Test-Path $sst) { $all.Import($sst); Remove-Item $sst -Force -ErrorAction SilentlyContinue }',
        '} catch { }',
        'foreach ($c in Get-ChildItem Cert:\\LocalMachine\\Root) { $null = $all.Add($c) }',
        '$seen = @{}',
        '$sb = New-Object System.Text.StringBuilder',
        '$n = 0',
        'foreach ($c in $all) {',
        '  if ($seen.ContainsKey($c.Thumbprint)) { continue }',
        '  $seen[$c.Thumbprint] = $true',
        '  [void]$sb.AppendLine("# " + $c.Subject)',
        '  [void]$sb.AppendLine("-----BEGIN CERTIFICATE-----")',
        '  [void]$sb.AppendLine([Convert]::ToBase64String($c.RawData, [Base64FormattingOptions]::InsertLineBreaks))',
        '  [void]$sb.AppendLine("-----END CERTIFICATE-----")',
        '  $n++',
        '}',
        `[IO.File]::WriteAllText(${quoted}, $sb.ToString())`,
        'Write-Output $n',
    ].join('; ');
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]];
}

// --- the Visual C++ runtime ------------------------------------------------------------------------------------------

/** The runtime DLLs missing from System32 (Windows), or `[]`. Elsewhere there is nothing to miss. */
export function missingVcRuntime(platform: Platform, files: readonly string[], exists: (path: string) => boolean): string[] {
    if (platform !== 'win32') return [];
    return files.filter((f) => !exists(f)).map((f) => VC_RUNTIME_DLLS.find((d) => f.toLowerCase().endsWith(d)) ?? f);
}
