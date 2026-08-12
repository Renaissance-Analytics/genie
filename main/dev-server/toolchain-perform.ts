import type { CommandResult } from './container-runtime';
import type { HostToolName } from './toolchain-detect';
import type { AdapterContext, DirectSource, DownloadInstallCommand, InstallCommand } from './toolchain-adapters';
import type { PerformInstall, StepOutcome } from './toolchain-install';

/**
 * The ROUTER from a materialised {@link InstallCommand} to the real world.
 *
 * The executor ({@link import('./toolchain-install')}) decides WHAT to run and in
 * what order; this decides HOW to carry out one command — run an argv, or fetch
 * an artifact and run that — and threads the elevation flag and the version
 * check through. It is deliberately a thin seam over four effects
 * ({@link PerformDeps}) so the routing and the failure handling are testable
 * without a spawn, an HTTP client or a filesystem; the effects themselves are
 * the impure part, wired for real in the wizard's main process and covered by
 * CI/owner runs (the Genie installer is not buildable locally on Windows).
 *
 * Every path resolves to a {@link StepOutcome}; a failure at any stage — a
 * non-zero exit, an unresolvable version, a dead download — is `{ ok: false }`
 * with the reason, never a throw.
 */

export interface PerformDeps {
    /** Run a command. `elevated` routes it through the OS elevation launcher
     *  (UAC / pkexec / osascript) — see `elevate.ts`. */
    run(command: string, args: string[], opts: { elevated: boolean }): Promise<CommandResult>;
    /** Resolve a versioned direct source (git-for-windows / nodejs-dist /
     *  php-windows) to a concrete URL, or null when it cannot. */
    resolveDownloadUrl(source: DirectSource, ctx: AdapterContext): Promise<string | null>;
    /** Fetch a URL to a local artifact path. */
    download(url: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    /** Run a downloaded artifact — an installer, a script, or place a phar. The
     *  artifact-specific handling (MSI vs dmg vs get.docker.com) lives here. */
    installArtifact(command: DownloadInstallCommand, localPath: string): Promise<CommandResult>;
    /** Re-detect a tool's version after install, for the outcome. Optional. */
    verify?(tool: HostToolName): Promise<string | undefined>;
}

/** Trim a failure message to something a wizard row can show. */
const OUTPUT_TAIL = 400;
const reason = (res: CommandResult): string =>
    (res.stderr || res.stdout || `exited ${res.code}`).trim().slice(-OUTPUT_TAIL);

/**
 * Build a {@link PerformInstall} bound to this machine's {@link AdapterContext}
 * (fixed for a run, and needed to resolve a per-arch download URL).
 */
export function createPerformInstall(deps: PerformDeps, ctx: AdapterContext): PerformInstall {
    return (command: InstallCommand) =>
        command.via === 'run' ? performRun(command, deps) : performDownload(command, deps, ctx);
}

async function performRun(
    command: Extract<InstallCommand, { via: 'run' }>,
    deps: PerformDeps,
): Promise<StepOutcome> {
    const res = await deps.run(command.command, command.args, { elevated: command.requiresElevation });
    if (res.code !== 0) return { ok: false, error: reason(res) };
    return ok(await deps.verify?.(command.tool));
}

async function performDownload(
    command: DownloadInstallCommand,
    deps: PerformDeps,
    ctx: AdapterContext,
): Promise<StepOutcome> {
    const url = command.url ?? (command.source ? await deps.resolveDownloadUrl(command.source, ctx) : null);
    if (!url) {
        return { ok: false, error: `could not resolve a download URL for ${command.tool}` };
    }

    const dl = await deps.download(url);
    if (!dl.ok || !dl.path) {
        return { ok: false, error: dl.error ?? `download failed for ${command.tool}` };
    }

    const res = await deps.installArtifact(command, dl.path);
    if (res.code !== 0) return { ok: false, error: reason(res) };
    return ok(await deps.verify?.(command.tool));
}

const ok = (version: string | undefined): StepOutcome => ({ ok: true, ...(version ? { version } : {}) });
