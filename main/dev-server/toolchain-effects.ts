import type { CommandResult, CommandRunner } from './container-runtime';
import { INSTALL_RUN_OPTIONS } from './run-budget';
import { probeRuntime } from './runtime-detect';
import { detectToolchain, probeHostTool, TOOL_SPECS } from './toolchain-detect';
import type { FileExists, HostToolName } from './toolchain-detect';
import type { AdapterContext, DirectSource, DownloadInstallCommand } from './toolchain-adapters';
import type { LanguageTool } from './toolchain-versions';
import type { PerformDeps } from './toolchain-perform';

/**
 * Assemble the REAL {@link PerformDeps} the executor runs through, from a
 * machine's primitives.
 *
 * This is the boundary between the tested decision engine and the platform:
 * above it, everything is pure/seamed and proven; here, the primitives
 * (`runElevated`, `download`, `resolveDownloadUrl`, `installArtifact`) are the
 * genuinely impure bits, injected so the wiring is provable and each impl is
 * swapped in at the composition root / IPC. Only two decisions are made here and
 * both are tested — route an elevated command to the elevated runner, and verify
 * an install by re-probing the tool — so nothing that needs a spawn, a download
 * or a UAC prompt is decided in code that can't be unit-tested.
 */

export interface ToolchainEffectPrimitives {
    /** The plain command runner (unelevated). */
    runner: CommandRunner;
    /** Run a command elevated (UAC / sudo / pkexec) — see `elevate.ts`. */
    runElevated: (command: string, args: string[]) => Promise<CommandResult>;
    /** Fetch a URL to a local artifact path. */
    download: (url: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    /** Resolve a versioned direct source to a concrete URL, or null. */
    resolveDownloadUrl: (source: DirectSource, ctx: AdapterContext) => Promise<string | null>;
    /** Run a downloaded artifact (installer / script / place a phar). */
    installArtifact: (command: DownloadInstallCommand, localPath: string) => Promise<CommandResult>;
    /** Install a language version through Genie's own per-version installer —
     *  the Toolchain page's installer, shared so there is only one (genie#212). */
    installEngine: (engine: LanguageTool, version: string) => Promise<{ ok: boolean; error?: string }>;
    /** Put a directory on PATH — this process and the persisted user PATH. */
    addToPath: (dir: string) => Promise<void>;
    /** Verify a runtime LIBRARY, which has no `--version` to ask. */
    fileExists?: FileExists;
    /** Where Windows lives; only the library check reads it. */
    systemRoot?: string;
}

/**
 * Build the effect. `run` picks the elevated runner iff the command needs it;
 * `verify` re-detects the tool (docker via its engine, everything else via
 * `--version`) so a fresh install reports the version it landed. Everything else
 * is the injected primitive, unchanged.
 *
 * ## `onMachineChanged` is required on purpose
 *
 * The Toolchain page caches its scan of what is installed, and the only things
 * that dropped that cache were the page's own add-version and remove-version.
 * The setup wizard installs through `runInstallPlan`, which never touched it, so
 * a user could watch the wizard install Node.js, close it, open the Toolchain
 * page and be told nothing was installed (genie#209).
 *
 * Fixing that at each call site is what produced the bug in the first place, so
 * the notification lives HERE: every install path has to come through this
 * assembly to get a {@link PerformInstall}, and because the callback is a
 * required argument rather than an optional one, a new path cannot quietly skip
 * it — the compiler asks. It fires on the MUTATING effects only; `verify` is a
 * read and must not throw away a cache it did not dirty. It fires on FAILURE
 * too: a winget install that exits non-zero, or an extract that died halfway,
 * has still moved bytes.
 */
export function createToolchainPerformDeps(
    prim: ToolchainEffectPrimitives,
    onMachineChanged: () => void,
): PerformDeps {
    /** Run the effect, then say the machine changed — whatever the outcome. */
    const mutating = async <T>(effect: () => Promise<T>): Promise<T> => {
        try {
            return await effect();
        } finally {
            onMachineChanged();
        }
    };
    return {
        // INSTALL_RUN_OPTIONS is not optional decoration. Without a third
        // argument this call inherited `seams.ts`'s probe-sized default and
        // gave `winget install --id Git.Git` two minutes — while the elevated
        // branch beside it had fifteen. See `run-budget.ts`.
        run: (command, args, opts) =>
            mutating(() =>
                opts.elevated
                    ? prim.runElevated(command, args)
                    : prim.runner.run(command, args, INSTALL_RUN_OPTIONS),
            ),
        resolveDownloadUrl: prim.resolveDownloadUrl,
        download: prim.download,
        installArtifact: (command, localPath) =>
            mutating(() => prim.installArtifact(command, localPath)),
        installEngine: (engine, version) => mutating(() => prim.installEngine(engine, version)),
        addToPath: (dir) => prim.addToPath(dir),
        verify: (tool) => verifyToolVersion(tool, prim),
    };
}

/**
 * Read an installed tool's version back.
 *
 * Docker asks the ENGINE (a just-installed-but-unstarted Docker has no server
 * version yet → undefined, which is the honest answer). A runtime LIBRARY has
 * no version to ask for at all, so its files are checked and a presence MARKER
 * comes back — which matters, because the executor treats a truthy answer as
 * proof that a non-zero exit still left the thing installed, and the VC++
 * redistributable exits 3010 ("reboot required") on a perfectly good install.
 * Everything else answers `--version`.
 */
async function verifyToolVersion(
    tool: HostToolName,
    prim: ToolchainEffectPrimitives,
): Promise<string | undefined> {
    if (tool === 'docker') {
        // Engine version when the daemon answers; otherwise the CLI's own, which
        // is what makes an installed-but-STOPPED Docker Desktop read as installed
        // rather than missing. Reporting nothing here is what let the Toolchain
        // page contradict the wizard about Docker (genie#212), and — now that the
        // page offers Install — would have offered to install it a second time.
        const probe = await probeRuntime('docker', prim.runner);
        return probe.version ?? probe.clientVersion;
    }
    const spec = TOOL_SPECS[tool];
    if (spec.files) {
        const probe = await detectToolchain({
            runner: prim.runner,
            platform: 'win32',
            wanted: [tool],
            ...(prim.fileExists ? { fileExists: prim.fileExists } : {}),
            ...(prim.systemRoot ? { systemRoot: prim.systemRoot } : {}),
        });
        return probe.present.includes(tool) ? LIBRARY_PRESENT : undefined;
    }
    return (await probeHostTool(spec, prim.runner)).version;
}

/** What a library reports instead of a version. Not a version number and not
 *  pretending to be one — it says the files are in place. */
export const LIBRARY_PRESENT = 'present';
