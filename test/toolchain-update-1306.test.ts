import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHP_INI_EXTENSIONS } from '../src/core/php-versions.js';
import { repairOutcome } from '../src/core/toolchain.js';
import { installPhpVersion, type Fetched, type PhpVersionsFs, type PhpVersionsPorts } from '../src/main/php-versions.js';
import { probeTools, runUpdate, type CommandRunner, type LanguageUpdatePorts } from '../src/main/toolchain-prober.js';

/**
 * genie#1306 — on beta.49 none of the Toolchain panel's Update buttons updated anything (the owner: "Why can't I update?
 * This notice is useless to me."). Measured, per button:
 *
 * - every language row (php, node, python, go) went to `planUpdate` → `winget upgrade --id PHP.PHP.8.4` (…NodeJS.LTS,
 *   Python.Python.3.13, GoLang.Go). The owner's languages are GENIE-MANAGED (`%APPDATA%\genie\toolchain\php\8.4.24`), not
 *   winget packages, so winget answered 0x8A150014 ("no installed package found") and the panel said "the update command
 *   exited 2316632084 but php still reports 8.4.24";
 * - the PHP row's security notice said "update to 8.4.27" and offered only "Update to 8.5.12" (php.net's newest line);
 * - PHP's own installer read its checksum from `releases/archives/sha256sum.txt`, which windows.php.net does not publish
 *   (HTTP 404, measured 2026-10-27): the PHP2Shell builds were re-issued as `php-8.4.27-1-…`, the originals moved to
 *   archives/, and the checksum of a current build is in `releases.json` / `releases/sha256sum.txt` only.
 *
 * Genie 1's rule (v0.7.0-beta.342, `toolchain-adapters.ts` engineToolFor / `toolchain-perform.ts` performEngine): a
 * LANGUAGE is installed and updated through Genie's own per-version installer, never a package manager.
 */

const banners: Record<string, (v: string) => string> = {
    php: (v) => `PHP ${v} (cli) (built: Oct 1 2026) (ZTS Visual C++ 2022 x64)\nCopyright (c) The PHP Group`,
    node: (v) => `v${v}\n`,
    python: (v) => `Python ${v}\n`,
    go: (v) => `go version go${v} windows/amd64\n`,
};

/** The owner's machine on beta.49, as the prober sees it. */
const owner: CommandRunner = async (binary) => {
    const v = { php: '8.4.24', node: '24.19.0', python: '3.13.15', go: '1.25.6' }[binary];
    if (!v) throw Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' });
    return { stdout: banners[binary]!(v), exitCode: 0 };
};
const index = async (tool: string) => (tool === 'php' ? { version: '8.5.12', source: 'php.net releases' } : tool === 'node' ? { version: '24.22.1', source: 'nodejs.org index (LTS)' } : null);

describe('#1306 — which version each Update offers: the patch in the installed line first, another line only as a choice', () => {
    it('PHP 8.4.24 under PHP2Shell: the security notice comes with its own fix — 8.4.27 — and 8.5.12 is the secondary choice', async () => {
        const php = (await probeTools(owner, index, 'win32')).find((s) => s.tool === 'php')!;
        expect(php.tone).toBe('security-update');
        expect(php.advisory).toMatch(/update to 8\.4\.27/);
        expect(php).toMatchObject({ patch: '8.4.27', upgrade: '8.5.12' });
    });

    it('node, python and go: the same rule, from the versions Genie can actually install', async () => {
        const by = Object.fromEntries((await probeTools(owner, index, 'win32')).map((s) => [s.tool, s]));
        // Node's line is its major (24 LTS); nothing newer than 24 is offered by this release.
        expect(by['node']).toMatchObject({ installed: '24.19.0', patch: '24.22.1' });
        expect(by['node']!.upgrade).toBeUndefined();
        expect(by['python']).toMatchObject({ installed: '3.13.15', patch: '3.13.17', upgrade: '3.15.1' });
        // No 1.25.x build in this release: the only offer is another line.
        expect(by['go']).toMatchObject({ installed: '1.25.6', upgrade: '1.27.3' });
        expect(by['go']!.patch).toBeUndefined();
    });

    it('where Genie does not install that language (PHP on macOS) it offers no Genie-managed version', async () => {
        const php = (await probeTools(owner, index, 'darwin')).find((s) => s.tool === 'php')!;
        expect(php.patch).toBeUndefined();
        expect(php.upgrade).toBeUndefined();
    });
});

