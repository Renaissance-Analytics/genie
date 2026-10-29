/**
 * genie#1334 — MANAGED PHP REACHES A PUBLIC HTTPS HOST, FOR REAL, ON A TEST VM (never on the owner's desktop).
 *
 *   Windows (genie-test-windows):  npx tsx test/live/php-ca.live.ts
 *   Linux   (omarchy-test):        npx tsx test/live/php-ca.live.ts      (builds PHP from source: slow)
 *
 * Installs the newest PHP this release offers through Genie's OWN installer (what an Update runs since genie#1306: real
 * download, real checksum, real unpack), with the CA port main.ts gives it, into a throwaway toolchain directory. Then:
 *
 *   0. CONTROL: the same PHP with the ini as Genie wrote it before the fix (no CA directive) fails curl's verify of
 *      https://example.com with errno 60 — proving the check can see the failure fancy reported (Windows; Linux's openssl finds the
 *      system bundle by itself, so there is nothing to see there);
 *   1. the installed php.ini names curl.cainfo AND openssl.cafile, and that file exists;
 *   2. PHP (openssl: file_get_contents) and PHP (curl) both reach https://example.com and https://api.anthropic.com
 *      verified — any HTTP status counts, a TLS failure does not;
 *   3. A RESTART: the boot sweep (refreshAllManagedInis) and a pinned site's start (refreshManagedIni) rewrite the ini,
 *      and 1 and 2 still hold.
 *
 * Exits 1 on any FAIL. Run it on a tree WITHOUT the fix to see 1–3 red.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP_RECIPES, phpIniContents, type PhpPlatform } from '../../src/core/php-versions.js';
import * as phpVersions from '../../src/main/php-versions.js';
import { httpFetch, installPhpVersion, nodePhpVersionsFs, phpVersionsRoot } from '../../src/main/php-versions.js';
import * as toolchainOps from '../../src/main/toolchain-ops.js';
import { nodeToolchainFs } from '../../src/main/toolchain-ops.js';
import { execFileRunner } from '../../src/main/toolchain-runner.js';
import type { CommandRunner } from '../../src/main/toolchain-prober.js';

const platform = process.platform as PhpPlatform;
const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

const base = mkdtempSync(join(tmpdir(), 'genie-1334-'));
const dataDir = join(base, 'genie2-toolchain');
const root = phpVersionsRoot(dataDir);
const run: CommandRunner = (binary, args, options) => execFileRunner(binary, args, { timeoutMs: 45 * 60_000, ...(options?.env ? { env: options.env } : {}) });

// The CA port as main.ts builds it — absent on a tree without the fix, which is the point of a red run.
const ensure = (toolchainOps as Record<string, unknown>)['ensurePhpCaBundle'] as ((p: object) => Promise<string | null>) | undefined;
const now = (toolchainOps as Record<string, unknown>)['phpCaBundleNow'] as ((p: object) => string | null) | undefined;
const caPorts = { platform, fs: nodeToolchainFs(), dataDir, run: (b: string, a: readonly string[]) => execFileRunner(b, a, { timeoutMs: 120_000 }) };
const ca = ensure && now ? { current: () => now(caPorts), ensure: () => ensure(caPorts) } : undefined;

const fetchScript = (url: string) => [
    `$u = '${url}';`,
    // openssl: what file_get_contents and Guzzle's stream handler use.
    `$ctx = stream_context_create(['http' => ['ignore_errors' => true, 'timeout' => 20]]);`,
    `$b = @file_get_contents($u, false, $ctx); $e = error_get_last();`,
    `echo 'openssl=', $b === false ? 'FAIL ' . ($e['message'] ?? '?') : 'OK', PHP_EOL;`,
    // curl: what Guzzle's default handler and Laravel's Http use.
    `$c = curl_init($u); curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_NOBODY => true, CURLOPT_TIMEOUT => 20]);`,
    `$r = curl_exec($c);`,
    `echo 'curl=', $r === false ? 'FAIL ' . curl_errno($c) . ' ' . curl_error($c) : 'OK ' . curl_getinfo($c, CURLINFO_RESPONSE_CODE), PHP_EOL;`,
].join(' ');

function php(dir: string, code: string): string {
    const bin = join(dir, platform === 'win32' ? 'php.exe' : 'php');
    try {
        return execFileSync(bin, ['-c', join(dir, 'php.ini'), '-r', code], { encoding: 'utf8', timeout: 90_000 });
    } catch (error) {
        const e = error as { stdout?: string; message: string };
        return e.stdout ?? e.message;
    }
}

function iniValue(ini: string, key: string): string | undefined {
    const line = ini.split(/\r?\n/).find((l) => l.split('=')[0]!.trim() === key);
    return line?.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '') || undefined;
}

function reachesEverything(dir: string, label: string): void {
    for (const url of ['https://example.com/', 'https://api.anthropic.com/']) {
        const out = php(dir, fetchScript(url));
        check(/openssl=OK/.test(out), `${label}: PHP (openssl) reaches ${url} verified`, out.split(/\r?\n/).find((l) => l.startsWith('openssl=')) ?? out.trim().slice(0, 200));
        check(/curl=OK/.test(out), `${label}: PHP (curl) reaches ${url} verified`, out.split(/\r?\n/).find((l) => l.startsWith('curl=')) ?? out.trim().slice(0, 200));
    }
}

function namesExistingBundle(dir: string, label: string): void {
    const ini = readFileSync(join(dir, 'php.ini'), 'utf8');
    for (const key of ['curl.cainfo', 'openssl.cafile']) {
        const v = iniValue(ini, key);
        let exists = false;
        try { exists = v !== undefined && readFileSync(v, 'utf8').includes('BEGIN CERTIFICATE'); } catch { /* not there */ }
        check(exists, `${label}: php.ini names ${key} = a CA file that exists`, v ?? '(not set)');
    }
}

