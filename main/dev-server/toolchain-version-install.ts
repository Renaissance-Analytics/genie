import {
    LANGUAGE_LABELS,
    SOURCE_LABELS,
    TOOLCHAIN_RECIPES,
    assetFor,
    compareVersionsDesc,
    defaultVersionFor,
    engineExeName,
    genieVersionDir,
    joinFor,
    PHP_REQUIRED_MODULES,
    phpIniContents,
    selectableInstalls,
    type EngineInstall,
    type LanguageTool,
    type RecipeContext,
    type ToolchainDefaults,
    type VersionArtifact,
} from './toolchain-versions';

/**
 * Installing and REMOVING one version of a language into Genie's own
 * `<userData>/toolchain/<lang>/<version>`.
 *
 * Split the way the rest of the toolchain code is: {@link planVersionInstall}
 * and {@link planVersionRemoval} are PURE — the URL, the target directory, the
 * installer argv, the `php.ini`, and what happens to the machine default are all
 * decided with no network and no filesystem, so they are asserted directly.
 * {@link installEngineVersion} is pure but for five injected effects.
 *
 * Two rules it exists to enforce:
 *
 *  - **A pid is not proof it ran.** An unpack that exits 0 and leaves no working
 *    binary is a FAILED install. The success signal is the binary answering from
 *    the directory Genie put it in — nothing else.
 *  - **A failure leaves nothing behind.** A half-unpacked version directory
 *    would be found by the next scan and offered as an install, so every failure
 *    path deletes it.
 */

// --- the plan ---------------------------------------------------------------

export interface VersionInstallPlan {
    ok: true;
    tool: LanguageTool;
    version: string;
    /** The platform this plan's paths and failure modes belong to. Carried so a
     *  win32 plan reads the same on a posix CI runner. */
    platform: string;
    /** `<root>/<tool>/<version>` — the directory Genie owns and Remove deletes. */
    dir: string;
    /** Candidate download URLs, tried in order. */
    urls: string[];
    artifact: VersionArtifact;
    /** Archive top-level directory to strip on unpack; '' when it unpacks flat. */
    strip: string;
    /** Where the executables land — the version dir, or its `bin/`. */
    binDir: string;
    /** The primary executable, once installed. What `verify` runs. */
    exe: string;
    /** For an `exe` artifact: the installer argv, `{dir}` already substituted. */
    installerArgs?: string[];
    /** The config file Genie writes into the version dir (php only, so far). */
    configFile?: { path: string; body: string };
    /** Modules the installed binary must REPORT for this to count as installed.
     *  Set where {@link configFile} has to actually do something (php). */
    requireModules?: readonly string[];
    /**
     * Things that must be on the machine before this language can run at all.
     *
     * Genie INSTALLS these; it does not name them in an error and leave the user
     * to go and fetch something. php's Windows build imports `vcruntime140.dll`,
     * which only exists once the Visual C++ redistributable is installed, and a
     * clean machine does not have it — so an unpack that works perfectly is
     * followed by a binary that cannot start.
     */
    requires?: readonly EnginePrerequisite[];
}

/** A machine-level dependency Genie can install on a language's behalf. Narrow
 *  on purpose: this is not a general package concept, it is the short list of
 *  runtimes an official build refuses to start without. */
export type EnginePrerequisite = 'vcredist';

/** Human names, so a failure can say what it could not install. */
const PREREQUISITE_LABELS: Record<EnginePrerequisite, string> = {
    vcredist: 'the Microsoft Visual C++ 2015-2022 x64 Redistributable',
};

/**
 * What a language needs before it can run here.
 *
 * php on Windows and nothing else so far. Platform-scoped rather than a flat
 * table: the requirement belongs to the windows.php.net BUILD, not to php.
 */
export function enginePrerequisites(
    tool: LanguageTool,
    platform: string,
): readonly EnginePrerequisite[] {
    return tool === 'php' && platform === 'win32' ? ['vcredist'] : [];
}

export type VersionInstallPlanResult = VersionInstallPlan | { ok: false; reason: string };

