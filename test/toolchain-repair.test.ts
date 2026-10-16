import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Platform } from '../src/core/toolchain.js';
import { findShadow, mergePersistedPath, parseLocate, parsePhpTls, pathWithFirst, phpIniScanDir, phpTlsProblem } from '../src/core/toolchain-repair.js';
import { checkAndRepair, nodeToolchainFs, phpWorkerEnv, restoreToolchainEnv, toolchainPaths, type EnvPort, type ToolchainOpsPorts } from '../src/main/toolchain-ops.js';
import type { CommandRunner } from '../src/main/toolchain-prober.js';

/**
 * T2 — CHECK AND REPAIR (§6.6). Three faults Genie 1 met in real use, each detected and repaired with the result
 * MEASURED afterwards, each with a positive control (the healthy machine yields no finding):
 *
 * - an older copy of a tool earlier on PATH shadowing the newer one;
 * - PHP with no CA bundle (Windows): every outbound HTTPS request from a site failed;
 * - the Visual C++ runtime missing (Windows): PHP installs and cannot start — offered as an install, not run.
 *
 * The php.ini case uses a REAL fixture php.ini on disk and a fake php-cgi that reads configuration the way PHP
 * documents it: php.ini first, then every `*.ini` in each `PHP_INI_SCAN_DIR` directory, a later value winning. So
 * "the CA bundle is written where php-cgi reads it" is checked through php-cgi's own answer, and the fixture php.ini is
 * checked byte for byte to be untouched.
 */

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genie2-toolchain-repair-'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const PEM = '# CN=Example Root A\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n# CN=Example Root B\n-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----\n';

/** PHP's documented order: the php.ini, then each scan dir's *.ini (alphabetical); an empty scan-dir entry is the compiled-in one (none here). */
function effectiveIni(phpIni: string, scanDir: string | undefined, platform: Platform): Map<string, string> {
    const values = new Map<string, string>();
    const apply = (text: string) => {
        for (const line of text.split(/\r?\n/)) {
            const m = /^\s*([A-Za-z0-9_.]+)\s*=\s*"?([^";]*)"?\s*$/.exec(line);
            if (m) values.set(m[1]!, m[2]!.trim());
        }
    };
    apply(readFileSync(phpIni, 'utf8'));
    for (const dir of (scanDir ?? '').split(platform === 'win32' ? ';' : ':')) {
        if (!dir || !existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter((n) => n.endsWith('.ini')).sort()) apply(readFileSync(join(dir, f), 'utf8'));
    }
    return values;
}

/** phpinfo's HTML rows, as `php-cgi -i` prints them. */
function phpinfoHtml(values: Map<string, string>): string {
    const row = (k: string) => `<tr><td class="e">${k}</td><td class="v">${values.get(k) || 'no value'}</td><td class="v">${values.get(k) || 'no value'}</td></tr>`;
    return `X-Powered-By: PHP/8.4.13\r\nContent-type: text/html\r\n\r\n<table>${row('curl.cainfo')}${row('openssl.cafile')}</table>`;
}

interface Rig {
    ports: ToolchainOpsPorts;
    env: Map<string, string>;
    calls: Array<[string, readonly string[]]>;
}

