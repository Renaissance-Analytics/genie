import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../../../test/electron-mock';

/**
 * The update-survival + reboot-survival machinery for the pty-host on
 * locked-down machines:
 *
 *   - materializeRuntimeToUserData copies the shipped standalone runtime into a
 *     VERSIONED per-user dir OUTSIDE the install dir, so the auto-updater
 *     replacing the app never disturbs the running host (the bug: every update
 *     restarted live agent terminals despite the standalone teardown).
 *   - the HKCU Run-key helpers register a logon relaunch on machines where the
 *     scheduled-task service is policy-blocked (schtasks → "Access is denied").
 */

vi.mock('@particle-academy/fancy-term-host', () => ({
    HostClient: class {},
    isHostBacked: () => false,
    ptyHostScriptPath: () => null,
    setActiveBackend: () => {},
    socketPathFor: (d: string) => path.join(d, 'sock'),
}));
vi.mock('@particle-academy/fancy-term-host/service', () => ({
    buildServiceDescriptor: () => ({
        platform: 'windows-task',
        unitPath: '',
        unitContents: '',
        installArgv: [],
        uninstallArgv: [],
        startArgv: [],
        statusArgv: [],
    }),
    ensureHostService: async () => ({ ok: false }),
    resolveServiceConfig: (c: unknown) => c,
    resolveServiceRuntime: () => null,
}));

import {
    runtimeKeyFor,
    materializeRuntimeToUserData,
    hostKeyFor,
    materializeHostToUserData,
    runKeyVbsContents,
    runKeyRegAddArgv,
    isServiceBlocked,
    detachedModePinsInstallTree,
    HOST_SERVICE_LABEL,
} from '../host-service';

let tmp: string;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-runtime-'));
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
});

/** A fake shipped runtime dir: node binary + node-pty + optional version.txt. */
function makeShipped(version?: string): string {
    const root = path.join(tmp, 'shipped');
    fs.mkdirSync(path.join(root, 'node-pty'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node.exe'), 'FAKE-NODE-BINARY');
    fs.writeFileSync(path.join(root, 'node-pty', 'index.js'), 'module.exports={}');
    if (version) fs.writeFileSync(path.join(root, 'version.txt'), `${version}\n`);
    return root;
}

/**
 * A fake INSTALL-DIR tree (mirrors app.asar.unpacked/node_modules): the
 * `@particle-academy/fancy-term-host` package (dist/pty-host.js + a sibling
 * chunk + the `type:module` package.json) and a sibling `node-pty` package with
 * a native binding under build/Release. Returns the source paths the resolver
 * derives at runtime.
 */
function makeHostSources(opts: {
    fthVersion: string;
    nptyVersion: string;
}): {
    hostScriptSource: string;
    packageRoot: string;
    packageName: string;
    nodePtySource: string;
} {
    const packageName = '@particle-academy/fancy-term-host';
    const nm = path.join(tmp, 'install', 'node_modules');
    const packageRoot = path.join(nm, '@particle-academy', 'fancy-term-host');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: packageName, version: opts.fthVersion, type: 'module' }),
    );
    fs.writeFileSync(
        path.join(packageRoot, 'dist', 'pty-host.js'),
        "import { spawn } from 'node-pty';\nimport './chunk-abc.js';\n",
    );
    fs.writeFileSync(path.join(packageRoot, 'dist', 'chunk-abc.js'), '// sibling chunk');

    const nodePtySource = path.join(nm, 'node-pty');
    fs.mkdirSync(path.join(nodePtySource, 'build', 'Release'), { recursive: true });
    fs.mkdirSync(path.join(nodePtySource, 'lib'), { recursive: true });
    fs.writeFileSync(
        path.join(nodePtySource, 'package.json'),
        JSON.stringify({ name: 'node-pty', version: opts.nptyVersion, main: './lib/index.js' }),
    );
    fs.writeFileSync(path.join(nodePtySource, 'lib', 'index.js'), 'module.exports={}');
    fs.writeFileSync(path.join(nodePtySource, 'build', 'Release', 'conpty.node'), 'FAKE-NODE');
    fs.writeFileSync(path.join(nodePtySource, 'build', 'Release', 'conpty.dll'), 'FAKE-DLL');

    return {
        hostScriptSource: path.join(packageRoot, 'dist', 'pty-host.js'),
        packageRoot,
        packageName,
        nodePtySource,
    };
}