/**
 * What Genie would do to install this version here — or WHY it will not.
 *
 * A version with no recipe is refused by name rather than attempted: the
 * pick-list is deliberately a short static table ("each release includes what we
 * know we can support"), so "8.9.9" is not an unlucky download, it is a version
 * this release does not claim to support.
 */
export function planVersionInstall(
    tool: LanguageTool,
    version: string,
    ctx: RecipeContext,
    root: string,
): VersionInstallPlanResult {
    const recipe = TOOLCHAIN_RECIPES.find((r) => r.tool === tool && r.version === version);
    if (!recipe) {
        return {
            ok: false,
            reason: `Genie has no installer for ${LANGUAGE_LABELS[tool]} ${version}. Pick one of the versions this release supports.`,
        };
    }
    const asset = assetFor(recipe, ctx);
    if (!asset) {
        return {
            ok: false,
            reason: `Genie cannot install ${LANGUAGE_LABELS[tool]} ${version} on ${ctx.os}${
                ctx.arch ? `/${ctx.arch}` : ''
            } — there is no official build it can fetch.`,
        };
    }

    const dir = genieVersionDir(root, tool, version, ctx.os);
    const binDir = joinFor(ctx.os, dir, asset.bin);
    return {
        ok: true,
        tool,
        version,
        platform: ctx.os,
        dir,
        urls: asset.urls,
        artifact: asset.artifact,
        strip: asset.strip,
        binDir,
        exe: joinFor(ctx.os, binDir, engineExeName(tool, ctx.os)),
        ...(asset.args ? { installerArgs: asset.args.map((a) => a.replace('{dir}', dir)) } : {}),
        ...(enginePrerequisites(tool, ctx.os).length > 0
            ? { requires: enginePrerequisites(tool, ctx.os) }
            : {}),
        // Genie owns the language CONFIG, not just the binaries — a version whose
        // php.ini someone else can rewrite is a version a site cannot rely on.
        ...(tool === 'php'
            ? {
                  configFile: {
                      path: joinFor(ctx.os, dir, 'php.ini'),
                      body: phpIniContents(dir, ctx.os),
                  },
                  // …and the config is checked, not assumed: a failed
                  // `extension=` line is silent apart from a stderr warning.
                  requireModules: PHP_REQUIRED_MODULES,
              }
            : {}),
    };
}

// --- the effects ------------------------------------------------------------

export interface VersionInstallEffects {
    /** Fetch the first URL that answers. */
    download(urls: string[]): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
    /** Unpack an archive into `dest`, stripping the archive's top directory. */
    unpack(req: {
        archive: string;
        artifact: VersionArtifact;
        strip: string;
        dest: string;
    }): Promise<{ ok: true } | { ok: false; error: string }>;
    /** Run a downloaded vendor installer. */
    runInstaller(
        installer: string,
        args: string[],
    ): Promise<{ ok: true } | { ok: false; error: string }>;
    writeFile(path: string, body: string): Promise<void>;
    /** Ask the INSTALLED binary for its version. The only success signal. */
    verify(exe: string): Promise<EngineProbe>;
    /**
     * Ask the installed binary which modules it LOADED, and for anything it
     * complained about on the way. Required rather than optional: a config Genie
     * writes and never checks is a config that can silently do nothing.
     */
    listModules(exe: string): Promise<LoadedModules>;
    /** Delete the version directory. Called on every failure path. */
    removeDir(dir: string): Promise<void>;
    /**
     * Put a directory on PATH — this process's, and the persisted user one.
     *
     * Without it an install is bytes on disk that nothing can find: the owner's
     * report was a Toolchain page saying Claude Code was installed and a fresh
     * terminal answering "command not found". Genie's own process could resolve
     * it because the install had augmented `process.env.PATH`; a newly spawned
     * shell inherits the SYSTEM environment and knew nothing about it.
     *
     * Called only after the binary has proven itself, so PATH never points at a
     * directory a failed install has already deleted. Never fails the install —
     * the bytes really are there, and reporting a good install as failed would
     * send someone to install it twice.
     */
    addToPath(dir: string): Promise<void>;
    /**
     * Make sure a machine-level prerequisite is installed, installing it if it
     * is not. Idempotent: called on every install, and a no-op when the thing is
     * already there.
     */
    ensurePrerequisite(
        name: EnginePrerequisite,
    ): Promise<{ ok: boolean; error?: string }>;
}

