import { describe, expect, it } from 'vitest';
import { buildInstallCommand, installIntentFor } from '../toolchain-adapters';
import type { InstallStep } from '../toolchain-plan';
import { scanToolchain, type ToolchainFs } from '../toolchain-scan';
import {
    genieToolchainRoot,
    joinFor,
    recipesFor,
    type LanguageTool,
} from '../toolchain-versions';
import { installEngineVersion, planVersionInstall } from '../toolchain-version-install';

/**
 * THE CROSS-SURFACE GUARD (genie#212).
 *
 * The first-run wizard and the Toolchain page were built as two systems that
 * never met: the wizard installed into `<userData>/tools/<tool>`, the page
 * scanned `<userData>/toolchain/<tool>/<version>`. Every symptom the owner hit
 * on a clean Windows machine followed from that — the page not listing a PHP the
 * wizard had just installed, "Check again" truthfully reporting the same
 * nothing, Docker claimed installed on one surface and missing on the other.
 *
 * The bug was never in either surface. It was in the fact that nothing asserted
 * they agreed. So these tests do not test a function — they assert the SEAM:
 *
 *   1. what the wizard installs, the page LISTS;
 *   2. what either surface reports installed, a spawned terminal can RUN.
 *
 * Both are written against the real plan/scan code with the filesystem faked, so
 * a Windows layout is proven on a Linux CI runner.
 */

// --- a filesystem that only contains what a test says it does ---------------

function fakeFs(tree: Record<string, string[]>): ToolchainFs {
    const dirs = new Map(Object.entries(tree));
    // A path is a FILE when its parent lists it — the same evidence the real
    // scanner has, so a test cannot accidentally prove more than the disk does.
    const isFile = (path: string): boolean => {
        const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
        if (cut < 0) return false;
        return (dirs.get(path.slice(0, cut)) ?? []).includes(path.slice(cut + 1));
    };
    return {
        listDir: async (dir) => dirs.get(dir) ?? [],
        isFile: async (path) => isFile(path),
        dirSize: async () => 1024,
    };
}

/** The scan options a test does not care about. */
function scanOpts(platform: string, root: string, fs: ToolchainFs) {
    return {
        fs,
        platform,
        root,
        home: platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev',
        env: {},
        probeVersion: async () => undefined,
        resolveOnPath: async () => undefined,
    };
}

const directStep = (tool: InstallStep['tool']): InstallStep => ({
    tool,
    method: 'direct',
    requiresElevation: false,
    requiresRestart: false,
    dependsOn: [],
});

/** The languages the WIZARD installs — the ones that are also host tools. */
type WizardEngine = Extract<InstallStep['tool'], LanguageTool>;

// --- 1. one installer ------------------------------------------------------

describe('the wizard installs a language through the SAME installer as the page', () => {
    it('asks for a Genie-managed ENGINE version of php, not a loose download', () => {
        const command = buildInstallCommand(directStep('php'), { os: 'win32', arch: 'x64' });

        // Not `via: 'download'` — that was the path that wrote into
        // `<userData>/tools/php`, where the page has never looked.
        expect(command.via).toBe('engine');
        if (command.via !== 'engine') return;
        // …and at a version this RELEASE knows it can install, so the wizard and
        // the page's "Add a version" list can never offer different bytes.
        expect(recipesFor('php', { os: 'win32', arch: 'x64' }).map((r) => r.version)).toContain(
            command.version,
        );
    });

    it('does the same for node on every platform Genie has a recipe for', () => {
        for (const os of ['win32', 'darwin', 'linux']) {
            const command = buildInstallCommand(directStep('node'), { os, arch: 'x64' });
            expect(command.via, `node on ${os}`).toBe('engine');
        }
    });

    it('leaves a tool Genie has no engine recipe for on its existing path', () => {
        // git is not a language Genie versions; it must still download normally
        // rather than fall into the engine path and fail to find a recipe.
        const command = buildInstallCommand(directStep('git'), { os: 'win32', arch: 'x64' });
        expect(command.via).toBe('download');
    });
});

// --- 1b. the page's button has to ask for the right thing -------------------

describe('the Toolchain page’s action asks for install or update honestly', () => {
    it('installs what is absent and updates what is present', () => {
        // The page ran every action as an UPDATE, which was harmless only while
        // it had no Install button: `winget upgrade --id Docker.DockerDesktop`
        // on a machine with no Docker fails, so an Install button wired to the
        // update intent would be a button that cannot work.
        expect(installIntentFor('docker', ['git', 'node'])).toBe('install');
        expect(installIntentFor('git', ['git', 'node'])).toBe('update');
    });
});

// --- 2. the seam: installed by the wizard ⇒ listed by the page ---------------

