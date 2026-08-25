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
    resolveShippedCaddyBin,
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

/**
 * Apply Windows' directory-rename rule on every platform: a directory cannot be
 * renamed while any file inside it is open — the move is refused with
 * ERROR_ACCESS_DENIED → EPERM.
 *
 * This is the race behind #72. Both materializers used to fill a
 * `<key>.staging-<pid>` dir and rename it onto `<key>`; the tree being renamed
 * had been written microseconds earlier, which is exactly when the real-time
 * scanner still holds a handle on one of those files, so the rename
 * intermittently failed and the swallowed error cost the copy. Verified against
 * the real filesystem on Windows: renaming a populated directory with one open
 * handle inside fails EPERM, while `rmSync` of the same directory succeeds
 * (Node opens with FILE_SHARE_DELETE) — deleting was never the problem.
 *
 * Timing cannot be asserted on, so the rule is asserted instead: NO directory
 * rename may be relied on to publish a copy. File renames still pass through to
 * the real filesystem.
 */
function forbidDirectoryRename(): void {
    const realRenameSync = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        let isDir = false;
        try {
            isDir = fs.statSync(String(from)).isDirectory();
        } catch {
            /* missing source — let the real call raise the honest error */
        }
        if (isDir) {
            const err: NodeJS.ErrnoException = new Error(
                `EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`,
            );
            err.code = 'EPERM';
            throw err;
        }
        realRenameSync(from, to);
    });
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

    it('commits without renaming a directory into place (#72)', () => {
        const shipped = makeShipped('20.20.2-win32-x64');
        const base = path.join(tmp, 'userData-runtime');
        const dest = path.join(base, '20.20.2-win32-x64');
        // A torn previous attempt, so the full build-and-commit path runs.
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'garbage'), 'torn');
        forbidDirectoryRename();

        const out = materializeRuntimeToUserData(shipped, 'node.exe', base);

        // null here means the host runs the SHIPPED in-place runtime and the
        // next update kills live terminals — the whole reason this exists.
        expect(out).toBe(dest);
        expect(fs.existsSync(path.join(dest, '.complete'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'node.exe'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'garbage'))).toBe(false);
    });

    it('returns null when the shipped node binary is missing (caller falls back in place)', () => {
        const root = path.join(tmp, 'empty');
        fs.mkdirSync(root, { recursive: true });
        expect(materializeRuntimeToUserData(root, 'node.exe', path.join(tmp, 'b'))).toBeNull();
    });
});

/**
 * THE INSTALLER'S PATH SWEEP, as a predicate. Genie ships a `oneClick` per-user
 * NSIS installer whose kill step is neither a tree walk nor a name match
 * (app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh):
 *
 *   Get-CimInstance -ClassName Win32_Process |
 *     ? { $_.Path -and $_.Path.StartsWith('$INSTDIR','CurrentCultureIgnoreCase') } |
 *     % { Stop-Process -Id $_.ProcessId -Force }
 *
 * `Stop-Process` does not touch children, so what decides life or death is ONLY
 * where a binary sits. Case-insensitive, like the PowerShell.
 */
function installerSweepKills(exePath: string, instDir: string): boolean {
    const norm = (p: string): string => path.resolve(p).replace(/\\/g, '/').toLowerCase();
    return norm(exePath).startsWith(norm(instDir));
}

/**
 * A fake PACKAGED install tree — `<INSTDIR>/resources/runtime/` holding the
 * bundled node + caddy + the version marker, the exact layout
 * build-service-runtime.mjs produces and `extraResources` ships.
 */