/** A Windows machine: PATH-ordered copies of tools, a php-cgi reading the fixture php.ini, a PowerShell that exports `pem`. */
function rig(opts: { platform?: Platform; path?: string; copies?: Record<string, { tool: string; version: string }>; phpIni?: string | null; pem?: string; systemRoot?: string }): Rig {
    const platform = opts.platform ?? 'win32';
    const env = new Map<string, string>([['PATH', opts.path ?? '']]);
    const calls: Array<[string, readonly string[]]> = [];
    const copies = opts.copies ?? {};
    const sep = platform === 'win32' ? ';' : ':';
    const run: CommandRunner = async (binary, args) => {
        calls.push([binary, args]);
        if (binary === 'where' || binary === 'which') {
            const name = args[args.length - 1]!;
            const found = (env.get('PATH') ?? '').split(sep).filter(Boolean).map((d) => `${d}\\${name}.exe`).filter((p) => copies[p]?.tool === name);
            return found.length > 0 ? { stdout: found.join('\r\n'), exitCode: 0 } : { stdout: 'INFO: Could not find files for the given pattern(s).', exitCode: 1 };
        }
        if (copies[binary]) return { stdout: copies[binary]!.tool === 'php' ? `PHP ${copies[binary]!.version} (cli)` : `v${copies[binary]!.version}`, exitCode: 0 };
        if ((binary === 'php-cgi' || binary === 'php') && args[0] === '-i' && opts.phpIni) return { stdout: phpinfoHtml(effectiveIni(opts.phpIni, env.get('PHP_INI_SCAN_DIR'), platform)), exitCode: 0 };
        if (binary === 'powershell.exe') {
            const dest = /WriteAllText\('([^']+)'/.exec(args[args.length - 1]!)![1]!;
            writeFileSync(dest, opts.pem ?? PEM, 'utf8');
            return { stdout: String((opts.pem ?? PEM).split('BEGIN CERTIFICATE').length - 1), exitCode: 0 };
        }
        throw Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' });
    };
    const envPort: EnvPort = { get: (n) => env.get(n), set: (n, v) => { env.set(n, v); } };
    // A System32 that has the VC++ runtime unless a test says otherwise — the vc-runtime finding's own control.
    const systemRoot = opts.systemRoot ?? join(root, 'Windows');
    if (opts.systemRoot === undefined) {
        mkdirSync(join(systemRoot, 'System32'), { recursive: true });
        for (const d of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) writeFileSync(join(systemRoot, 'System32', d), '');
    }
    const fs = nodeToolchainFs();
    // vcRuntimeFiles joins with backslashes (a Windows path); map them onto the fixture tree on whatever host runs this.
    const exists = (p: string) => fs.exists(p.includes('\\System32\\') ? join(systemRoot, 'System32', p.split('\\').pop()!) : p);
    return {
        env,
        calls,
        ports: { platform, run, env: envPort, fs: { ...fs, exists }, dataDir: join(root, 'genie2-toolchain'), systemRoot, packageManager: async () => 'winget', now: () => 1_000 },
    };
}

describe('PHP’s CA bundle — written where php-cgi reads it; the person’s php.ini untouched', () => {
    function fixtureIni(body: string): string {
        const dir = join(root, 'php');
        mkdirSync(dir, { recursive: true });
        const p = join(dir, 'php.ini');
        writeFileSync(p, body, 'utf8');
        return p;
    }

    it('no curl.cainfo → one php-ca finding, REPAIRED: the bundle exported, Genie’s ini in the scan dir, php-cgi now reports the bundle, the worker env carries it', async () => {
        const original = 'extension=curl\nextension=openssl\nmemory_limit = 512M\n;curl.cainfo =\n';
        const phpIni = fixtureIni(original);
        const r = rig({ phpIni });
        const report = await checkAndRepair(r.ports);

        expect(report.findings.map((f) => f.kind)).toEqual(['php-ca']);
        const f = report.findings[0]!;
        expect(f.result.kind).toBe('repaired');

        const { bundle, ini, confDir } = toolchainPaths(r.ports.dataDir);
        expect(readFileSync(bundle, 'utf8')).toBe(PEM);
        expect(readFileSync(ini, 'utf8')).toContain(`curl.cainfo = "${bundle}"`);
        expect(readFileSync(ini, 'utf8')).toContain(`openssl.cafile = "${bundle}"`);
        // Leading separator: PHP's compiled-in scan dir is still read (Debian enables its extensions there).
        expect(r.env.get('PHP_INI_SCAN_DIR')).toBe(`;${confDir}`);
        // MEASURED through php-cgi itself, with the env Genie now gives it.
        const seen = effectiveIni(phpIni, r.env.get('PHP_INI_SCAN_DIR'), 'win32');
        expect(seen.get('curl.cainfo')).toBe(bundle);
        expect(seen.get('openssl.cafile')).toBe(bundle);
        // Everything else in the fixture still applies, and the file itself is byte-identical.
        expect(seen.get('memory_limit')).toBe('512M');
        expect(readFileSync(phpIni, 'utf8')).toBe(original);
        // A site's php-cgi worker is given the same directory.
        expect(phpWorkerEnv({ get: (n) => r.env.get(n), set: () => {} })).toEqual({ PHP_INI_SCAN_DIR: `;${confDir}` });
        // COUNTED: one export.
        expect(r.calls.filter(([b]) => b === 'powershell.exe')).toHaveLength(1);
    });

    it('CONTROL: a php.ini whose curl.cainfo names a bundle that exists → no finding, nothing exported, nothing written', async () => {
        const pem = join(root, 'herd-cacert.pem');
        writeFileSync(pem, PEM, 'utf8');
        const phpIni = fixtureIni(`curl.cainfo = "${pem}"\nopenssl.cafile = "${pem}"\n`);
        const r = rig({ phpIni });
        const report = await checkAndRepair(r.ports);
        expect(report.findings).toEqual([]);
        expect(r.calls.filter(([b]) => b === 'powershell.exe')).toHaveLength(0);
        expect(existsSync(toolchainPaths(r.ports.dataDir).ini)).toBe(false);
        expect(r.env.get('PHP_INI_SCAN_DIR')).toBeUndefined();
    });

    it('a curl.cainfo naming a file that does NOT exist is a finding too (errno 77 is not a fix for errno 60)', async () => {
        const phpIni = fixtureIni(`curl.cainfo = "${join(root, 'gone.pem')}"\n`);
        const r = rig({ phpIni });
        const report = await checkAndRepair(r.ports);
        expect(report.findings.map((f) => [f.kind, f.result.kind])).toEqual([['php-ca', 'repaired']]);
    });

    it('an export with NO certificates configures nothing: unchanged, the empty bundle removed, no ini, the env untouched', async () => {
        const phpIni = fixtureIni('extension=curl\n');
        const r = rig({ phpIni, pem: '' });
        const report = await checkAndRepair(r.ports);
        expect(report.findings[0]).toMatchObject({ kind: 'php-ca', result: { kind: 'unchanged' } });
        const { bundle, ini } = toolchainPaths(r.ports.dataDir);
        expect(existsSync(bundle)).toBe(false);
        expect(existsSync(ini)).toBe(false);
        expect(r.env.get('PHP_INI_SCAN_DIR')).toBeUndefined();
    });

    it('CONTROL: on Linux an unset cainfo is not a finding — openssl finds the system bundle there', async () => {
        const phpIni = fixtureIni('extension=curl\n');
        const r = rig({ phpIni, platform: 'linux' });
        expect((await checkAndRepair(r.ports)).findings).toEqual([]);
    });
});