describe('what the wizard installs, the Toolchain page lists', () => {
    /** Run the engine install the wizard would ask for, against a fake disk, and
     *  hand back what a page scan of the same machine then reports. */
    async function installThenScan(tool: WizardEngine, platform: string) {
        const ctx = { os: platform, arch: 'x64' };
        const command = buildInstallCommand(directStep(tool), ctx);
        if (command.via !== 'engine') throw new Error(`${tool} did not plan an engine install`);

        const root = genieToolchainRoot(
            platform === 'win32' ? 'C:\\Users\\dev\\AppData\\Roaming\\Genie' : '/home/dev/.genie',
            platform,
        );
        const plan = planVersionInstall(tool, command.version, ctx, root);
        if (!plan.ok) throw new Error(plan.reason);

        // The disk AFTER the install: exactly the binaries the installer's own
        // plan says it lays down, in the directory it says it lays them in.
        const tree: Record<string, string[]> = {
            [root]: [tool],
            [joinFor(platform, root, tool)]: [command.version],
            [plan.binDir]: [
                plan.exe.slice(plan.exe.lastIndexOf(platform === 'win32' ? '\\' : '/') + 1),
                ...(tool === 'php' ? [platform === 'win32' ? 'php-cgi.exe' : 'php-cgi'] : []),
            ],
        };
        if (plan.binDir !== plan.dir) tree[plan.dir] = ['bin'];

        const installs = await scanToolchain(scanOpts(platform, root, fakeFs(tree)));
        return { plan, installs, version: command.version };
    }

    it('finds the php the wizard just installed, as a Genie-managed install', async () => {
        const { plan, installs, version } = await installThenScan('php', 'win32');

        const found = installs.find((i) => i.tool === 'php' && i.version === version);
        expect(found, 'the page could not see the wizard\u2019s php').toBeDefined();
        expect(found?.source).toBe('genie');
        // Managed means actionable: a row the user can pin a site to and remove.
        expect(found?.removable).toBe(true);
        expect(found?.dir).toBe(plan.dir);
    });

    it('finds the node the wizard just installed, on a posix layout too', async () => {
        const { plan, installs, version } = await installThenScan('node', 'linux');

        const found = installs.find((i) => i.tool === 'node' && i.version === version);
        expect(found, 'the page could not see the wizard\u2019s node').toBeDefined();
        expect(found?.source).toBe('genie');
        expect(found?.dir).toBe(plan.dir);
    });
});

// --- 3. installed must mean RUNNABLE ---------------------------------------

describe('an install Genie reports is an install a new terminal can run', () => {
    /** The effects an install needs, all succeeding, recording the PATH adds. */
    function effects(added: string[]) {
        return {
            download: async () => ({ ok: true as const, path: '/tmp/archive' }),
            unpack: async () => ({ ok: true as const }),
            runInstaller: async () => ({ ok: true as const }),
            writeFile: async () => {},
            verify: async () => ({ version: '8.4.24' }),
            listModules: async () => ({ modules: [...PHP_MODULES] }),
            removeDir: async () => {},
            addToPath: async (dir: string) => {
                added.push(dir);
            },
        };
    }

    it('puts the new version\u2019s bin directory on PATH', async () => {
        const root = genieToolchainRoot('C:\\Genie', 'win32');
        const plan = planVersionInstall('php', '8.4.24', { os: 'win32', arch: 'x64' }, root);
        if (!plan.ok) throw new Error(plan.reason);

        const added: string[] = [];
        const res = await installEngineVersion(plan, effects(added));

        expect(res.ok).toBe(true);
        // Without this the binaries are on disk and `php` is still "not found" at
        // a prompt — which is exactly what the owner reported for `claude`.
        expect(added).toContain(plan.binDir);
    });

    it('does NOT leave a PATH entry behind when the install failed', async () => {
        const root = genieToolchainRoot('C:\\Genie', 'win32');
        const plan = planVersionInstall('php', '8.4.24', { os: 'win32', arch: 'x64' }, root);
        if (!plan.ok) throw new Error(plan.reason);

        const added: string[] = [];
        const res = await installEngineVersion(plan, {
            ...effects(added),
            // The binary never ran — the install is a failure and the directory
            // is deleted, so pointing PATH at it would be pointing at nothing.
            verify: async () => ({ missing: true }),
        });

        expect(res.ok).toBe(false);
        expect(added).toEqual([]);
    });
});

/** The modules Genie's php.ini must produce, so a success case can be a success. */
const PHP_MODULES = [
    'curl',
    'exif',
    'fileinfo',
    'gd',
    'intl',
    'mbstring',
    'openssl',
    'pdo_mysql',
    'pdo_pgsql',
    'pdo_sqlite',
    'sockets',
    'sodium',
    'sqlite3',
    'zip',
];

// --- 4. nothing the old wizard installed is orphaned ------------------------

describe('tools the OLD wizard left in <userData>/tools are not orphaned', () => {
    it('lists a php installed by a previous Genie into the legacy flat directory', async () => {
        const userData = 'C:\\Users\\dev\\AppData\\Roaming\\Genie';
        const root = genieToolchainRoot(userData, 'win32');
        const legacy = joinFor('win32', userData, 'tools');

        const fs = fakeFs({
            [root]: [],
            [legacy]: ['php'],
            [joinFor('win32', legacy, 'php')]: ['php.exe', 'php-cgi.exe'],
        });

        const installs = await scanToolchain({
            ...scanOpts('win32', root, fs),
            legacyRoot: legacy,
            // The flat directory carries no version in its name, so the only way
            // to name it is to ask the binary — as the real scan does.
            probeVersion: async () => '8.3.33',
        });

        const found = installs.find((i) => i.tool === 'php');
        expect(found, 'a previously installed php was left invisible').toBeDefined();
        expect(found?.version).toBe('8.3.33');
        // It really is Genie's — Genie put it there — so it stays removable.
        expect(found?.source).toBe('genie');
    });
});
