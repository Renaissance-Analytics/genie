import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { defaultCommandRunner } from './seams';
import { createToolchainPrimitives, download } from './toolchain-primitives';
import { createToolchainPerformDeps } from './toolchain-effects';
import { createPerformInstall } from './toolchain-perform';
import type { PerformInstall } from './toolchain-install';
import type { AdapterContext } from './toolchain-adapters';
import { parseToolVersion } from './toolchain-detect';
import { scanToolchain, shouldRescanToolchain, type ToolchainFs } from './toolchain-scan';
import {
    LANGUAGE_TOOLS,
    addableRecipes,
    defaultVersionFor,
    engineVersionArgv,
    genieToolchainRoot,
    parseToolchainDefaults,
    serializeToolchainDefaults,
    type EngineInstall,
    type LanguageTool,
    type RecipeContext,
    type ToolchainDefaults,
    type VersionArtifact,
} from './toolchain-versions';
import {
    installEngineVersion,
    parseModuleList,
    planVersionInstall,
    planVersionRemoval,
    type EngineProbe,
    type VersionInstallEffects,
} from './toolchain-version-install';
import { resolveEngineExe, type EngineResolution } from './engine-resolve';

/**
 * The COMPOSITION ROOT for the Toolchain page — the one module that touches a
 * real disk, a real download and a real process, wiring the tested decision
 * modules to the machine.
 *
 * Everything with a judgement in it lives above this file and is unit-tested:
 * `toolchain-versions.ts` (the model, the recipes, php.ini),
 * `toolchain-scan.ts` (what counts as an install), and
 * `toolchain-version-install.ts` (the plan, and the never-report-a-half-install
 * rule). What is left here is deliberately dull: list a directory, unpack an
 * archive, run a binary, move a folder.
 *
 * Reads NEVER install. Opening the Toolchain page lists directories and — only
 * where a directory name cannot name its version — runs `--version`. It does
 * not touch the network, so the page cannot make a machine download anything by
 * being looked at (the same rule the Hosting Manager page follows).
 */

// --- machine facts ----------------------------------------------------------

/** Genie's data dir. Electron is resolved lazily so this module still loads
 *  headless and in tests (mirrors `toolchain-primitives.ts`). */
function userDataDir(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return (require('electron') as typeof import('electron')).app.getPath('userData');
    } catch {
        return join(homedir(), '.genie');
    }
}

function machineContext(): RecipeContext {
    return { os: process.platform, arch: process.arch };
}

export function toolchainRoot(): string {
    return genieToolchainRoot(userDataDir(), process.platform);
}

// --- the real filesystem seam ----------------------------------------------

/** How deep a size walk goes. A language install is 3–6 levels; the cap exists
 *  so a symlink loop or a pathological tree cannot hang a settings page. */
const SIZE_WALK_MAX_DEPTH = 12;

const realFs: ToolchainFs = {
    async listDir(dir) {
        try {
            return await readdir(dir);
        } catch {
            // A missing directory is the ordinary "not installed" state.
            return [];
        }
    },
    async isFile(path) {
        try {
            return (await stat(path)).isFile();
        } catch {
            return false;
        }
    },
    async dirSize(dir) {
        return walkSize(dir, 0);
    },
};

/**
 * Total bytes under a directory.
 *
 * Called for GENIE-owned directories only. Walking Herd's or a system prefix to
 * put a number beside a row Genie cannot delete would be a slow answer to a
 * question nobody asked — and on a system prefix it is a permission error
 * waiting to happen. `withFileTypes` keeps it to one syscall per entry.
 */
async function walkSize(dir: string, depth: number): Promise<number> {
    if (depth > SIZE_WALK_MAX_DEPTH) return 0;
    let total = 0;
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        // Never follow a link: a size walk is not a reason to leave the tree.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            total += await walkSize(full, depth + 1);
        } else if (entry.isFile()) {
            try {
                total += (await stat(full)).size;
            } catch {
                /* vanished mid-walk */
            }
        }
    }
    return total;
}

// --- probing ----------------------------------------------------------------

/** How much of a failing binary's own output is worth keeping. */
const PROBE_DETAIL_LIMIT = 400;

/**
 * Ask an engine binary for its version, keeping WHY when it does not answer.
 *
 * The exe is a real executable path, not a PATH lookup, so the no-shell runner
 * is the right one. Everything it learns is reported: whether the file is even
 * there, the exit code, and the process's own words. Discarding those is how a
 * failed install came back as "did not run" and nothing else (genie#209) — and a
 * loader failure prints NOTHING, so the exit code is the only evidence there is.
 */