/** What the installed binary says it loaded, plus anything it grumbled about. */
export interface LoadedModules {
    /** Module names as the binary prints them (`Core`, `PDO`, `openssl`). */
    modules: string[];
    /** Loader complaints — an `extension=` naming something it cannot load. */
    warnings?: string;
}

/**
 * What asking the installed binary for its version actually found.
 *
 * It used to be a bare version-or-nothing, which is how the owner got "…\php.exe
 * did not run — nothing was installed." with no exit code, no stderr and nothing
 * to act on. The RAW facts come back here so the message can be built from them
 * by a pure function that no spawn is needed to test.
 */
export interface EngineProbe {
    /** The version it reported — the one and only success. */
    version?: string;
    /** The binary is not on disk. A different bug from one that will not run. */
    missing?: boolean;
    /** The process's exit code, when it started at all. */
    exitCode?: number | null;
    /** Its own words (stderr/stdout), or the spawn error. */
    detail?: string;
}

/**
 * Windows exit codes that mean the process NEVER STARTED.
 *
 * `0xC0000135` STATUS_DLL_NOT_FOUND and `0xC0000142` STATUS_DLL_INIT_FAILED are
 * raised by the loader before a single line of the program runs, so the process
 * prints nothing — the least self-explanatory failure there is, and the one a
 * clean machine hits. windows.php.net's builds import `vcruntime140.dll`
 * (verified against php-8.4.24-nts-Win32-vs17-x64), which a machine only has
 * once the Visual C++ redistributable is installed.
 */
const WINDOWS_LOADER_FAILURES: readonly number[] = [3221225781, 3221225785];

/** Microsoft's permanent short link for the x64 redistributable. */
const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

/**
 * PURE. Why the freshly installed binary did not answer, in words worth reading.
 *
 * Three different bugs, three different sentences: it never landed (a layout
 * mismatch), Windows could not load it (a missing runtime — named, with the
 * download), or it ran and objected (its own words).
 */
export function describeVerifyFailure(
    plan: Pick<VersionInstallPlan, 'tool' | 'version' | 'exe' | 'platform'>,
    probe: EngineProbe,
): string {
    const what = `${LANGUAGE_LABELS[plan.tool]} ${plan.version}`;
    if (probe.missing) {
        return `${what} unpacked, but ${plan.exe} is not there — the archive did not lay out the way Genie expected. Nothing was installed.`;
    }
    if (
        plan.platform === 'win32' &&
        typeof probe.exitCode === 'number' &&
        WINDOWS_LOADER_FAILURES.includes(probe.exitCode)
    ) {
        return (
            `${what} unpacked, but Windows could not start ${plan.exe} (exit 0x${probe.exitCode
                .toString(16)
                .toUpperCase()}) — the Visual C++ runtime it needs did not load. ` +
            `Genie installed that runtime before fetching ${LANGUAGE_LABELS[plan.tool]}, so the usual cause is that Windows has not picked it up yet: RESTART and add the version again. ` +
            `If it still fails, install ${VC_REDIST_URL} manually and say so — that is a Genie bug, not something you should have to do. Nothing was installed.`
        );
    }
    const said = probe.detail?.trim();
    const because = said
        ? `: ${said}`
        : probe.exitCode !== undefined && probe.exitCode !== null
          ? ` (exited ${probe.exitCode})`
          : '';
    return `${what} unpacked, but ${plan.exe} did not run${because}. Nothing was installed.`;
}

export type VersionInstallResult =
    | { ok: true; tool: LanguageTool; version: string; dir: string }
    | { ok: false; error: string };

/**
 * Carry out a plan. NEVER throws — a failed install is a reported failure, and
 * an effect that throws is treated as one.
 */