/** A language update's ports, counting: what was installed, which default was set, every binary that ran. */
function languageMachine(tool: 'php' | 'node' | 'python' | 'go', from: string, opts: { install?: 'fails' | 'refused'; setDefault?: 'refused'; pathWins?: boolean } = {}) {
    let current = from;
    const ran: string[] = [];
    const installs: Array<[string, string]> = [];
    const defaults: Array<[string, string]> = [];
    const steps: string[] = [];
    const run: CommandRunner = async (binary) => {
        ran.push(binary);
        if (binary === tool) return { stdout: banners[tool]!(current), exitCode: 0 };
        // Any package manager — the bug — "finds no installed package" exactly as winget did on the owner's machine.
        return { stdout: 'No installed package found matching input criteria.', exitCode: 2316632084 };
    };
    const languages: LanguageUpdatePorts = {
        install: async (t, v) => {
            installs.push([t, v]);
            if (opts.install === 'fails') return { kind: 'not-installed', reason: 'the published checksums (https://example/sha256sum.txt) could not be read (HTTP 404)' };
            if (opts.install === 'refused') return { kind: 'refused', reason: 'Genie installs nothing without your go-ahead' };
            return { kind: 'installed' };
        },
        setDefault: (t, v) => {
            defaults.push([t, v]);
            if (opts.setDefault === 'refused') return { kind: 'refused', reason: `the default could not be set to ${v}: EPERM` };
            if (!opts.pathWins) current = v;
            return { kind: 'set' };
        },
        progress: (step) => { if (step) steps.push(step); },
    };
    return { run, languages, ran, installs, defaults, steps };
}

describe('#1306 — an update of a Genie-managed language is Genie’s own install + the current link, NEVER a package manager', () => {
    const cases = [
        { tool: 'php', from: '8.4.24', to: '8.4.27' },
        { tool: 'node', from: '24.19.0', to: '24.22.1' },
        { tool: 'python', from: '3.13.15', to: '3.13.17' },
        { tool: 'go', from: '1.25.6', to: '1.27.3' },
    ] as const;

    for (const { tool, from, to } of cases) {
        for (const platform of ['win32', 'linux'] as const) {
            it(`${tool} ${from} → ${to} on ${platform}: installed by Genie, made the default, measured — and winget/apt never run`, async () => {
                const m = languageMachine(tool, from);
                const r = await runUpdate(tool, { platform, packageManager: platform === 'win32' ? 'winget' : 'apt' }, m.run, to, m.languages);
                expect(r).toEqual({ kind: 'repaired', from, to });
                expect(m.ran.filter((b) => b !== tool)).toEqual([]);
                expect(m.installs).toEqual([[tool, to]]);
                expect(m.defaults).toEqual([[tool, to]]);
                // Progress the person can see, in order: the download (and its checksum), then the switch.
                expect(m.steps.findIndex((s) => /download/i.test(s))).toBeGreaterThanOrEqual(0);
                expect(m.steps.findIndex((s) => /switch/i.test(s))).toBeGreaterThan(m.steps.findIndex((s) => /download/i.test(s)));
            });
        }
    }

    it('with no version asked for, the patch is what is installed — 8.4.27, not 8.5.12', async () => {
        const m = languageMachine('php', '8.4.24');
        expect(await runUpdate('php', { platform: 'win32', packageManager: 'winget' }, m.run, null, m.languages)).toEqual({ kind: 'repaired', from: '8.4.24', to: '8.4.27' });
        expect(m.installs).toEqual([['php', '8.4.27']]);
    });

    it('a version Genie has no installer for is refused before anything runs', async () => {
        const m = languageMachine('php', '8.4.24');
        expect(await runUpdate('php', { platform: 'win32', packageManager: 'winget' }, m.run, '8.4.99', m.languages)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/8\.4\.99/) });
        expect(m.installs).toEqual([]);
    });
});

