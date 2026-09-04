import { describe, expect, it } from 'vitest';
import { buildInstallCommand, installIntentFor } from '../toolchain-adapters';
import type { InstallStep } from '../toolchain-plan';
import { scanToolchain, type ToolchainFs } from '../toolchain-scan';
import {
    PHP_REQUIRED_MODULES,
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
            ensurePrerequisite: async () => ({ ok: true as const }),
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

/**
 * The modules Genie's php.ini must produce, so a success case can be a success.
 *
 * DERIVED from the real list rather than copied. Hand-copying it froze this
 * fixture at fourteen names while `PHP_REQUIRED_MODULES` grew to thirty-two, so
 * a correct install failed its own gate here and two unrelated tests — a PATH
 * assertion and a prerequisite-ordering one — went red for a reason neither
 * names. A fixture that restates a constant is a fixture that will disagree
 * with it.
 */
const PHP_MODULES = [...PHP_REQUIRED_MODULES];

// --- 3b. a prerequisite is Genie's job, not a link in an error message -------

/**
 * "Users should not ever have to go and manually download anything."
 *
 * php's Windows build cannot start without the Visual C++ runtime, and the
 * wizard has installed it since beta.252. The PAGE's per-version installer never
 * did — it downloaded php, watched the binary fail to load, and printed a URL.
 * Two install paths, one of which did the work; the same shape of split as
 * genie#212 itself, one layer down.
 */
describe('installing a language installs what that language NEEDS', () => {
    function fx(log: string[], over: Record<string, unknown> = {}) {
        return {
            download: async () => {
                log.push('download');
                return { ok: true as const, path: '/tmp/a.zip' };
            },
            unpack: async () => ({ ok: true as const }),
            runInstaller: async () => ({ ok: true as const }),
            writeFile: async () => {},
            verify: async () => ({ version: '8.4.24' }),
            listModules: async () => ({ modules: [...PHP_MODULES] }),
            removeDir: async () => {},
            addToPath: async () => {},
            ensurePrerequisite: async (name: string) => {
                log.push(`prereq:${name}`);
                return { ok: true as const };
            },
            ...over,
        };
    }

    const phpPlan = () => {
        const plan = planVersionInstall(
            'php',
            '8.4.24',
            { os: 'win32', arch: 'x64' },
            genieToolchainRoot('C:\\Genie', 'win32'),
        );
        if (!plan.ok) throw new Error(plan.reason);
        return plan;
    };

    it('declares the Visual C++ runtime as a requirement of php on Windows', () => {
        expect(phpPlan().requires).toContain('vcredist');
    });

    it('does not invent a requirement for a language that has none', () => {
        const plan = planVersionInstall(
            'node',
            '24.19.0',
            { os: 'win32', arch: 'x64' },
            genieToolchainRoot('C:\\Genie', 'win32'),
        );
        if (!plan.ok) throw new Error(plan.reason);
        expect(plan.requires ?? []).toEqual([]);
    });

    it('installs the prerequisite BEFORE fetching the language', async () => {
        const log: string[] = [];
        const res = await installEngineVersion(phpPlan(), fx(log));

        expect(res.ok).toBe(true);
        // Order matters: the runtime has to be there before the binary is asked
        // to run, and doing it first means the failure never happens rather than
        // being explained after the fact.
        expect(log).toEqual(['prereq:vcredist', 'download']);
    });

    it('fails with the prerequisite NAMED, and never downloads, when it cannot be installed', async () => {
        const log: string[] = [];
        const res = await installEngineVersion(
            phpPlan(),
            fx(log, {
                ensurePrerequisite: async (name: string) => {
                    log.push(`prereq:${name}`);
                    return { ok: false as const, error: 'UAC declined' };
                },
            }),
        );

        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.error).toMatch(/visual c\+\+/i);
        expect(res.error).toContain('UAC declined');
        // Downloading 30MB of php that provably cannot start is wasted work and
        // a more confusing failure than the real one.
        expect(log).toEqual(['prereq:vcredist']);
    });
});

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

// --- 5. an install must never need root -------------------------------------

/**
 * `npm i -g` into a prefix Genie does not own (genie#214).
 *
 * Reported on Ubuntu: installing Codex failed with npm's EACCES and "try running
 * the command again as root/Administrator". The machine had a SYSTEM node, so
 * npm's global prefix was `/usr/lib/node_modules` — root-owned. Genie's whole
 * model is that it installs into its own directory without elevation, and the
 * agent CLIs were the one path still asking the OS for permission.
 *
 * Fixing it in the same place also ends "the page says Claude Code is installed
 * but `claude` is not found": a Genie-owned prefix is a directory Genie can put
 * on PATH, which a root-owned one never was.
 */
describe('installing an agent CLI never needs root', () => {
    const npmStep = (tool: InstallStep['tool']): InstallStep => ({
        tool,
        method: 'npm-global',
        requiresElevation: false,
        requiresRestart: false,
        dependsOn: [],
    });

    it('installs into a GENIE-owned prefix rather than the system one', () => {
        const command = buildInstallCommand(npmStep('codex'), {
            os: 'linux',
            arch: 'x64',
            genieRoot: '/home/dev/.config/Genie/toolchain',
        });

        expect(command.via).toBe('run');
        if (command.via !== 'run') return;
        const argv = command.args.join(' ');
        expect(argv).toContain('--prefix');
        expect(argv).toContain('/home/dev/.config/Genie/toolchain/npm-global');
        // Still a global install — the prefix moves WHERE, not what.
        expect(command.args).toContain('-g');
    });

    it('never asks for elevation to do it', () => {
        const command = buildInstallCommand(npmStep('claude-code'), {
            os: 'linux',
            arch: 'x64',
            genieRoot: '/home/dev/.config/Genie/toolchain',
        });
        expect(command.requiresElevation).toBe(false);
    });

    it('puts the prefix bin directory on PATH, or "installed" is a lie again', () => {
        const command = buildInstallCommand(npmStep('codex'), {
            os: 'linux',
            arch: 'x64',
            genieRoot: '/home/dev/.config/Genie/toolchain',
        });
        if (command.via !== 'run') throw new Error('expected a run command');
        // posix npm puts binaries in <prefix>/bin; Windows puts them at <prefix>.
        expect(command.pathAdd).toBe('/home/dev/.config/Genie/toolchain/npm-global/bin');
    });

    it('uses the Windows layout on win32', () => {
        // String.raw — a plain literal turns \t into a TAB and the assertion
        // then compares two strings that LOOK identical and are not.
        const root = String.raw`C:\Genie\toolchain`;
        const command = buildInstallCommand(npmStep('codex'), {
            os: 'win32',
            arch: 'x64',
            genieRoot: root,
        });
        if (command.via !== 'run') throw new Error('expected a run command');
        expect(command.pathAdd).toBe(String.raw`C:\Genie\toolchain\npm-global`);
    });
});