export async function installEngineVersion(
    plan: VersionInstallPlan,
    fx: VersionInstallEffects,
): Promise<VersionInstallResult> {
    const fail = async (error: string): Promise<VersionInstallResult> => {
        // Nothing half-installed survives: the scanner treats a directory with
        // the right binaries as an install, so a partial one is a lie on disk.
        try {
            await fx.removeDir(plan.dir);
        } catch {
            /* the failure below is what matters */
        }
        return { ok: false, error };
    };

    try {
        // FIRST, and before spending a download on a binary that provably cannot
        // start without it. Genie installs what the language needs rather than
        // telling someone to go and fetch it — an install that ends in a link to
        // a Microsoft download page is an install that did not happen.
        for (const name of plan.requires ?? []) {
            const prereq = await fx.ensurePrerequisite(name);
            if (!prereq.ok) {
                // No `fail()`: nothing has been written yet, so there is no
                // half-install to clean up and no directory to delete.
                return {
                    ok: false,
                    error:
                        `${LANGUAGE_LABELS[plan.tool]} ${plan.version} needs ${PREREQUISITE_LABELS[name]}, ` +
                        `and Genie could not install it${prereq.error ? `: ${prereq.error}` : ''}. Nothing was installed.`,
                };
            }
        }

        const dl = await fx.download(plan.urls);
        if (!dl.ok) return fail(dl.error);

        if (plan.artifact === 'exe') {
            const run = await fx.runInstaller(dl.path, plan.installerArgs ?? []);
            if (!run.ok) return fail(run.error);
        } else {
            const unpacked = await fx.unpack({
                archive: dl.path,
                artifact: plan.artifact,
                strip: plan.strip,
                dest: plan.dir,
            });
            if (!unpacked.ok) return fail(unpacked.error);
        }

        if (plan.configFile) {
            await fx.writeFile(plan.configFile.path, plan.configFile.body);
        }

        // The install is only real once the binary Genie will spawn answers — and
        // when it does not, the reason it gave is the whole point (genie#209).
        const probe = await fx.verify(plan.exe);
        if (!probe.version) {
            return fail(describeVerifyFailure(plan, probe));
        }

        // …and for a language whose config has to DO something, that the config
        // did it. A php that starts without openssl cannot `composer install`.
        if (plan.requireModules && plan.requireModules.length > 0) {
            const loaded = await fx.listModules(plan.exe);
            const problem = describeModuleFailure(plan, loaded);
            if (problem) return fail(problem);
        }

        // Proven, so now make it FINDABLE. Last, and only on success: a PATH
        // entry pointing at a directory the failure path just deleted would be
        // worse than none. A PATH failure is not an install failure — the
        // effect swallows its own trouble and says so in its own log.
        await fx.addToPath(plan.binDir);
        return { ok: true, tool: plan.tool, version: plan.version, dir: plan.dir };
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    }
}

/** Longest complaint kept — enough to name the extension, not a stack dump. */
const MODULE_WARNING_LIMIT = 400;

/**
 * What a MODULE line looks like: `php -m` prints one bare token per module
 * (`Core`, `PDO`, `pdo_mysql`, `Zend OPcache` is a Zend-section header, not this).
 *
 * Recognising modules POSITIVELY rather than filtering diagnostics out is what
 * makes a wrapped warning safe: a path containing a newline splits the complaint
 * across lines, and its tail ("ope\curl (The specified module could not be
 * found), C:") looks like no diagnostic prefix at all. Anything that is not a
 * single token is a complaint, whatever it says.
 */
const MODULE_LINE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * PURE. Split `php -m` output into the modules it loaded and what it complained
 * about.
 *
 * Both streams are read because **PHP's CLI prints startup warnings to STDOUT**,
 * not stderr — verified by running the real 8.4.24 build with a bad
 * `extension=` line and finding stderr completely empty. Looking only at stderr
 * finds nothing, and treating every stdout line as a module files the warning
 * itself as an installed module.
 */