function makeInstalledRuntime(opts: { version?: string; caddy?: string } = {}): {
    instDir: string;
    root: string;
} {
    const instDir = path.join(tmp, 'INSTDIR');
    const root = path.join(instDir, 'resources', 'runtime');
    fs.mkdirSync(path.join(root, 'node-pty'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node.exe'), 'FAKE-NODE-BINARY');
    fs.writeFileSync(path.join(root, 'node-pty', 'index.js'), 'module.exports={}');
    fs.writeFileSync(path.join(root, 'caddy.exe'), opts.caddy ?? 'FAKE-CADDY-BINARY');
    fs.writeFileSync(path.join(root, 'version.txt'), `${opts.version ?? '20.20.2-win32-x64'}\n`);
    return { instDir, root };
}

/**
 * WHY HOSTED SITES DIED ON EVERY UPDATE — and the fix, which is a PATH change.
 *
 * Genie's bundled Caddy is the front door for every `https://<name>.gen`, and
 * for `hostServe` (static / php) sites it IS the site's server process
 * (serve-config.ts: "this Caddy IS the host process Genie tracks for the site").
 * It ran from `<INSTDIR>\resources\runtime\caddy.exe` — inside the sweep above —
 * so every update killed it. The dev servers survived; the thing serving them
 * did not, which is why the symptom and the process measurements disagreed for
 * so long.
 *
 * Reproduced end to end against a REAL caddy.exe serving a REAL url in
 * `.ai/_discovery/genie-process-supervisor.md` §3.4: `caddyAliveAfter: false`,
 * `urlAfterSweep: "DOWN"`, `controlAliveAfter: true`.
 *
 * `node.exe` was moved out of `$INSTDIR` for exactly this reason
 * (materializeRuntimeToUserData, above). Caddy now gets the same treatment —
 * the same helper, the same versioned per-user dir, the same copy.
 */
describe('resolveShippedCaddyBin — the caddy that survives the installer sweep', () => {
    it('POSITIVE CONTROL: the sweep predicate really kills under $INSTDIR, and really spares outside it', () => {
        const { instDir, root } = makeInstalledRuntime();
        // A live process at the SHIPPED location is in the kill set…
        expect(installerSweepKills(path.join(root, 'caddy.exe'), instDir)).toBe(true);
        // …and one under userData is not. Without this the assertion below would
        // pass against a predicate that never matches anything.
        expect(installerSweepKills(path.join(tmp, 'userData', 'runtime', 'k', 'caddy.exe'), instDir)).toBe(
            false,
        );
    });

    it('resolves a caddy OUTSIDE the install dir, so the update sweep cannot reach it', () => {
        const { instDir, root } = makeInstalledRuntime();

        const bin = resolveShippedCaddyBin({
            roots: [root],
            platform: 'win32',
            packaged: true,
            baseDir: path.join(tmp, 'userData-runtime'),
        });

        expect(installerSweepKills(bin, instDir)).toBe(false);
        expect(path.basename(bin)).toBe('caddy.exe');
    });

    it('the shipped binary stays the source of truth — userData holds a COPY of it', () => {
        const { root } = makeInstalledRuntime({ caddy: 'CADDY-BYTES-v1' });

        const bin = resolveShippedCaddyBin({
            roots: [root],
            platform: 'win32',
            packaged: true,
            baseDir: path.join(tmp, 'userData-runtime'),
        });

        expect(fs.readFileSync(bin, 'utf8')).toBe('CADDY-BYTES-v1');
        // The original is untouched and still there — it is what the copy is made
        // from on the next machine, the next user, and after a torn copy.
        expect(fs.readFileSync(path.join(root, 'caddy.exe'), 'utf8')).toBe('CADDY-BYTES-v1');
    });

    it('reuses the SAME copy across calls — a running caddy is never written over', () => {
        const { root } = makeInstalledRuntime();
        const baseDir = path.join(tmp, 'userData-runtime');

        const first = resolveShippedCaddyBin({ roots: [root], platform: 'win32', packaged: true, baseDir });
        fs.writeFileSync(path.join(path.dirname(first), 'canary.txt'), 'still here');
        const second = resolveShippedCaddyBin({ roots: [root], platform: 'win32', packaged: true, baseDir });

        expect(second).toBe(first);
        expect(fs.readFileSync(path.join(path.dirname(first), 'canary.txt'), 'utf8')).toBe('still here');
    });

    it('a NEW shipped runtime is served, not a stale copy of the old one', () => {
        const baseDir = path.join(tmp, 'userData-runtime');
        makeInstalledRuntime({ version: '20.20.2-win32-x64-caddy2.9.1', caddy: 'CADDY-BYTES-v1' });
        const root = path.join(tmp, 'INSTDIR', 'resources', 'runtime');
        const oldBin = resolveShippedCaddyBin({ roots: [root], platform: 'win32', packaged: true, baseDir });

        // The next Genie release bundles a different Caddy. The version marker
        // describes the whole runtime dir, so the key moves with it.
        fs.writeFileSync(path.join(root, 'caddy.exe'), 'CADDY-BYTES-v2');
        fs.writeFileSync(path.join(root, 'version.txt'), '20.20.2-win32-x64-caddy2.10.0\n');
        const newBin = resolveShippedCaddyBin({ roots: [root], platform: 'win32', packaged: true, baseDir });

        expect(newBin).not.toBe(oldBin);
        expect(fs.readFileSync(newBin, 'utf8')).toBe('CADDY-BYTES-v2');
        // The superseded copy is left alone — a caddy started before the update
        // is still executing it.
        expect(fs.readFileSync(oldBin, 'utf8')).toBe('CADDY-BYTES-v1');
    });

    it('runs the repo binary IN PLACE in dev — no install dir to be swept, no stale copy masking a rebuild', () => {
        const { root } = makeInstalledRuntime();

        const bin = resolveShippedCaddyBin({
            roots: [root],
            platform: 'win32',
            packaged: false,
            baseDir: path.join(tmp, 'userData-runtime'),
        });

        expect(bin).toBe(path.join(root, 'caddy.exe'));
    });

    it('falls back to the shipped binary when the copy cannot be made', () => {
        const { root } = makeInstalledRuntime();
        // An unwritable base (a FILE where the dir must go) makes materialize fail.
        const baseDir = path.join(tmp, 'not-a-dir');
        fs.writeFileSync(baseDir, 'blocked');

        const bin = resolveShippedCaddyBin({ roots: [root], platform: 'win32', packaged: true, baseDir });

        // Serving from the install dir is the OLD behaviour: sites still work,
        // they just go down on the next update. Better than not serving at all.
        expect(bin).toBe(path.join(root, 'caddy.exe'));
    });

    it('names the conventional shipped location when no caddy is bundled at all', () => {
        // The build SKIPS caddy when Go is absent; the feature is unavailable and
        // the path only has to produce a legible ENOENT.
        const root = path.join(tmp, 'no-caddy');
        fs.mkdirSync(root, { recursive: true });

        expect(
            resolveShippedCaddyBin({ roots: [root], platform: 'linux', packaged: true, baseDir: tmp }),
        ).toBe(path.join(root, 'caddy'));
    });

    it('picks the platform binary name', () => {
        const { root } = makeInstalledRuntime();
        fs.writeFileSync(path.join(root, 'caddy'), 'FAKE-CADDY-BINARY');
        for (const platform of ['linux', 'darwin'] as const) {
            const bin = resolveShippedCaddyBin({
                roots: [root],
                platform,
                packaged: false,
                baseDir: path.join(tmp, 'userData-runtime'),
            });
            expect(path.basename(bin)).toBe('caddy');
        }
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

    it('commits without renaming a directory into place (#72)', () => {
        const src = makeHostSources({ fthVersion: '0.3.0', nptyVersion: '1.1.0' });
        const base = path.join(tmp, 'pty-host');
        const key = hostKeyFor('0.3.0', '1.1.0');
        const dest = path.join(base, key);
        // A torn previous attempt, so the full build-and-commit path runs.
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'garbage'), 'torn');
        forbidDirectoryRename();

        const script = materializeHostToUserData({ ...src, hostKey: key }, base);

        // null ⇒ the host launches the INSTALL-DIR script, maps install-dir
        // node-pty, and the next auto-update kills live terminals.
        expect(script).not.toBeNull();
        expect(fs.existsSync(script!)).toBe(true);
        expect(
            fs.existsSync(path.join(dest, 'node_modules', 'node-pty', 'build', 'Release', 'conpty.node')),
        ).toBe(true);
        expect(fs.existsSync(path.join(dest, '.complete'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'garbage'))).toBe(false);
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
