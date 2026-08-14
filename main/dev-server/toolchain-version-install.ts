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
        dir,
        urls: asset.urls,
        artifact: asset.artifact,
        strip: asset.strip,
        binDir,
        exe: joinFor(ctx.os, binDir, engineExeName(tool, ctx.os)),
        ...(asset.args ? { installerArgs: asset.args.map((a) => a.replace('{dir}', dir)) } : {}),
        // Genie owns the language CONFIG, not just the binaries — a version whose
        // php.ini someone else can rewrite is a version a site cannot rely on.
        ...(tool === 'php'
            ? {
                  configFile: {
                      path: joinFor(ctx.os, dir, 'php.ini'),
                      body: phpIniContents(dir, ctx.os),
                  },
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
    verify(exe: string): Promise<string | undefined>;
    /** Delete the version directory. Called on every failure path. */
    removeDir(dir: string): Promise<void>;
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

        // The install is only real once the binary Genie will spawn answers.
        const version = await fx.verify(plan.exe);
        if (!version) {
            return fail(
                `${LANGUAGE_LABELS[plan.tool]} ${plan.version} unpacked, but ${plan.exe} did not run — nothing was installed.`,
            );
        }
        return { ok: true, tool: plan.tool, version: plan.version, dir: plan.dir };
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    }
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