describe('runtimeKeyFor — the versioned copy key', () => {
    it('uses the shipped version marker, trimmed', () => {
        expect(runtimeKeyFor('20.20.2-win32-x64\n', 123)).toBe('20.20.2-win32-x64');
    });

    it('falls back to the node binary size for pre-marker builds', () => {
        expect(runtimeKeyFor(null, 456)).toBe('sz456');
        expect(runtimeKeyFor('   ', 789)).toBe('sz789');
    });

    it('sanitises unsafe characters to a valid dir name', () => {
        expect(runtimeKeyFor('20.20.2 win32/x64', 1)).toBe('20.20.2_win32_x64');
    });
});

describe('materializeRuntimeToUserData — the update-survival copy', () => {
    it('copies the shipped runtime into a versioned dir with a completion marker', () => {
        const shipped = makeShipped('20.20.2-win32-x64');
        const base = path.join(tmp, 'userData-runtime');

        const dest = materializeRuntimeToUserData(shipped, 'node.exe', base);

        expect(dest).toBe(path.join(base, '20.20.2-win32-x64'));
        expect(fs.existsSync(path.join(dest!, 'node.exe'))).toBe(true);
        expect(fs.existsSync(path.join(dest!, 'node-pty', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(dest!, '.complete'))).toBe(true);
    });

    it('REUSES an existing complete copy untouched — the running host is never disturbed', () => {
        const shipped = makeShipped('20.20.2-win32-x64');
        const base = path.join(tmp, 'userData-runtime');
        const first = materializeRuntimeToUserData(shipped, 'node.exe', base)!;

        // Canary: a change inside the user-data copy must SURVIVE the next call
        // (same key ⇒ no re-copy — that's what keeps a live host's files stable).
        fs.writeFileSync(path.join(first, 'canary.txt'), 'still here');

        const second = materializeRuntimeToUserData(shipped, 'node.exe', base);
        expect(second).toBe(first);
        expect(fs.readFileSync(path.join(first, 'canary.txt'), 'utf8')).toBe('still here');
    });

    it('a NEW runtime version lands in a NEW dir and the old copy is kept for the old host', () => {
        const shipped = makeShipped('20.20.2-win32-x64');
        const base = path.join(tmp, 'userData-runtime');
        const oldDir = materializeRuntimeToUserData(shipped, 'node.exe', base)!;

        fs.writeFileSync(path.join(shipped, 'version.txt'), '22.1.0-win32-x64\n');
        const newDir = materializeRuntimeToUserData(shipped, 'node.exe', base)!;

        expect(newDir).toBe(path.join(base, '22.1.0-win32-x64'));
        expect(newDir).not.toBe(oldDir);
        // The superseded copy survives — an old host may still be running it.
        expect(fs.existsSync(path.join(oldDir, 'node.exe'))).toBe(true);
    });

    it('prunes crashed .staging-* leftovers and recovers a torn copy', () => {
        const shipped = makeShipped('20.20.2-win32-x64');
        const base = path.join(tmp, 'userData-runtime');
        // A torn previous attempt: dest exists but has no .complete marker.
        const dest = path.join(base, '20.20.2-win32-x64');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'garbage'), 'torn');
        // And a crashed staging dir from a dead pid.
        fs.mkdirSync(path.join(base, '20.20.2-win32-x64.staging-99999'), { recursive: true });

        const out = materializeRuntimeToUserData(shipped, 'node.exe', base);

        expect(out).toBe(dest);
        expect(fs.existsSync(path.join(dest, '.complete'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'node.exe'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'garbage'))).toBe(false); // torn attempt replaced
        expect(fs.existsSync(path.join(base, '20.20.2-win32-x64.staging-99999'))).toBe(false);
    });

    it('returns null when the shipped node binary is missing (caller falls back in place)', () => {
        const root = path.join(tmp, 'empty');
        fs.mkdirSync(root, { recursive: true });
        expect(materializeRuntimeToUserData(root, 'node.exe', path.join(tmp, 'b'))).toBeNull();
    });
});

describe('hostKeyFor — the pty-host copy key (package versions, not node version)', () => {
    it('keys by fancy-term-host + node-pty versions', () => {
        expect(hostKeyFor('0.3.0', '1.1.0')).toBe('fth0.3.0-npty1.1.0');
    });

    it('falls back to a placeholder when a version is missing', () => {
        expect(hostKeyFor(null, '1.1.0')).toBe('fthx-npty1.1.0');
        expect(hostKeyFor('0.3.0', '   ')).toBe('fth0.3.0-nptyx');
    });

    it('sanitises unsafe characters to a valid dir name', () => {
        expect(hostKeyFor('0.3.0 beta/1', '1.1.0')).toBe('fth0.3.0_beta_1-npty1.1.0');
    });
});