export function parseModuleList(stdout: string, stderr: string): LoadedModules {
    const modules: string[] = [];
    const complaints: string[] = [];
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        // `[PHP Modules]` / `[Zend Modules]` are section headers, not modules.
        if (!line || line.startsWith('[')) continue;
        if (MODULE_LINE.test(line)) modules.push(line);
        else complaints.push(line);
    }
    // Nothing on stderr needs classifying: a binary that wrote to the error
    // stream at all was complaining, whatever the wording.
    if (stderr.trim()) complaints.push(stderr.trim());
    const warnings = complaints.join(' ').slice(0, MODULE_WARNING_LIMIT);
    return { modules, ...(warnings ? { warnings } : {}) };
}

/**
 * PURE. What is wrong with what the installed binary loaded, or undefined.
 *
 * Two ways the config can have failed quietly:
 *
 *   - a required module is simply NOT in the list — the `extension=` line was
 *     ignored, or `extension_dir` points somewhere with no DLLs in it;
 *   - the binary printed a loader complaint. Even with every required module
 *     present that is a real defect: some `extension=` line names something this
 *     build cannot load, and the warning will be repeated into every site log on
 *     every request until someone removes the line.
 *
 * Names are compared case-insensitively because `php -m` prints its own casing
 * (`Core`, `PDO`, `SPL`) which is not the casing an ini uses.
 */
export function describeModuleFailure(
    plan: Pick<VersionInstallPlan, 'tool' | 'version' | 'requireModules'>,
    loaded: LoadedModules,
): string | undefined {
    const what = `${LANGUAGE_LABELS[plan.tool]} ${plan.version}`;
    const have = new Set(loaded.modules.map((m) => m.toLowerCase()));
    const missing = (plan.requireModules ?? []).filter((m) => !have.has(m.toLowerCase()));
    if (missing.length > 0) {
        return `${what} installed, but it did not load ${missing.join(', ')} — the extensions Genie enabled are not active, so this ${LANGUAGE_LABELS[plan.tool]} cannot run a real app. Nothing was installed.`;
    }
    const warned = loaded.warnings?.trim();
    if (warned) {
        return `${what} installed, but it complained on startup: ${warned}. That warning would repeat on every request, so nothing was installed.`;
    }
    return undefined;
}

// --- removal ----------------------------------------------------------------

export type VersionRemovalPlan =
    | {
          ok: true;
          dir: string;
          /** Bytes the delete reclaims, when the scan measured it. */
          freedBytes?: number;
          /**
           * What the machine default must become: a version string when the
           * default is being removed and another Genie install can take over,
           * `null` when the last one is going, `undefined` when the default is
           * untouched.
           */
          nextDefault?: string | null;
      }
    | { ok: false; reason: string };

/**
 * Remove a version — and say what that does to the machine default.
 *
 * A foreign install is refused by NAME ("Herd installed this one"), because
 * "cannot remove" without the reason reads like a bug. Deleting the version
 * directory is what reclaims the disk: Genie put everything for that version
 * inside it, which is the practical payoff of owning the toolchain instead of
 * scattering files through a shared prefix.
 */
export function planVersionRemoval(
    install: EngineInstall,
    installs: EngineInstall[],
    defaults: ToolchainDefaults,
): VersionRemovalPlan {
    if (!install.removable || install.source !== 'genie') {
        return {
            ok: false,
            reason: `${SOURCE_LABELS[install.source]} installed this ${
                LANGUAGE_LABELS[install.tool]
            }, so Genie will not delete it. Remove it from ${SOURCE_LABELS[install.source]} instead.`,
        };
    }

    const current = defaultVersionFor(install.tool, installs, defaults);
    let nextDefault: string | null | undefined;
    if (current === install.version) {
        const survivors = selectableInstalls(installs.filter((i) => i.tool === install.tool))
            .filter((i) => i.version !== install.version)
            .map((i) => i.version)
            .sort(compareVersionsDesc);
        // A foreign install is never promoted — no default at all is honest, and
        // silently adopting Herd's is the model this design rejected.
        nextDefault = survivors[0] ?? null;
    }

    return {
        ok: true,
        dir: install.dir,
        ...(install.sizeBytes !== undefined ? { freedBytes: install.sizeBytes } : {}),
        ...(nextDefault !== undefined ? { nextDefault } : {}),
    };
}