async function probeEngine(tool: LanguageTool, exe: string): Promise<EngineProbe> {
    if (!(await realFs.isFile(exe))) return { missing: true };
    try {
        const res = await defaultCommandRunner.run(exe, engineVersionArgv(tool), {
            timeoutMs: 10_000,
        });
        const version = res.code === 0 ? parseToolVersion(res.stdout || res.stderr) : undefined;
        if (version) return { version };
        return {
            exitCode: res.code,
            detail: (res.stderr || res.stdout || '').trim().slice(0, PROBE_DETAIL_LIMIT),
        };
    } catch (e) {
        return { detail: String(e) };
    }
}

/** The SCAN's version probe: the same question, answered with just the version.
 *  A directory that cannot name its own version is the only caller. */
async function probeEngineVersion(tool: LanguageTool, exe: string): Promise<string | undefined> {
    return (await probeEngine(tool, exe)).version;
}

/** Resolve a bare bin name against PATH. `where`/`which` may print several
 *  lines — the FIRST is the one PATH would actually run. */
async function resolveOnPath(bin: string): Promise<string | undefined> {
    try {
        const isWin = process.platform === 'win32';
        const res = await defaultCommandRunner.run(isWin ? 'where' : 'which', [bin], {
            timeoutMs: 10_000,
        });
        if (res.code !== 0) return undefined;
        return res.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    } catch {
        return undefined;
    }
}

// --- the read ---------------------------------------------------------------

/** A site that consumes a language, for the default-change sentence. */
export interface ToolchainSiteUsage {
    genName: string;
    tool: LanguageTool;
    /** Set when the site PINNED a version (so it does not follow the default). */
    version?: string;
}

export interface ToolchainInstallsInfo {
    installs: EngineInstall[];
    defaults: Partial<Record<LanguageTool, string>>;
    addable: Partial<Record<LanguageTool, string[]>>;
    sites: ToolchainSiteUsage[];
    root: string;
}

export interface ToolchainManagerDeps {
    /** Read the persisted `toolchain_defaults` blob. */
    readDefaults(): string | undefined;
    /** Persist it. A TARGETED patch — never the Settings form's whole object. */
    writeDefaults(raw: string): void;
    /** Sites that consume a language, across every workspace. */
    listSiteUsage(): ToolchainSiteUsage[];
}

/**
 * The last scan, reused while it is fresh.
 *
 * The scan is the expensive half — a `where`/`which` per language, a version
 * probe for anything a directory name cannot name, and a size walk per
 * Genie-owned install. `devServerChanged` fires on every site start and stop, so
 * without this a busy workspace would re-run all of it several times a minute
 * to answer a question that changes when somebody installs something. Every
 * WRITE below drops it, so the page never renders a version it just deleted.
 */
let scanCache: { at: number; installs: EngineInstall[] } | null = null;

function invalidateToolchainScan(): void {
    scanCache = null;
}

/** Exported for tests + for anything that changes the toolchain out of band. */
export { invalidateToolchainScan };

/**
 * The ONE way to get an install effect — and the reason the wizard's installs
 * are no longer invisible to this page (genie#209).
 *
 * `createToolchainPerformDeps` demands a machine-changed callback, so no install
 * path can be assembled without one; this hands out the right one. Building it
 * here rather than at each IPC handler puts the wiring in the module that OWNS
 * the cache, where "what invalidates this?" is answerable by reading one screen
 * instead of grepping for callers — which is exactly the grep that came back
 * empty when the wizard's install path was added.
 */
export function createToolchainInstallEffect(ctx: AdapterContext): PerformInstall {
    return createPerformInstall(
        createToolchainPerformDeps(createToolchainPrimitives(), invalidateToolchainScan),
        ctx,
    );
}

/** Every language install on this machine, reusing the cache while it is fresh. */
async function machineInstalls(opts: { force?: boolean } = {}): Promise<EngineInstall[]> {
    if (
        !shouldRescanToolchain({
            lastScanAt: scanCache?.at ?? null,
            now: Date.now(),
            ...(opts.force ? { force: true } : {}),
        })
    ) {
        return scanCache!.installs;
    }
    const installs = await scanToolchain({
        fs: realFs,
        platform: process.platform,
        root: toolchainRoot(),
        home: homedir(),
        env: process.env,
        probeVersion: probeEngineVersion,
        resolveOnPath,
    });
    scanCache = { at: Date.now(), installs };
    return installs;
}

/**
 * Everything the Toolchain page renders from.
 *
 * `defaults` comes back RESOLVED, not raw: a stored default whose version was
 * removed — or which points at a foreign install — is dropped in favour of the
 * newest Genie install, so the page never shows a default that nothing runs on.
 */
