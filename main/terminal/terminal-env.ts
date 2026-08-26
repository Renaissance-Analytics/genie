import { knownManagedDirs } from '../dev-server/toolchain-manager';
import { pathWithToolsFirst } from '../dev-server/toolchain-primitives';
import { loadWorkspaceTerminalEnv } from '../mcp/agent-config';
import { managedCredentialEnv } from '../host-core/crypto/managed-credentials';

/**
 * The ONE place a terminal's environment is assembled, so the managed-credential
 * injection can't be added to one spawn path and forgotten on another (`ipc.ts`
 * builds env in two places: a fresh create and a restored/reattached terminal).
 *
 * Precedence, lowest to highest:
 *
 *   1. **Tynn-managed credentials** — the owner's fleet-wide provisioning,
 *      opened in memory from the escrow bundle.
 *   2. **The workspace `.env`** (plus the healed `TYNN_AGENT_TOKEN`) — a value a
 *      human deliberately put in *this* workspace is a local override and beats
 *      the fleet default.
 *
 * (`ipc.ts` then layers explicit `opts.env` on top of the result, as it already
 * did — an explicit per-spawn value stays the final word.)
 *
 * Only the API-key providers appear here. The GitHub token and the Claude
 * subscription are materialized through their own CLI's credential store
 * precisely so they never ride a child process environment.
 */

export interface TerminalEnvDeps {
    managedEnv?: (projectId?: string | null) => Record<string, string>;
    workspaceEnv?: (workspacePath: string) => Record<string, string>;
    /** Genie's managed toolchain dirs, newest known set. */
    toolchainDirs?: () => string[];
    /** The PATH to prepend them to — this process's, already precedence-applied
     *  at startup, so a terminal and a site spawn the same binary. */
    basePath?: () => string;
    pathSep?: () => string;
}

/**
 * `projectId` is the Tynn project of the workspace this terminal belongs to. It
 * selects the owner's per-workspace credential override: a `project`-scoped API
 * key for THIS project wins over the account-wide one, and one belonging to a
 * different project is not applied at all. Omit it and only account-scoped
 * credentials are injected — which is the correct, conservative answer for a
 * terminal that belongs to no Tynn project.
 */
export function buildTerminalEnv(
    workspacePath: string | undefined,
    projectId?: string | null,
    deps: TerminalEnvDeps = {},
): Record<string, string> {
    const managed = (deps.managedEnv ?? managedCredentialEnv)(projectId);
    const workspace = workspacePath
        ? (deps.workspaceEnv ?? loadWorkspaceTerminalEnv)(workspacePath)
        : {};
    // Precedence LAST, so a PATH the workspace `.env` sets deliberately still
    // wins — same rule as every other key here.
    return withToolchainPath(
        { ...managed, ...workspace },
        {
            dirs: (deps.toolchainDirs ?? knownManagedDirs)(),
            basePath: (deps.basePath ?? (() => process.env.PATH ?? ''))(),
            sep: (deps.pathSep ?? (() => (process.platform === 'win32' ? ';' : ':')))(),
        },
    );
}

/**
 * Put Genie's own toolchain at the front of a terminal's PATH.
 *
 * The owner's report: Herd was uninstalled, left its binaries and its PATH entry
 * behind, and `php` kept resolving to it — with Herd's `php.ini`, because on
 * Windows PHP reads its config from the directory of the binary — while Genie's
 * `toolchain/php/8.4.24` sat unused. Every terminal, agent and dev server Genie
 * spawned inherited that.
 *
 * WHY here and not only in the main process: the detached pty-host is
 * connect-OR-spawn. A host started by an earlier Genie run survives an upgrade —
 * that is the point of the sidecar — and keeps the environment it was spawned
 * with, so repairing main's PATH does not reach it. Per-terminal env is layered
 * on top of the host's, so setting PATH here holds whichever host answers.
 *
 * Three deliberate limits:
 *   - an explicit PATH the caller already set WINS. `opts.env` is the final word
 *     at the spawn site, and a deliberate per-spawn PATH stays deliberate;
 *   - with no managed dirs it returns the env untouched rather than writing an
 *     empty PATH — breaking every terminal to fix nothing is not a repair;
 *   - it PREPENDS. Nothing is removed, so a tool Genie does not manage is still
 *     found exactly where it was.
 */
export function withToolchainPath(
    env: Record<string, string>,
    opts: { dirs: string[]; basePath: string; sep: string },
): Record<string, string> {
    if (opts.dirs.length === 0 || env.PATH !== undefined) return env;
    return { ...env, PATH: pathWithToolsFirst(opts.basePath, opts.dirs, opts.sep) };
}
