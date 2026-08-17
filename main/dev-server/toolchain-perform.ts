import { resolveFailureHelp } from './toolchain-resolve';
import type { CommandResult } from './container-runtime';
import type { HostToolName } from './toolchain-detect';
import type { AdapterContext, DirectSource, DownloadInstallCommand, InstallCommand, RunInstallCommand } from './toolchain-adapters';
import type { LanguageTool } from './toolchain-versions';
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
    /**
     * Install a LANGUAGE version through Genie's own per-version installer —
     * the same one the Toolchain page's "Add a version" runs (genie#212).
     *
     * REQUIRED, not optional, and for the same reason `onMachineChanged` is: the
     * wizard having its own private install path is the bug. A new caller that
     * cannot install an engine has to say so to the compiler rather than
     * silently falling back to writing somewhere the page cannot see.
     */
    installEngine(
        engine: LanguageTool,
        version: string,
    ): Promise<{ ok: boolean; error?: string }>;
    /**
     * Put a directory on PATH after a successful install (genie#214).
     *
     * For the agent CLIs, which now install into a Genie-owned npm prefix so the
     * install never needs root. That prefix is invisible to the system PATH, so
     * without this the tool is on disk and not runnable.
     */
    addToPath?(dir: string): Promise<void>;
}

/**
 * Put this command's install directory on PATH, when it declared one.
 *
 * Never fails the step: the package really is installed, and reporting a good
 * install as failed would send someone to install it a second time. A PATH that
 * could not be persisted still leaves the tool findable in this Genie session.
 */
async function applyPathAdd(command: RunInstallCommand, deps: PerformDeps): Promise<void> {
    if (!command.pathAdd || !deps.addToPath) return;
    try {
        await deps.addToPath(command.pathAdd);
    } catch {
        /* the bytes are on disk; PATH is a convenience layer over that fact */
    }
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
    return (command: InstallCommand) => {
        switch (command.via) {
            case 'run':
                return performRun(command, deps);
            case 'download':
                return performDownload(command, deps, ctx);
            case 'verify':
                return performVerify(command, deps);
            case 'engine':
                return performEngine(command, deps);
        }
    };
}

/**
 * Install a language through Genie's own per-version installer.
 *
 * No re-probe afterwards, and that is deliberate: the engine installer's success
 * signal is already the stronger one — the binary Genie will actually spawn,
 * answering from the directory Genie put it in, with its modules loaded. Asking
 * `php --version` on PATH after that would be a WEAKER check that could pass on
 * a completely different php (Herd's), which is the confusion this whole change
 * exists to end.
 */
async function performEngine(
    command: Extract<InstallCommand, { via: 'engine' }>,
    deps: PerformDeps,
): Promise<StepOutcome> {
    const res = await deps.installEngine(command.engine, command.version);
    return res.ok
        ? ok(command.version)
        : { ok: false, error: res.error ?? `could not install ${command.engine} ${command.version}` };
}

/**
 * Run an argv, then let the RE-PROBE have the last word.
 *
 * An exit code is the package manager's opinion; whether the tool is on the
 * machine is the fact, and the fact is what the user asked for. `winget install`
 * on a package that is already present exits non-zero with "Found an existing
 * package already installed" — an outcome that IS what we wanted, and reporting
 * it as a failure is what skipped claude-code and codex on a clean Windows box
 * (genie#209). So a non-zero exit fails only when the tool cannot be found
 * afterwards; with no verifier to appeal to, the exit code stands.
 */
async function performRun(
    command: Extract<InstallCommand, { via: 'run' }>,
    deps: PerformDeps,
): Promise<StepOutcome> {
    const res = await deps.run(command.command, command.args, { elevated: command.requiresElevation });
    if (res.code !== 0) {
        const version = await deps.verify?.(command.tool);
        if (!version) return { ok: false, error: reason(res) };
        await applyPathAdd(command, deps);
        return ok(version);
    }
    // The agent CLIs install into a Genie-owned npm prefix the system PATH knows
    // nothing about (genie#214). Adding it here — after success, never before —
    // is what makes `claude` runnable at a prompt instead of merely present.
    await applyPathAdd(command, deps);
    return ok(await deps.verify?.(command.tool));
}

/**
 * Confirm a tool an earlier step's package already brought, instead of
 * installing that package twice.
 *
 * With no verifier wired there is nothing to check against — the covering
 * install reported success and that is all the information there is, so the step
 * passes rather than failing a tool on no evidence.
 */
async function performVerify(
    command: Extract<InstallCommand, { via: 'verify' }>,
    deps: PerformDeps,
): Promise<StepOutcome> {
    if (!deps.verify) return ok(undefined);
    const version = await deps.verify(command.tool);
    return version
        ? ok(version)
        : {
              ok: false,
              error: `${command.coveredBy} installed, but ${command.tool} was not found afterwards — open a new terminal, or install ${command.tool} yourself and re-run detection.`,
          };
}

async function performDownload(
    command: DownloadInstallCommand,
    deps: PerformDeps,
    ctx: AdapterContext,
): Promise<StepOutcome> {
    const url = command.url ?? (command.source ? await deps.resolveDownloadUrl(command.source, ctx) : null);
    if (!url) {
        // Never a bare "could not resolve": name the index that came up empty and
        // what to do about it (genie#209).
        const help = command.source ? ` ${resolveFailureHelp(command.source, command.tool)}` : '';
        return { ok: false, error: `could not resolve a download URL for ${command.tool}.${help}` };
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
