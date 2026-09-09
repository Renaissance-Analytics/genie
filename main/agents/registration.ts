import path from 'node:path';
import { agentName } from './identity';

export interface AgentRegistrationInput {
    name: string;
    purpose: string;
    bootFolder?: string;
}

export type ResolvedAgentRegistration =
    | {
          ok: true;
          name: string;
          purpose: string;
          bootCwd: string;
          personaPath: string;
      }
    | { ok: false; error: string };

function contained(root: string, candidate: string): boolean {
    const rel = path.relative(root, candidate);
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * `<workspace>/.agents/<slug>/AGENT.md` — the ONE derivation of where an
 * agent's persona lives.
 *
 * Exported because registration is no longer the only caller: the agent manager
 * derives the same path for an agent whose row never got one (genie#570), and
 * two derivations free to drift is exactly how an editor ends up writing a
 * second file beside the one the roster reads.
 *
 * Keyed on `agentName`, which is what makes it safe for a name a human or an
 * agent typed. The slug is lowercase `[a-z0-9-]` with every separator already
 * collapsed, so it is always exactly one path segment: it cannot escape
 * `.agents/`, and it cannot resolve to one file on a case-insensitive
 * filesystem and two on a case-sensitive one. It is also the name the ROSTER
 * matches folders by (`workspaceRoster` looks a row up by `row.name`), so the
 * file this names is the file that agent is shown as owning.
 *
 * Same name, same file — deliberately. `claude:tynn` and `codex:tynn` are two
 * agents (`idx_workspace_agents_tui_name`) sharing one persona, and the file's
 * own `tuis:` line is what says which drivers may run it.
 */
export function agentPersonaPath(workspaceRoot: string, name: string): string {
    return path.resolve(path.resolve(workspaceRoot), '.agents', agentName(name), 'AGENT.md');
}

/** Resolve registration paths once, with the workspace boundary fail-closed. */
export function resolveAgentRegistration(
    workspaceRoot: string,
    input: AgentRegistrationInput,
): ResolvedAgentRegistration {
    const root = path.resolve(workspaceRoot);
    const name = agentName(input.name);
    const purpose = input.purpose.trim();
    if (!purpose) return { ok: false, error: 'registerAgent needs a stated `purpose`.' };

    const bootCwd = path.resolve(root, input.bootFolder?.trim() || '.');
    if (!contained(root, bootCwd)) {
        return { ok: false, error: 'The agent boot folder must stay inside the workspace.' };
    }
    return {
        ok: true,
        name,
        purpose,
        bootCwd,
        personaPath: agentPersonaPath(root, name),
    };
}