describe('materializeHostToUserData — co-located node-pty so the host survives the update', () => {
    it('lays out the host script + node-pty so require(node-pty) resolves to user-data', () => {
        const src = makeHostSources({ fthVersion: '0.3.0', nptyVersion: '1.1.0' });
        const base = path.join(tmp, 'pty-host');
        const key = hostKeyFor('0.3.0', '1.1.0');

        const script = materializeHostToUserData({ ...src, hostKey: key }, base);

        const dest = path.join(base, key);
        // The launched script sits at the standard package path under user-data.
        expect(script).toBe(
            path.join(
                dest,
                'node_modules',
                '@particle-academy',
                'fancy-term-host',
                'dist',
                'pty-host.js',
            ),
        );
        expect(fs.existsSync(script!)).toBe(true);
        // The `type:module` package.json AND the sibling chunk came along — without
        // them node parses the ESM host as CJS and its imports throw.
        expect(
            fs.existsSync(
                path.join(dest, 'node_modules', '@particle-academy', 'fancy-term-host', 'package.json'),
            ),
        ).toBe(true);
        expect(
            fs.existsSync(
                path.join(dest, 'node_modules', '@particle-academy', 'fancy-term-host', 'dist', 'chunk-abc.js'),
            ),
        ).toBe(true);
        // node-pty (incl. its native conpty.node/conpty.dll) is co-located.
        expect(fs.existsSync(path.join(dest, 'node_modules', 'node-pty', 'package.json'))).toBe(true);
        expect(
            fs.existsSync(path.join(dest, 'node_modules', 'node-pty', 'build', 'Release', 'conpty.node')),
        ).toBe(true);
        expect(
            fs.existsSync(path.join(dest, 'node_modules', 'node-pty', 'build', 'Release', 'conpty.dll')),
        ).toBe(true);
        expect(fs.existsSync(path.join(dest, '.complete'))).toBe(true);

        // THE INVARIANT: node's node_modules walk-up from the script's dir finds
        // node-pty at the FIRST node_modules ancestor (nothing closer shadows it),
        // i.e. the running host maps the user-data node-pty — never the install dir.
        const walkTargetNodeModules = path.resolve(path.dirname(script!), '..', '..', '..');
        expect(walkTargetNodeModules).toBe(path.join(dest, 'node_modules'));
        expect(fs.existsSync(path.join(walkTargetNodeModules, 'node-pty'))).toBe(true);
    });

    it('REUSES an existing complete copy untouched — the running host is never disturbed', () => {
        const src = makeHostSources({ fthVersion: '0.3.0', nptyVersion: '1.1.0' });
        const base = path.join(tmp, 'pty-host');
        const key = hostKeyFor('0.3.0', '1.1.0');
        const first = materializeHostToUserData({ ...src, hostKey: key }, base)!;

        // Canary inside the user-data copy must SURVIVE the next call (same key ⇒
        // no re-copy — that's what keeps a live host's mapped files stable).
        fs.writeFileSync(path.join(base, key, 'canary.txt'), 'still here');

        const second = materializeHostToUserData({ ...src, hostKey: key }, base);
        expect(second).toBe(first);
        expect(fs.readFileSync(path.join(base, key, 'canary.txt'), 'utf8')).toBe('still here');
    });

    it('a fancy-term-host / node-pty bump lands in a NEW dir; the old copy is kept', () => {
        const base = path.join(tmp, 'pty-host');
        const oldSrc = makeHostSources({ fthVersion: '0.3.0', nptyVersion: '1.1.0' });
        const oldKey = hostKeyFor('0.3.0', '1.1.0');
        const oldScript = materializeHostToUserData({ ...oldSrc, hostKey: oldKey }, base)!;

        // Ship a new fancy-term-host version (same node runtime — the node key
        // would NOT change, which is exactly why the host copy is keyed separately).
        fs.writeFileSync(
            path.join(oldSrc.packageRoot, 'package.json'),
            JSON.stringify({ name: oldSrc.packageName, version: '0.4.0', type: 'module' }),
        );
        const newKey = hostKeyFor('0.4.0', '1.1.0');
        const newScript = materializeHostToUserData({ ...oldSrc, hostKey: newKey }, base)!;

        expect(newKey).not.toBe(oldKey);
        expect(newScript).not.toBe(oldScript);
        // The superseded copy survives — an old host may still be running it.
        expect(fs.existsSync(oldScript)).toBe(true);
    });

    it('prunes crashed .staging-* leftovers and recovers a torn copy', () => {
        const src = makeHostSources({ fthVersion: '0.3.0', nptyVersion: '1.1.0' });
        const base = path.join(tmp, 'pty-host');
        const key = hostKeyFor('0.3.0', '1.1.0');
        // A torn previous attempt (dest with no .complete) + a crashed staging dir.
        fs.mkdirSync(path.join(base, key), { recursive: true });
        fs.writeFileSync(path.join(base, key, 'garbage'), 'torn');
        fs.mkdirSync(path.join(base, `${key}.staging-99999`), { recursive: true });

        const script = materializeHostToUserData({ ...src, hostKey: key }, base);

        expect(fs.existsSync(script!)).toBe(true);
        expect(fs.existsSync(path.join(base, key, '.complete'))).toBe(true);
        expect(fs.existsSync(path.join(base, key, 'garbage'))).toBe(false); // torn attempt replaced
        expect(fs.existsSync(path.join(base, `${key}.staging-99999`))).toBe(false);
    });

    it('returns null when a source is missing (caller falls back to the in-place script)', () => {
        const src = makeHostSources({ fthVersion: '0.3.0', nptyVersion: '1.1.0' });
        const base = path.join(tmp, 'pty-host');
        // Remove node-pty → cannot co-locate → null.
        fs.rmSync(src.nodePtySource, { recursive: true, force: true });
        expect(
            materializeHostToUserData({ ...src, hostKey: hostKeyFor('0.3.0', '1.1.0') }, base),
        ).toBeNull();
    });
});

