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
        personaPath: path.resolve(root, '.agents', name, 'AGENT.md'),
    };
}