describe('PATH precedence — an older copy shadowing the newer one', () => {
    const copies = {
        'C:\\Herd\\bin\\php.exe': { tool: 'php', version: '8.3.4' },
        'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\php.exe': { tool: 'php', version: '8.4.13' },
    };
    const WINGET = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links';

    it('Herd’s 8.3 first, winget’s 8.4 second → one finding, REPAIRED: Genie’s PATH puts 8.4 first, re-resolved, and remembered', async () => {
        const r = rig({ path: `C:\\Herd\\bin;C:\\Windows;${WINGET}`, copies });
        const report = await checkAndRepair(r.ports);
        expect(report.findings).toHaveLength(1);
        expect(report.findings[0]).toMatchObject({
            kind: 'path-shadow',
            tool: 'php',
            first: { path: 'C:\\Herd\\bin\\php.exe', version: '8.3.4' },
            newer: { path: `${WINGET}\\php.exe`, version: '8.4.13' },
            result: { kind: 'repaired' },
        });
        // Nobody's entry deleted; the newer one moved to the front.
        expect(r.env.get('PATH')).toBe(`${WINGET};C:\\Herd\\bin;C:\\Windows`);
        // The re-resolve is what said "repaired": `where php` ran twice (before and after).
        expect(r.calls.filter(([b, a]) => b === 'where' && a[0] === 'php')).toHaveLength(2);
        // Remembered for the next launch.
        expect(JSON.parse(readFileSync(toolchainPaths(r.ports.dataDir).state, 'utf8'))).toEqual({ pathFirst: [WINGET] });
    });

    it('CONTROL: the newer copy already first → no finding, PATH untouched, nothing remembered', async () => {
        const path = `${WINGET};C:\\Herd\\bin`;
        const r = rig({ path, copies });
        expect((await checkAndRepair(r.ports)).findings).toEqual([]);
        expect(r.env.get('PATH')).toBe(path);
        expect(existsSync(toolchainPaths(r.ports.dataDir).state)).toBe(false);
    });

    it('the next launch re-applies the order before anything spawns (and skips a directory that is gone)', async () => {
        const r = rig({ path: `C:\\Herd\\bin;${WINGET}`, copies });
        await checkAndRepair(r.ports);
        const fresh = new Map<string, string>([['PATH', `C:\\Herd\\bin;${WINGET}`]]);
        const env: EnvPort = { get: (n) => fresh.get(n), set: (n, v) => { fresh.set(n, v); } };
        const restored = restoreToolchainEnv({ platform: 'win32', env, fs: { ...nodeToolchainFs(), exists: (p) => p === WINGET || nodeToolchainFs().exists(p) }, dataDir: r.ports.dataDir });
        expect(restored.pathFirst).toEqual([WINGET]);
        expect(fresh.get('PATH')).toBe(`${WINGET};C:\\Herd\\bin`);
        // Control: the directory uninstalled → nothing reordered.
        const gone = new Map<string, string>([['PATH', 'C:\\Herd\\bin']]);
        restoreToolchainEnv({ platform: 'win32', env: { get: (n) => gone.get(n), set: (n, v) => { gone.set(n, v); } }, fs: nodeToolchainFs(), dataDir: r.ports.dataDir });
        expect(gone.get('PATH')).toBe('C:\\Herd\\bin');
    });

    it('the next launch also points PHP at Genie’s ini once a repair wrote it — and not before (control)', async () => {
        const before = new Map<string, string>();
        const env: EnvPort = { get: (n) => before.get(n), set: (n, v) => { before.set(n, v); } };
        expect(restoreToolchainEnv({ platform: 'win32', env, fs: nodeToolchainFs(), dataDir: join(root, 'genie2-toolchain') }).phpIni).toBe(false);
        expect(before.get('PHP_INI_SCAN_DIR')).toBeUndefined();
        const phpDir = join(root, 'php');
        mkdirSync(phpDir, { recursive: true });
        writeFileSync(join(phpDir, 'php.ini'), 'extension=curl\n');
        const r = rig({ phpIni: join(phpDir, 'php.ini') });
        await checkAndRepair(r.ports);
        expect(restoreToolchainEnv({ platform: 'win32', env, fs: nodeToolchainFs(), dataDir: r.ports.dataDir }).phpIni).toBe(true);
        expect(before.get('PHP_INI_SCAN_DIR')).toBe(`;${toolchainPaths(r.ports.dataDir).confDir}`);
    });
});