describe('#1306 — failures are said, in words, on the row — never a silent no-op', () => {
    it('the install fails: its reason is the outcome, nothing is switched', async () => {
        const m = languageMachine('php', '8.4.24', { install: 'fails' });
        const r = await runUpdate('php', { platform: 'win32', packageManager: 'winget' }, m.run, '8.4.27', m.languages);
        expect(r).toMatchObject({ kind: 'unchanged', installed: '8.4.24', reason: expect.stringMatching(/PHP 8\.4\.27 could not be installed: the published checksums .* could not be read \(HTTP 404\)/) });
        expect(m.defaults).toEqual([]);
    });

    it('the default cannot be switched: said, with the cause', async () => {
        const m = languageMachine('node', '24.19.0', { setDefault: 'refused' });
        const r = await runUpdate('node', { platform: 'win32', packageManager: 'winget' }, m.run, '24.22.1', m.languages);
        expect(r).toMatchObject({ kind: 'unchanged', reason: expect.stringMatching(/EPERM/) });
    });

    it('installed and switched, but `php` still answers the old version: said, naming both versions', async () => {
        const m = languageMachine('php', '8.4.24', { pathWins: true });
        const r = await runUpdate('php', { platform: 'win32', packageManager: 'winget' }, m.run, '8.4.27', m.languages);
        expect(r).toMatchObject({ kind: 'unchanged', installed: '8.4.24', reason: expect.stringMatching(/8\.4\.27.*still answers 8\.4\.24/) });
    });

    it('a winget failure is words and its HRESULT, never the raw decimal (2316632084 = 0x8A150014)', () => {
        for (const exitCode of [2316632084, -1978335212]) {
            const r = repairOutcome({ tool: 'composer', wanted: null, before: '2.8.1', after: '2.8.1', exitCode });
            expect(r.kind).toBe('unchanged');
            const reason = (r as { reason: string }).reason;
            expect(reason).toMatch(/0x8A150014/);
            expect(reason).toMatch(/no installed package/i);
            expect(reason).not.toMatch(/2316632084|-1978335212/);
        }
        // A plain exit code stays a plain number.
        expect((repairOutcome({ tool: 'git', wanted: null, before: '2.51.0', after: '2.51.0', exitCode: 1 }) as { reason: string }).reason).toMatch(/exited 1\b/);
    });
});

// --- PHP on Windows: the build and its checksum, as windows.php.net publishes them (recorded 2026-10-27) --------------

const RELEASES_JSON = 'https://windows.php.net/downloads/releases/releases.json';
const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/windows-php-releases-2026-10-27.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>;
const BUILD = 'php-8.4.27-1-nts-Win32-vs17-x64.zip';
const ZIP = new TextEncoder().encode('the official php 8.4.27-1 nts zip bytes');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ROOT = join('/data', 'genie2-toolchain', 'php-versions');
const V = '8.4.27';

/** The recorded releases.json with the 8.4 NTS build's sha256 set to these test bytes' (everything else as recorded). */
function releasesWith(hash: string, version = '8.4.27-1'): string {
    const copy = JSON.parse(JSON.stringify(RECORDED)) as Record<string, Record<string, { zip?: { sha256: string } } | string>>;
    (copy['8.4']!['nts-vs17-x64'] as { zip: { sha256: string } }).zip.sha256 = hash;
    copy['8.4']!['version'] = version;
    return JSON.stringify(copy);
}