export async function toolchainInstallsInfo(
    deps: ToolchainManagerDeps,
    opts: { force?: boolean } = {},
): Promise<ToolchainInstallsInfo> {
    const root = toolchainRoot();
    const ctx = machineContext();
    const installs = await machineInstalls(opts);

    const stored = parseToolchainDefaults(deps.readDefaults());
    const defaults: ToolchainDefaults = {};
    const addable: Partial<Record<LanguageTool, string[]>> = {};
    for (const tool of LANGUAGE_TOOLS) {
        const resolved = defaultVersionFor(tool, installs, stored);
        if (resolved) defaults[tool] = resolved;
        addable[tool] = addableRecipes(tool, ctx, installs).map((r) => r.version);
    }

    return { installs, defaults, addable, sites: deps.listSiteUsage(), root };
}

/**
 * The resolver a SITE START uses to decide which runtime it spawns (genie#207).
 *
 * The site manager owns no machine facts, so it asks this: pin → machine default
 * → a failure naming what to install. The judgement is `resolveEngineExe`; all
 * that happens here is handing it the scan and the stored defaults.
 *
 * A MISS re-scans once before failing. The in-process cache is dropped by every
 * toolchain write, so a stale miss means the directory changed out of band — and
 * telling someone their PHP is not installed while it sits on disk is the kind of
 * wrong answer that makes the whole feature untrustworthy. One extra directory
 * walk on a start that was about to fail costs nothing.
 */
export function createSiteEngineResolver(
    readDefaults: () => string | undefined,
): (req: { tool: LanguageTool; bin: string; version?: string }) => Promise<EngineResolution> {
    return async (req) => {
        const ask = async (force: boolean): Promise<EngineResolution> =>
            resolveEngineExe({
                tool: req.tool,
                bin: req.bin,
                ...(req.version ? { pinned: req.version } : {}),
                installs: await machineInstalls(force ? { force: true } : {}),
                defaults: parseToolchainDefaults(readDefaults()),
                platform: process.platform,
            });
        const first = await ask(false);
        return first.ok ? first : ask(true);
    };
}

// --- the writes -------------------------------------------------------------

export interface ToolchainVersionResult {
    ok: boolean;
    error?: string;
    nextDefault?: string | null;
    freedBytes?: number;
}

/**
 * Make a version the machine default.
 *
 * Refused unless it is a GENIE-owned install that exists right now — the whole
 * point of the model is that a default names something Genie controls, and a
 * renderer must not be able to point the machine at an arbitrary path.
 */
export async function setToolchainDefault(
    deps: ToolchainManagerDeps,
    tool: LanguageTool,
    version: string,
): Promise<ToolchainVersionResult> {
    const info = await toolchainInstallsInfo(deps, { force: true });
    const match = info.installs.find(
        (i) => i.tool === tool && i.version === version && i.source === 'genie',
    );
    if (!match) {
        return {
            ok: false,
            error: `Genie does not manage ${tool} ${version} on this machine, so it cannot be the default.`,
        };
    }
    const next = { ...parseToolchainDefaults(deps.readDefaults()), [tool]: version };
    deps.writeDefaults(serializeToolchainDefaults(next));
    return { ok: true };
}

/** Install one version into `<userData>/toolchain/<tool>/<version>`. */
export async function addToolchainVersion(
    deps: ToolchainManagerDeps,
    tool: LanguageTool,
    version: string,
): Promise<ToolchainVersionResult> {
    const plan = planVersionInstall(tool, version, machineContext(), toolchainRoot());
    if (!plan.ok) return { ok: false, error: plan.reason };

    const result = await installEngineVersion(plan, versionInstallEffects(tool));
    // The disk changed either way: a failed install still deleted its directory.
    invalidateToolchainScan();
    if (!result.ok) return { ok: false, error: result.error };

    // First managed version of a language? It becomes the default, because a
    // language with an install and no default cannot serve anything.
    const stored = parseToolchainDefaults(deps.readDefaults());
    if (!stored[tool]) {
        deps.writeDefaults(serializeToolchainDefaults({ ...stored, [tool]: version }));
    }
    return { ok: true };
}

/** Delete a Genie-owned version and move the default if it was the default. */
export async function removeToolchainVersion(
    deps: ToolchainManagerDeps,
    tool: LanguageTool,
    version: string,
): Promise<ToolchainVersionResult> {
    const info = await toolchainInstallsInfo(deps, { force: true });
    const target = info.installs.find((i) => i.tool === tool && i.version === version);
    if (!target) {
        return { ok: false, error: `Genie has no ${tool} ${version} to remove.` };
    }

    const stored = parseToolchainDefaults(deps.readDefaults());
    const plan = planVersionRemoval(target, info.installs, stored);
    if (!plan.ok) return { ok: false, error: plan.reason };

    try {
        await rm(plan.dir, { recursive: true, force: true });
    } catch (e) {
        return { ok: false, error: `Could not delete ${plan.dir}: ${String(e)}` };
    } finally {
        invalidateToolchainScan();
    }

    if (plan.nextDefault !== undefined) {
        const next = { ...stored };
        if (plan.nextDefault === null) delete next[tool];
        else next[tool] = plan.nextDefault;
        deps.writeDefaults(serializeToolchainDefaults(next));
    }
    return {
        ok: true,
        ...(plan.nextDefault !== undefined ? { nextDefault: plan.nextDefault } : {}),
        ...(plan.freedBytes !== undefined ? { freedBytes: plan.freedBytes } : {}),
    };
}

