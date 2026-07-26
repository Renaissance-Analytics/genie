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
    managedEnv?: () => Record<string, string>;
    workspaceEnv?: (workspacePath: string) => Record<string, string>;
}

export function buildTerminalEnv(
    workspacePath: string | undefined,
    deps: TerminalEnvDeps = {},
): Record<string, string> {
    const managed = (deps.managedEnv ?? managedCredentialEnv)();
    if (!workspacePath) return managed;
    const workspace = (deps.workspaceEnv ?? loadWorkspaceTerminalEnv)(workspacePath);
    return { ...managed, ...workspace };
}