function phpMachine(opts: { releases?: string; rootZip?: boolean } = {}) {
    const files = new Set<string>();
    const dirs = new Set<string>();
    const counts = { writeBytes: 0 };
    const under = (p: string) => [...files, ...dirs].filter((f) => f === p || f.startsWith(p + '/') || f.startsWith(p + '\\'));
    const fs: PhpVersionsFs = {
        exists: (p) => files.has(p) || dirs.has(p) || under(p).length > 0,
        list: (d) => [...new Set([...files, ...dirs].filter((f) => f.startsWith(d) && f !== d).map((f) => f.slice(d.length + 1).split(/[\\/]/)[0]!))],
        mkdirp: (d) => { dirs.add(d); },
        writeText: (p) => { files.add(p); },
        writeBytes: (p) => { counts.writeBytes += 1; files.add(p); },
        rename: (a, b) => { for (const f of under(a)) { files.delete(f); dirs.delete(f); (f === a ? dirs : files).add(b + f.slice(a.length)); } },
        removeTree: (p) => { for (const f of under(p)) { files.delete(f); dirs.delete(f); } },
    };
    const fetched: string[] = [];
    const ports: PhpVersionsPorts = {
        platform: 'win32',
        root: ROOT,
        fs,
        // What windows.php.net answers today: releases.json at the root; NO sha256sum.txt under archives/ (HTTP 404).
        fetchText: async (url): Promise<Fetched<string>> => {
            fetched.push(url);
            if (url === RELEASES_JSON) return { ok: true, body: opts.releases ?? releasesWith(sha(ZIP)) };
            return { ok: false, error: 'HTTP 404' };
        },
        fetchBytes: async (url): Promise<Fetched<Uint8Array>> => {
            fetched.push(url);
            const archived = url.includes('/archives/');
            if (!url.endsWith(`/${BUILD}`)) return { ok: false, error: 'HTTP 404' };
            if (archived ? opts.rootZip !== false : opts.rootZip === false) return { ok: false, error: 'HTTP 404' };
            return { ok: true, body: ZIP };
        },
        run: async (binary) => {
            if (binary === 'powershell.exe') {
                const staging = join(ROOT, `.staging-${V}`);
                for (const f of ['php-cgi.exe', 'php.exe', join('ext', 'php_curl.dll')]) files.add(join(staging, f));
                return { stdout: '', exitCode: 0 };
            }
            if (binary.endsWith('php-cgi.exe')) return { stdout: `PHP ${V} (cgi-fcgi) (built: Oct 26 2026) (NTS Visual C++ 2022 x64)`, exitCode: 0 };
            if (binary.endsWith('php.exe')) return { stdout: ['[PHP Modules]', 'Core', ...PHP_INI_EXTENSIONS, ''].join('\n'), exitCode: 0 };
            throw new Error(`unexpected ${binary}`);
        },
    };
    return { ports, fetched, counts };
}

describe('#1306 — PHP’s Windows build is the one releases.json names, checked against the sha256 releases.json publishes', () => {
    it('8.4.27 installs from the CURRENT build (php-8.4.27-1-…), verified — archives/sha256sum.txt (a 404) is never asked for', async () => {
        const m = phpMachine();
        expect(await installPhpVersion(V, true, m.ports)).toEqual({ kind: 'installed', version: V, dir: join(ROOT, V) });
        expect(m.fetched).toEqual([RELEASES_JSON, `https://windows.php.net/downloads/releases/${BUILD}`]);
        expect(m.fetched.some((u) => u.endsWith('archives/sha256sum.txt'))).toBe(false);
    });

    it('the same build moved to archives/: fetched from there, and still checked against releases.json', async () => {
        const m = phpMachine({ rootZip: false });
        expect((await installPhpVersion(V, true, m.ports)).kind).toBe('installed');
        expect(m.fetched).toEqual([RELEASES_JSON, `https://windows.php.net/downloads/releases/${BUILD}`, `https://windows.php.net/downloads/releases/archives/${BUILD}`]);
    });

    it('a mismatch against releases.json is discarded unopened', async () => {
        const m = phpMachine({ releases: releasesWith('0'.repeat(64)) });
        expect(await installPhpVersion(V, true, m.ports)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha256/) });
        expect(m.counts.writeBytes).toBe(0);
    });

    it('a line that has moved past 8.4.27: no published checksum → refused in words, nothing downloaded, never installed unverified', async () => {
        const m = phpMachine({ releases: releasesWith(sha(ZIP), '8.4.28') });
        const r = await installPhpVersion(V, true, m.ports);
        expect(r).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/8\.4\.28/) });
        expect((r as { reason: string }).reason).toMatch(/checksum/);
        expect(m.fetched).toEqual([RELEASES_JSON]);
        expect(m.counts.writeBytes).toBe(0);
    });

    it('releases.json unreadable: refused, naming the URL and the status', async () => {
        const m = phpMachine();
        const r = await installPhpVersion(V, true, { ...m.ports, fetchText: async () => ({ ok: false, error: 'HTTP 503' }) });
        expect(r).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/releases\.json.*HTTP 503/) });
        expect(m.counts.writeBytes).toBe(0);
    });
});