async function main(): Promise<void> {
    // fancy's exact version (8.4.27); else the newest this release installs.
    const version = PHP_RECIPES.find((r) => r.version === '8.4.27')?.version ?? PHP_RECIPES[0]!.version;
    console.log(`genie#1334 live — ${platform}, PHP ${version} through Genie's installer, into ${root}; CA port ${ca ? 'present' : 'ABSENT (a tree without the fix)'}`);

    const outcome = await installPhpVersion(version, true, {
        platform, root, fs: nodePhpVersionsFs(), run, fetchBytes: httpFetch.bytes, fetchText: httpFetch.text, cpus: availableParallelism(),
        progress: (s) => { if (s) console.log(`    … ${s}`); },
        ...(ca ? { ca } : {}),
    } as Parameters<typeof installPhpVersion>[2]);
    check(outcome.kind === 'installed', `PHP ${version} installs through Genie's own installer`, outcome.kind === 'installed' ? outcome.dir : 'reason' in outcome ? outcome.reason : outcome.kind);
    if (outcome.kind !== 'installed') return;
    const dir = outcome.dir;
    const fixedIni = readFileSync(join(dir, 'php.ini'), 'utf8');

    if (platform === 'win32') {
        // 0. CONTROL — the ini exactly as Genie wrote it before genie#1334 (no CA directive): the failure must be visible.
        writeFileSync(join(dir, 'php.ini'), phpIniContents(dir, platform));
        const out = php(dir, fetchScript('https://example.com/'));
        // curl is the load-bearing one (Genie 1 measured it): PHP's Windows openssl stream layer may fall back to the
        // Windows store by itself, so only curl's errno 60 is required here — the error fancy reported.
        check(/curl=FAIL 60/.test(out), 'CONTROL: without a CA directive, PHP (curl) cannot verify https://example.com — errno 60', out.trim().replace(/\r?\n/g, ' | ').slice(0, 300));
        writeFileSync(join(dir, 'php.ini'), fixedIni);
    }

    namesExistingBundle(dir, 'after install');
    reachesEverything(dir, 'after install');

    // 3. A RESTART: the boot sweep, then a pinned site's start, each rewriting the ini.
    const refreshAll = (phpVersions as Record<string, unknown>)['refreshAllManagedInis'] as ((p: object) => string[]) | undefined;
    check(typeof refreshAll === 'function', 'the boot sweep over every managed version exists');
    refreshAll?.({ platform, root, fs: nodePhpVersionsFs(), ...(ca ? { ca } : {}) });
    phpVersions.refreshManagedIni(version, { platform, root, fs: nodePhpVersionsFs(), ...(ca ? { ca } : {}) } as Parameters<typeof phpVersions.refreshManagedIni>[1]);
    namesExistingBundle(dir, 'after a restart (boot sweep + pinned site start)');
    reachesEverything(dir, 'after a restart');
}

main()
    .catch((error) => { check(false, 'the run itself', error instanceof Error ? error.stack ?? error.message : String(error)); })
    .finally(() => {
        const failed = results.filter((r) => !r).length;
        console.log(`\ngenie#1334 live: ${results.length - failed} passed, ${failed} failed`);
        process.exit(failed === 0 ? 0 : 1);
    });