describe('detachedModePinsInstallTree — active-host identity, not a stale launch-mode guess', () => {
    const userData = 'C:\\Users\\g\\AppData\\Roaming\\genie';
    const materializedScript =
        'C:\\Users\\g\\AppData\\Roaming\\genie\\pty-host\\fth0.3.0-npty1.1.0\\node_modules\\@particle-academy\\fancy-term-host\\dist\\pty-host.js';

    it('treats the legacy plain standalone marker as unsafe', () => {
        // beta.174 wrote only "standalone". A host started then can still be
        // running the INSTALL-DIR script even after beta.181 materializes the
        // safe copy, so trusting this marker repeats the restart every update.
        expect(detachedModePinsInstallTree('standalone', 42696, userData)).toBe(true);
    });

    it('allows a standalone host only when the marker identifies the live pid and user-data script', () => {
        expect(
            detachedModePinsInstallTree(
                JSON.stringify({
                    mode: 'standalone',
                    pid: 42696,
                    scriptPath: materializedScript,
                }),
                42696,
                userData,
            ),
        ).toBe(false);
    });

    it('rejects a stale pid marker even when its script path is safe', () => {
        expect(
            detachedModePinsInstallTree(
                JSON.stringify({
                    mode: 'standalone',
                    pid: 11111,
                    scriptPath: materializedScript,
                }),
                42696,
                userData,
            ),
        ).toBe(true);
    });

    it('rejects an install-dir script even on standalone Node', () => {
        expect(
            detachedModePinsInstallTree(
                JSON.stringify({
                    mode: 'standalone',
                    pid: 42696,
                    scriptPath:
                        'C:\\Users\\g\\AppData\\Local\\Programs\\Genie\\resources\\app.asar.unpacked\\node_modules\\@particle-academy\\fancy-term-host\\dist\\pty-host.js',
                }),
                42696,
                userData,
            ),
        ).toBe(true);
    });
});

describe('Run-key autostart helpers (policy-blocked schtasks fallback)', () => {
    it('builds a windowless wscript launcher with VBS-doubled quotes', () => {
        expect(runKeyVbsContents('C:\\Users\\g\\unit.cmd')).toBe(
            'CreateObject("WScript.Shell").Run """C:\\Users\\g\\unit.cmd""", 0, False\r\n',
        );
    });

    it('builds the reg add argv for the per-user Run key', () => {
        expect(runKeyRegAddArgv('C:\\ud\\launcher.vbs')).toEqual([
            'reg',
            'add',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v',
            HOST_SERVICE_LABEL,
            '/t',
            'REG_SZ',
            '/d',
            'wscript.exe "C:\\ud\\launcher.vbs"',
            '/f',
        ]);
    });

    it('isServiceBlocked reflects the persisted denial marker', () => {
        expect(isServiceBlocked(tmp)).toBe(false);
        fs.writeFileSync(path.join(tmp, 'ptyhost-service-blocked'), 'denied');
        expect(isServiceBlocked(tmp)).toBe(true);
    });
});