describe('the Visual C++ runtime — offered as an install, never run by a repair', () => {
    it('missing DLLs → a needs-install finding naming them and `vcredist`; nothing is installed', async () => {
        const systemRoot = join(root, 'BareWindows');
        mkdirSync(join(systemRoot, 'System32'), { recursive: true });
        writeFileSync(join(systemRoot, 'System32', 'vcruntime140.dll'), '');
        const r = rig({ systemRoot });
        const report = await checkAndRepair(r.ports);
        expect(report.findings).toEqual([
            { kind: 'vc-runtime', missing: ['vcruntime140_1.dll', 'msvcp140.dll'], result: { kind: 'needs-install', tool: 'vcredist', reason: expect.stringContaining('Visual C++ runtime') } },
        ]);
        expect(r.calls.filter(([b]) => b === 'winget')).toHaveLength(0);
    });

    it('CONTROL: all three present → no finding; on Linux there is nothing to miss', async () => {
        expect((await checkAndRepair(rig({}).ports)).findings).toEqual([]);
        expect((await checkAndRepair(rig({ platform: 'linux', systemRoot: join(root, 'nothing') }).ports)).findings).toEqual([]);
    });
});

describe('the pure pieces', () => {
    it('reads phpinfo in both forms; `no value` is empty; an absent row is undefined', () => {
        expect(parsePhpTls('curl.cainfo => no value => no value\nopenssl.cafile => C:\\x\\ca.pem => C:\\x\\ca.pem')).toEqual({ cainfo: '', cafile: 'C:\\x\\ca.pem' });
        expect(parsePhpTls('<tr><td class="e">curl.cainfo</td><td class="v">no value</td><td class="v">no value</td></tr>')).toEqual({ cainfo: '', cafile: undefined });
        expect(phpTlsProblem({ cainfo: undefined, cafile: undefined }, 'win32', () => false)).toBeNull();
    });

    it('PATH helpers: move-to-front is idempotent and case-blind on Windows; persisted entries are appended once', () => {
        expect(pathWithFirst('C:\\A;c:\\b\\;C:\\C', 'C:\\B', 'win32')).toBe('C:\\B;C:\\A;C:\\C');
        expect(pathWithFirst('C:\\B;C:\\A', 'C:\\B', 'win32')).toBe('C:\\B;C:\\A');
        expect(mergePersistedPath('C:\\A', ['C:\\A;C:\\New', 'c:\\new\\'], 'win32')).toBe('C:\\A;C:\\New');
        expect(parseLocate('C:\\a\\php.exe\r\nC:\\a\\php.bat\r\nc:\\A\\php.exe\r\nC:\\b\\php.exe', 'win32')).toEqual(['C:\\a\\php.exe', 'C:\\b\\php.exe']);
        expect(findShadow([{ path: 'a', version: '8.4.13' }, { path: 'b', version: '8.3.4' }])).toBeNull();
        expect(phpIniScanDir(undefined, '/g', 'linux')).toBe(':/g');
        expect(phpIniScanDir('/etc/php.d', '/g', 'linux')).toBe('/etc/php.d:/g');
        expect(phpIniScanDir('/etc/php.d:/g', '/g', 'linux')).toBe('/etc/php.d:/g');
    });
});
