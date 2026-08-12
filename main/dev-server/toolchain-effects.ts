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
 */
export function createToolchainPerformDeps(prim: ToolchainEffectPrimitives): PerformDeps {
    return {
        run: (command, args, opts) =>
            opts.elevated ? prim.runElevated(command, args) : prim.runner.run(command, args),
        resolveDownloadUrl: prim.resolveDownloadUrl,
        download: prim.download,
        installArtifact: prim.installArtifact,
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
