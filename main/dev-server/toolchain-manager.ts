import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { defaultCommandRunner, fileExistsSeam, hostToolCommandRunner } from './seams';
import { INSTALL_BUDGET_MS, INSTALL_RUN_OPTIONS } from './run-budget';
import fsSync from 'node:fs';
import {
    addToolsPathEntry,
    createToolchainPrimitives,
    diagnoseToolchainPath,
    download,
    genieToolsDir,
    pathWithToolsFirst,
    type ToolchainPathReport,
} from './toolchain-primitives';
import { writeCaBundle } from './toolchain-ca';
import { createToolchainPerformDeps } from './toolchain-effects';
import { createPerformInstall } from './toolchain-perform';
import { runInstallPlan, type PerformInstall } from './toolchain-install';
import type { AdapterContext } from './toolchain-adapters';
import { detectToolchain, parseToolVersion } from './toolchain-detect';

import { planToolUpdate } from './toolchain-plan';
import { scanToolchain, shouldRescanToolchain, type ToolchainFs } from './toolchain-scan';
import {
    LANGUAGE_TOOLS,
    addableRecipes,
    defaultVersionFor,
    engineVersionArgv,
    genieToolchainRoot,
    joinFor,
    parseToolchainDefaults,
    phpIniContents,
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

/**
 * `<userData>/tools` — where Genie's first-run wizard installed BEFORE genie#212
 * unified the two surfaces.
 *
 * Nothing writes here any more. It is still read, because a user upgrading from
 * a Genie that used it has real php/node binaries in it, and quietly ignoring
 * them would tell someone "nothing is installed" about a directory Genie itself
 * filled. Adopted rather than migrated: moving another process's live binaries
 * during a scan is not something a settings page should do.
 */
function legacyToolsRoot(): string {
    return join(userDataDir(), 'tools');
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
export async function resolveOnPath(bin: string): Promise<string | undefined> {
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
export function createToolchainInstallEffect(
    ctx: AdapterContext,
    deps: ToolchainManagerDeps,
): PerformInstall {
    return createPerformInstall(
        createToolchainPerformDeps(
            // The wizard's language installs run {@link addToolchainVersion} —
            // the SAME call the page's "Add a version" makes (genie#212). Passed
            // in rather than reached for inside the primitives so this module,
            // which owns both the installer and the cache, stays the only place
            // that knows how the two surfaces are joined.
            createToolchainPrimitives((engine, version) =>
                addToolchainVersion(deps, engine, version),
            ),
            invalidateToolchainScan,
        ),
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
        // Adopt anything the OLD first-run wizard installed, so upgrading does
        // not orphan a php the user watched Genie install (genie#212).
        legacyRoot: legacyToolsRoot(),
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

    const result = await installEngineVersion(plan, versionInstallEffects(tool, deps));
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

// One definition of "how long an install may take", shared with the wizard's
// paths — see `run-budget.ts`. A per-module copy is what let one call site drift
// onto the 120-second probe default.
const INSTALL_TIMEOUT_MS = INSTALL_BUDGET_MS;

function versionInstallEffects(tool: LanguageTool, deps: ToolchainManagerDeps): VersionInstallEffects {
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
            // A vendor installer, so it gets the install budget AND the note:
            // stopping the process Genie spawned does not stop what that
            // installer already handed to the OS.
            const res = await defaultCommandRunner.run(installer, args, INSTALL_RUN_OPTIONS);
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
         * Install a machine-level prerequisite, if it is not already here.
         *
         * The Visual C++ runtime is the only one so far, and it is why a php
         * install could unpack perfectly and then produce a binary Windows
         * refuses to start. The wizard has installed it since beta.252; this
         * page's installer only NAMED it in an error and left the user to go and
         * download it, which is not something Genie should ever ask for.
         *
         * Runs through the same plan/adapter/perform machinery as every other
         * install, so the elevation prompt, the silent switches and the
         * "exit 3010 means reboot-required, not failure" handling are the ones
         * already proven — not a second copy written for this call site.
         */
        async ensurePrerequisite(name) {
            const detected = await detectToolchain({
                runner: hostToolCommandRunner,
                platform: process.platform,
                wanted: [name],
                // REQUIRED for a library probe: without it the check answers
                // "no filesystem check available" → not installed → Genie would
                // download and UAC-prompt for the runtime on every single php
                // install, including the machines that already have it.
                fileExists: fileExistsSeam,
            });
            // Already there: nothing to do, and no download to spend.
            if (detected.present.includes(name)) return { ok: true };

            const ctx = machineContext();
            const result = await runInstallPlan({
                steps: [planToolUpdate(name, ctx.os, 'direct')],
                ctx,
                perform: createToolchainInstallEffect(ctx, deps),
                approved: true,
                intent: 'install',
            });
            const failed = result.results.find((r) => r.status !== 'succeeded');
            return failed
                ? { ok: false, ...(failed.error ? { error: failed.error } : {}) }
                : { ok: true };
        },

        /**
         * Make the proven install FINDABLE.
         *
         * Through the SAME helper the wizard's artifact installs use, so there is
         * one PATH implementation rather than one per surface — the shape of
         * mistake genie#212 is made of. Its own failure is already swallowed and
         * reported by the helper: an install whose bytes are on disk is an
         * install, PATH or no PATH.
         */
        async addToPath(dir) {
            await addToolsPathEntry(dir);
        },

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

    // A plain wall, deliberately: this is Genie's OWN extract, spawned without a
    // shell, so killing it really does stop it — and it unpacks into a staging
    // directory the caller removes, so there is no half-state to warn about.
    // Borrowing the installer note here would tell the user something untrue.
    const res = await defaultCommandRunner.run(cmd.command, cmd.args, {
        timeoutMs: INSTALL_TIMEOUT_MS,
    });
    return res.code === 0
        ? { ok: true }
        : { ok: false, error: (res.stderr || res.stdout || `exited ${res.code}`).slice(-400) };
}

/**
 * PURE. The `php.ini` files Genie wrote that no longer say what Genie would
 * write today.
 *
 * A version's ini is written ONCE, at install. Its own header promises it is
 * "rewritten when Genie reinstalls this version" — which for a version already
 * on disk means never. So a fix to {@link PHP_INI_EXTENSIONS} reaches new
 * installs and leaves every existing one stale.
 *
 * That is not cosmetic. The reporting machine's ini still carried
 * `extension=bcmath`, an extension compiled INTO the Windows build, so every php
 * invocation printed "Unable to load dynamic library 'bcmath'" to stderr — into
 * every composer run, every artisan command and every site log. It surfaced only
 * once the PATH fix made Genie's own PHP the one actually being used.
 *
 * GENIE-OWNED installs only. Herd's ini is Herd's to rewrite; Genie editing
 * another app's config underneath it is the same fault this feature is about.
 */
export function staleManagedInis(input: {
    installs: EngineInstall[];
    platform: string;
    read: (path: string) => string;
    /** The CA bundle for this install, or null when none could be produced. The
     *  ini names `curl.cainfo`/`openssl.cafile` only when there is one — pointing
     *  at a missing file swaps errno 60 for errno 77 and fixes nothing. */
    bundleFor?: (versionDir: string) => string | null;
}): Array<{ path: string; contents: string }> {
    const out: Array<{ path: string; contents: string }> = [];
    for (const install of input.installs) {
        if (install.source !== 'genie' || install.tool !== 'php') continue;
        const path = joinFor(input.platform, install.dir, 'php.ini');
        const wanted = phpIniContents(
            install.dir,
            input.platform,
            input.bundleFor?.(install.dir) ?? null,
        );
        let current: string | null = null;
        try {
            current = input.read(path);
        } catch {
            // Unreadable or absent is the strongest case for writing one.
        }
        if (current !== wanted) out.push({ path, contents: wanted });
    }
    return out;
}

/** A literal backslash, named so codegen and heredocs cannot mangle it. */
const BACKSLASH = String.fromCharCode(92);

/**
 * PURE. Every directory Genie manages that belongs at the FRONT of PATH.
 *
 * One per language at its machine-default version, plus the host-tools dir when
 * it exists. Derived from the SAME inputs `resolveEngineExe` uses — installs and
 * defaults — so what a terminal finds on PATH is the binary a site would spawn.
 * Deriving them separately is how those two drift apart, and genie#212 is what
 * that drift looks like from the outside.
 *
 * Foreign installs are never included, at any version, even when one is the only
 * install for a tool: a runtime another app can upgrade, reconfigure or uninstall
 * underneath a running site is not one Genie hands to the processes it spawns.
 * That is the same rule `engine-resolve.ts` already enforces for sites.
 */
export function managedPathDirs(input: {
    installs: EngineInstall[];
    defaults: ToolchainDefaults;
    platform: string;
    /** Genie's host-tools dir. Included only when it exists — on the reporting
     *  machine it did not, and prepending a directory that is not there is how a
     *  repair reports success against an unchanged PATH. */
    toolsDir: string;
    exists: (dir: string) => boolean;
}): string[] {
    const dirs: string[] = [];

    for (const tool of LANGUAGE_TOOLS) {
        const res = resolveEngineExe({
            tool,
            installs: input.installs,
            defaults: input.defaults,
            platform: input.platform,
        });
        if (!res.ok) continue;
        // The exe's OWN directory, not `install.dir`: a posix tarball puts the
        // executables in `bin/`, and prepending the version directory there puts
        // a directory containing no executables at the front of PATH.
        const cut = Math.max(res.exe.lastIndexOf(BACKSLASH), res.exe.lastIndexOf('/'));
        const dir = cut > 0 ? res.exe.slice(0, cut) : res.install.dir;
        if (!dirs.includes(dir)) dirs.push(dir);
    }

    if (input.toolsDir && input.exists(input.toolsDir)) dirs.push(input.toolsDir);
    return dirs;
}

/**
 * REPAIR: what is wrong with this machine's toolchain wiring, and put it right.
 *
 * The reported failure: the owner uninstalled Herd. Herd left its binaries AND
 * its PATH entry behind, so `php` kept resolving to `.config/herd/bin/php84` —
 * an install that had been removed from the machine's own point of view — while
 * Genie's `toolchain/php/8.4.24` sat unused. Every terminal, agent, service and
 * dev server Genie spawned inherited that resolution.
 *
 * The owner reported it as two faults ("php is still running with Herd's
 * config"). It is ONE. On Windows PHP reads `php.ini` from the directory of the
 * binary, so whichever `php.exe` wins also decides the config; fixing which
 * binary answers fixes which ini loads. There is no separate config to repair.
 *
 * The load-bearing cause was that {@link addToolsPathEntry} APPENDED, so a
 * runtime Genie had just installed could never win against anything already on
 * PATH. The machine did not need to be broken for this to bite — it only needed
 * another PHP.
 *
 * SCOPE — deliberately narrow, in three ways:
 *   - it reorders `process.env.PATH`, the environment Genie's own children
 *     inherit. It does not rewrite the persisted user PATH: that is the owner's
 *     shell environment, not Genie's, and a tool that silently edits it is worse
 *     than the problem it fixes. Genie re-applies precedence at every startup
 *     instead — see {@link applyToolchainPrecedence}.
 *   - it never DELETES another tool's entry, for the same reason. Herd's entries
 *     stay; they simply stop winning.
 *   - it reports `before` and `after` so the user can see what was wrong, rather
 *     than being told "repaired" with nothing to check.
 */
export async function repairToolchainPath(
    deps: ToolchainManagerDeps,
    opts: {
        tools?: string[];
        exists?: (dir: string) => boolean;
        dirs?: string[];
    } = {},
): Promise<{
    before: ToolchainPathReport;
    after: ToolchainPathReport;
    changed: boolean;
    /** Genie-owned `php.ini` files rewritten because they no longer matched what
     *  Genie writes today. */
    inis: string[];
}> {
    const sep = process.platform === 'win32' ? ';' : ':';
    const tools = opts.tools ?? ['php', 'node', 'npm', 'composer', 'python', 'git'];
    const exists =
        opts.exists ??
        ((d: string) => {
            try {
                return fsSync.existsSync(d);
            } catch {
                return false;
            }
        });

    const dirs = opts.dirs ?? (await currentManagedDirs(deps, exists));

    const resolveAll = async (): Promise<Record<string, string>> => {
        const out: Record<string, string> = {};
        for (const t of tools) {
            const exe = await resolveOnPath(t);
            if (exe) out[t] = exe;
        }
        return out;
    };

    const diagnose = async (): Promise<ToolchainPathReport> =>
        diagnoseToolchainPath({
            path: process.env.PATH ?? '',
            toolsDirs: dirs,
            sep,
            resolved: await resolveAll(),
            exists,
        });

    const before = await diagnose();
    applyToolchainPrecedence(dirs);
    const inis = await refreshManagedInis();
    const after = await diagnose();

    // "Changed" means the machine's ANSWERS changed, not that the string moved.
    // A PATH that was reordered while every tool still resolves to Herd is not a
    // repair, and reporting it as one is how a green button teaches people to
    // stop trusting it.
    const changed =
        before.toolsFirst !== after.toolsFirst ||
        before.shadowed.join(',') !== after.shadowed.join(',');

    return { before, after, changed: changed || inis.length > 0, inis };
}

/**
 * Rewrite the `php.ini` files Genie owns that have gone stale, and return the
 * paths actually written.
 *
 * Best-effort per file: one unwritable install must not abort the repair for the
 * rest, and a failure here leaves the machine exactly as it was.
 */
async function refreshManagedInis(): Promise<string[]> {
    const written: string[] = [];
    try {
        const installs = await machineInstalls({});
        // The bundle FIRST, so the ini can name a file that is already there.
        // Genie's PHP shipped with no CA bundle at all, so every hosted PHP site
        // failed every outbound HTTPS request (errno 60) — see toolchain-ca.ts.
        const bundles = new Map<string, string | null>();
        for (const install of installs) {
            if (install.source !== 'genie' || install.tool !== 'php') continue;
            bundles.set(install.dir, await writeCaBundle(install.dir, process.platform));
        }
        const stale = staleManagedInis({
            installs,
            platform: process.platform,
            read: (p) => fsSync.readFileSync(p, 'utf8'),
            bundleFor: (dir) => bundles.get(dir) ?? null,
        });
        for (const file of stale) {
            try {
                await writeFile(file.path, file.contents, 'utf8');
                written.push(file.path);
            } catch {
                /* one unwritable install must not abort the repair for the rest */
            }
        }
    } catch {
        /* a scan failure leaves every ini exactly as it was */
    }
    return written;
}

/**
 * Put Genie's managed directories at the front of THIS process's PATH.
 *
 * Called at startup and by the repair action. Idempotent: running it on an
 * already-correct PATH produces the same string. In-process only — nothing
 * outside Genie is modified, and nothing persists past this run, which is why it
 * must run every launch rather than once.
 */
export function applyToolchainPrecedence(dirs: string[]): void {
    if (dirs.length === 0) return;
    lastManagedDirs = dirs;
    const sep = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = pathWithToolsFirst(process.env.PATH ?? '', dirs, sep);
}

/**
 * The managed dirs as of the last time precedence was applied.
 *
 * Terminal spawn reads this rather than re-deriving: `currentManagedDirs` scans
 * the machine, and doing that on every terminal create would put a `where`/probe
 * sweep in front of opening a shell. Startup, an install, and a default change
 * all refresh it, which is every event that can change the answer.
 */
export function knownManagedDirs(): string[] {
    return lastManagedDirs;
}

let lastManagedDirs: string[] = [];

/** The managed dirs for the machine as it is right now. Scans installs and reads
 *  the stored defaults, so it reflects a version installed since startup. */
export async function currentManagedDirs(
    deps: ToolchainManagerDeps,
    exists: (dir: string) => boolean = (d) => {
        try {
            return fsSync.existsSync(d);
        } catch {
            return false;
        }
    },
): Promise<string[]> {
    const installs = await machineInstalls({});
    const stored = parseToolchainDefaults(deps.readDefaults());
    const defaults: ToolchainDefaults = {};
    for (const tool of LANGUAGE_TOOLS) {
        const resolved = defaultVersionFor(tool, installs, stored);
        if (resolved) defaults[tool] = resolved;
    }
    return managedPathDirs({
        installs,
        defaults,
        platform: process.platform,
        toolsDir: genieToolsDir(),
        exists,
    });
}