// --- the impure effects the executor runs through ---------------------------

const INSTALL_TIMEOUT_MS = 15 * 60_000;

function versionInstallEffects(tool: LanguageTool): VersionInstallEffects {
    return {
        async download(urls) {
            const errors: string[] = [];
            // Candidates in order: a vendor that MOVES a superseded release
            // (windows.php.net → archives/) makes the second URL the right one
            // the day after a patch ships.
            for (const url of urls) {
                const res = await download(url);
                if (res.ok && res.path) return { ok: true, path: res.path };
                errors.push(`${url}: ${res.error ?? 'download failed'}`);
            }
            return { ok: false, error: errors.join('; ') };
        },

        async unpack({ archive, artifact, strip, dest }) {
            let staging: string | undefined;
            try {
                staging = await mkdtemp(join(tmpdir(), 'genie-engine-'));
                const extract = await extractArchive(archive, artifact, staging);
                if (!extract.ok) return extract;
                // The archives nest everything under one directory whose name
                // carries the version; the destination is version-keyed already,
                // so that level is stripped rather than doubled.
                const src = strip ? join(staging, strip) : staging;
                await mkdir(dirname(dest), { recursive: true });
                await rm(dest, { recursive: true, force: true });
                try {
                    await rename(src, dest);
                } catch {
                    // A temp dir on another volume cannot be renamed across it.
                    await cp(src, dest, { recursive: true });
                }
                return { ok: true };
            } catch (e) {
                return { ok: false, error: String(e) };
            } finally {
                if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
            }
        },

        async runInstaller(installer, args) {
            const res = await defaultCommandRunner.run(installer, args, {
                timeoutMs: INSTALL_TIMEOUT_MS,
            });
            return res.code === 0
                ? { ok: true }
                : { ok: false, error: (res.stderr || res.stdout || `exited ${res.code}`).slice(-400) };
        },

        async writeFile(path, body) {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, body, 'utf8');
        },

        verify: (exe) => probeEngine(tool, exe),

        /**
         * `php -m` is the only evidence the php.ini did anything: a failed
         * `extension=` line is silent apart from a printed warning. The SPLIT of
         * that output into modules and complaints is a pure decision — and a
         * subtle one, since PHP puts the warning on stdout — so it lives in
         * `parseModuleList` where it is tested against real captured output.
         */
        async listModules(exe) {
            try {
                const res = await defaultCommandRunner.run(exe, ['-m'], { timeoutMs: 10_000 });
                return parseModuleList(res.stdout, res.stderr);
            } catch (e) {
                return { modules: [], warnings: String(e) };
            }
        },

        async removeDir(dir) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        },
    };
}

/**
 * Unpack an archive into a staging directory.
 *
 * `tar` handles gzip everywhere and is present on Windows 10+ as bsdtar, but
 * bsdtar's zip support is not something to bet a first-run install on — so a zip
 * goes through PowerShell's `Expand-Archive` on Windows and `unzip` elsewhere,
 * both of which are the platform's own answer. Arguments are literal argv
 * (`shell: false`), and the only user-influenced value is a temp path Genie
 * generated itself.
 */
async function extractArchive(
    archive: string,
    artifact: VersionArtifact,
    dest: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    if (artifact === 'exe') {
        return { ok: false, error: `${basename(archive)} is an installer, not an archive.` };
    }
    const cmd =
        artifact === 'tar.gz'
            ? { command: 'tar', args: ['-xzf', archive, '-C', dest] }
            : process.platform === 'win32'
              ? {
                    command: 'powershell',
                    args: [
                        '-NoProfile',
                        '-NonInteractive',
                        '-Command',
                        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`,
                    ],
                }
              : { command: 'unzip', args: ['-q', '-o', archive, '-d', dest] };

    const res = await defaultCommandRunner.run(cmd.command, cmd.args, {
        timeoutMs: INSTALL_TIMEOUT_MS,
    });
    return res.code === 0
        ? { ok: true }
        : { ok: false, error: (res.stderr || res.stdout || `exited ${res.code}`).slice(-400) };
}
