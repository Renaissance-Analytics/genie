/**
 * Tynn #1066 — PHP'S LIVE RELEASE DATA, FOR REAL, ON A TEST VM (never on the owner's desktop).
 *
 *   Windows:  npx tsx test/live/php-live-releases.live.ts      (installs the newest 8.4 for real)
 *   Linux:    npx tsx test/live/php-live-releases.live.ts      (the catalog and the source checksums; PHP_LIVE_BUILD=1 builds)
 *
 * 1. The feed reads php.net (and windows.php.net on Windows) over the real network: the catalog is LIVE, every line's
 *    newest patch is at or above the one this Genie release bakes in, and the newest patches are printed.
 * 2. Every patch it offers is installable with a PUBLISHED sha256: windows.php.net's releases.json build (Windows), or
 *    php.net's source tarball checksum (Linux).
 * 3. The keeper, given a machine with PHP 8.4.27 (the baked 8.4), installs the newest 8.4 by itself when php.net's
 *    newest 8.4 security release is above 8.4.27 — Windows: Genie's real installer, real download, real checksum — and
 *    never another line. Linux: the install is recorded (the source build is the existing recipe; PHP_LIVE_BUILD=1 runs it).
 * 4. CONTROL (Windows): the same install with the published sha256 altered is refused, nothing unpacked.
 *
 * Exits 1 on any FAIL.
 */
import { mkdtempSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { phpVersionRisk } from '../../src/core/php-advisories.js';
import { PHP_NET_SUPPORTED_JSON, catalogVersions, lineOf } from '../../src/core/php-releases.js';
import { PHP_RECIPES, PHP_WINDOWS_RELEASES_JSON, compareVersionsDesc, phpReleaseJsonUrl, phpSourceShaFromJson, phpWindowsBuild, type PhpPlatform } from '../../src/core/php-versions.js';
import { applyDuePhpUpdates, PhpPatchNotices } from '../../src/main/php-patch-keeper.js';
import { PhpReleaseFeed } from '../../src/main/php-release-feed.js';
import { httpFetchOver, installPhpVersion, managedPhp, nodePhpVersionsFs, phpVersionsRoot, type PhpVersionsPorts } from '../../src/main/php-versions.js';
import { execFileRunner } from '../../src/main/toolchain-runner.js';
import type { CommandRunner } from '../../src/main/toolchain-prober.js';

const platform = process.platform as PhpPlatform;
const net = httpFetchOver(fetch);
const results: boolean[] = [];
const check = (ok: boolean, label: string, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };
const run: CommandRunner = (binary, args, options) => execFileRunner(binary, args, { timeoutMs: 45 * 60_000, ...(options?.env ? { env: options.env } : {}) });

async function main(): Promise<void> {
    console.log(`Tynn #1066 live — ${platform}`);
    const feed = new PhpReleaseFeed({ platform, fetchText: net.text, now: Date.now, log: (l) => console.log(`    log: ${l}`) });
    const catalog = await feed.refresh();
    check(catalog.source === 'live', 'the catalog is php.net’s live data', catalog.source);
    console.log('  newest patch per line (live):');
    for (const l of catalog.lines) console.log(`    PHP ${l.line}: ${l.newest}   newest security release ${l.securityFloor ?? '(none listed)'}`);
    const baked = new Map(PHP_RECIPES.map((r) => [lineOf(r.version), r.version]));
    for (const [line, v] of baked) {
        const live = catalog.lines.find((l) => l.line === line);
        check(live !== undefined && compareVersionsDesc(live.newest, v) <= 0, `PHP ${line}: the live newest is at or above the baked ${v}`, live?.newest ?? 'missing');
    }
    const supported = await net.text(PHP_NET_SUPPORTED_JSON);
    console.log(`  php.net supported_versions: ${supported.ok ? JSON.stringify((JSON.parse(supported.body) as { supported_versions?: unknown }).supported_versions) : supported.error}`);

    // 2. Every offered patch has a published checksum.
    if (platform === 'win32') {
        const rel = await net.text(PHP_WINDOWS_RELEASES_JSON);
        for (const v of catalogVersions(catalog)) {
            const b = rel.ok ? phpWindowsBuild(rel.body, v) : { missing: rel.ok ? '' : rel.error };
            check('file' in b, `PHP ${v}: windows.php.net publishes its NTS x64 zip with a sha256`, 'file' in b ? `${b.file} ${b.sha256.slice(0, 16)}…` : b.missing);
        }
    } else {
        for (const v of catalogVersions(catalog)) {
            const j = await net.text(phpReleaseJsonUrl(v));
            const sha = j.ok ? phpSourceShaFromJson(j.body, v) : null;
            check(sha !== null, `PHP ${v}: php.net publishes php-${v}.tar.gz with a sha256`, sha ? `${sha.slice(0, 16)}…` : j.ok ? 'no sha' : j.error);
        }
    }

    // 3. The keeper on a machine with 8.4.27.
    const base = mkdtempSync(join(tmpdir(), 'genie-1066-'));
    const root = phpVersionsRoot(join(base, 'genie2-toolchain'));
    const ports = (): PhpVersionsPorts => ({ platform, root, fs: nodePhpVersionsFs(), run, fetchBytes: net.bytes, fetchText: net.text, cpus: availableParallelism(), progress: (s) => { if (s) console.log(`    … ${s}`); } });
    const target84 = catalog.lines.find((l) => l.line === '8.4')?.newest ?? null;
    const due = phpVersionRisk('8.4.27', catalog).risk === 'vulnerable';
    console.log(`  8.4.27 against the live floor: ${JSON.stringify(phpVersionRisk('8.4.27', catalog))}`);
    const realInstall = platform === 'win32' || process.env['PHP_LIVE_BUILD'] === '1';
    const installs: string[] = [];
    const notices = new PhpPatchNotices(Date.now);
    let def: string | null = '8.4.27';
    const r = await applyDuePhpUpdates({
        refresh: () => feed.refresh(),
        managed: () => [{ version: '8.4.27', dir: join(root, '8.4.27') }, ...managedPhp(ports())].filter((m, i, a) => a.findIndex((x) => x.version === m.version) === i),
        install: async (version) => {
            installs.push(version);
            return realInstall ? installPhpVersion(version, true, ports()) : { kind: 'installed', version, dir: join(root, version) };
        },
        defaultVersion: () => def,
        setDefault: (v) => { def = v; return { kind: 'set' }; },
        sites: () => [{ id: 's1', name: 'shop', host: 'shop.gen', workspaceId: 'w', pin: '8.4', running: true }],
        restartSite: async () => {},
        notices,
        tellAgents: async () => {},
    }, (s) => { if (s) console.log(`    … ${s}`); });
    console.log(`  keeper: ${JSON.stringify(r)}`);
    if (due) {
        check(r.updated.length === 1 && r.updated[0] === target84, `a security release above 8.4.27 installs by itself: PHP ${target84}${realInstall ? ' (real install, checksum-verified)' : ' (recorded; built from source by the existing recipe)'}`, JSON.stringify(r));
        check(installs.every((v) => lineOf(v) === '8.4'), 'never another line', installs.join(', '));
        check(def === target84, 'Genie’s default PHP moves to it', String(def));
        console.log(`  Deck: ${JSON.stringify(notices.items().map((i) => ({ title: i.title, detail: i.detail })))}`);
    } else {
        check(r.updated.length === 0 && installs.length === 0, 'no newer 8.4 security release: nothing installs by itself', JSON.stringify(r));
    }

    // 4. CONTROL: an altered published sha256 is refused (Windows: the real zip, a wrong checksum).
    if (platform === 'win32' && target84 !== null) {
        const tamperedRoot = phpVersionsRoot(join(mkdtempSync(join(tmpdir(), 'genie-1066-bad-')), 'genie2-toolchain'));
        const tampered = async (url: string) => {
            const t = await net.text(url);
            return url === PHP_WINDOWS_RELEASES_JSON && t.ok ? { ok: true as const, body: t.body.replace(/"sha256":\s*"[0-9a-f]{64}"/gi, `"sha256": "${'0'.repeat(64)}"`) } : t;
        };
        const bad = await installPhpVersion(target84, true, { ...ports(), root: tamperedRoot, fetchText: tampered });
        check(bad.kind === 'not-installed' && /does not match the sha256/.test(bad.reason), `CONTROL: PHP ${target84} with an altered published sha256 is refused, nothing installed`, 'reason' in bad ? bad.reason.slice(0, 200) : bad.kind);
        check(managedPhp({ platform, root: tamperedRoot, fs: nodePhpVersionsFs() }).length === 0, 'CONTROL: nothing is listed after the refusal');
    }
}

main().then(() => {
    const failed = results.filter((ok) => !ok).length;
    console.log(failed === 0 ? `ALL ${results.length} PASS` : `${failed} of ${results.length} FAILED`);
    process.exit(failed === 0 ? 0 : 1);
}, (error: unknown) => { console.error(error); process.exit(1); });
