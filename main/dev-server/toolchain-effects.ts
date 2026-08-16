import type { CommandResult, CommandRunner } from './container-runtime';
import { probeRuntime } from './runtime-detect';
import { probeHostTool, TOOL_SPECS } from './toolchain-detect';
import type { HostToolName } from './toolchain-detect';
import type { AdapterContext, DirectSource, DownloadInstallCommand } from './toolchain-adapters';
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
        run: (command, args, opts) =>
            mutating(() =>
                opts.elevated ? prim.runElevated(command, args) : prim.runner.run(command, args),
            ),
        resolveDownloadUrl: prim.resolveDownloadUrl,
        download: prim.download,
        installArtifact: (command, localPath) =>
            mutating(() => prim.installArtifact(command, localPath)),
        verify: (tool) => verifyToolVersion(tool, prim.runner),
    };
}

/** Read an installed tool's version back. Docker asks the ENGINE (a just-
 *  installed-but-unstarted Docker has no server version yet → undefined, which
 *  is the honest answer); every other tool answers `--version`. */
async function verifyToolVersion(
    tool: HostToolName,
    runner: CommandRunner,
): Promise<string | undefined> {
    if (tool === 'docker') {
        return (await probeRuntime('docker', runner)).version;
    }
    return (await probeHostTool(TOOL_SPECS[tool], runner)).version;
}
