import type { AgentConfig } from './agent-config.js';
import { isAcpProvider, type AcpProvider } from './engine.js';

/**
 * "IT CAME WITH AGENTS" — THE PURE HALF (Add workspace parity item 6; Genie 1 genie#459: lib/imported-agents.ts,
 * main/agents/roster.ts, main/agents/reserved-names.ts).
 *
 * `.agents/<name>/AGENT.md` travels with the repository; the registry that names agents lives on each machine. A workspace
 * added here therefore arrives with its agents on disk and none of them registered, and the next screen offered only
 * "create an agent" — the act that discards the identity the file carries. This lists them so they can be ADOPTED:
 * registered with their AGENT.md as their instructions. Their config — the provider among it — is the workspace's
 * project.json `agents.<name>` (Tynn #694), where any old front matter was moved the first time Genie read the workspace.
 *
 * OFFERED, NEVER AUTOMATIC (Genie 1's rule): adopting whatever a clone contains would make `git pull` a way to gain agents.
 *
 * NEVER A NAME GENIE REFUSES. Genie 2's registry had no name rules of its own; these are Genie 1's, kept for adoption:
 * - the shape an agent name has in Genie 2 (createAgent's: lower-case letters, digits and dashes, starting with a letter) —
 *   a folder that is not one is listed with the rename it needs, never registered under a name that is not its folder's;
 * - the reserved terms `general`, `genie`, `tynn` — `genie` is also the OS agent's name and address (`genie://agent/genie`),
 *   so a workspace agent of that name could not be reached — unless the workspace's Tynn project grants exactly that ONE
 *   term (`sacred_agent_name`; a grant that is not itself reserved is inert, and one grant never unlocks another);
 * NEVER A DUPLICATE: a name the workspace already has (in any case) is not offered.
 */

/** Genie 1's reserved agent names (reserved-names.ts), matched on the whole name. */
export const RESERVED_AGENT_NAMES: readonly string[] = Object.freeze(['general', 'genie', 'tynn']);

/** An agent name in Genie 2 — createAgent's shape (mcp-tools-agents.ts). */
export const AGENT_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** A folder under `.agents/` that holds an `AGENT.md`. */
export interface AgentFile {
    readonly folder: string;
}

export interface ImportedAgent {
    readonly name: string;
    /**
     * The provider it is adopted on: its project.json `provider` when Genie runs it; else, as a hint, the first provider
     * Genie runs that its `tuis` names (never a refusal); else Genie's default (Tynn #694).
     */
    readonly provider: AcpProvider;
    /** Its persona, relative to the workspace — what the registry records as its instructions. */
    readonly instructions: string;
    /** Why it cannot be adopted as it stands, or `null`. */
    readonly refusal: string | null;
}

/** Why `.agents/<folder>` cannot be adopted under its name, or `null`. `sacredName`: the workspace's one granted term. */
export function adoptionRefusal(folder: string, sacredName: string | null): string | null {
    if (!AGENT_NAME.test(folder)) {
        return `The folder .agents/${folder} is not an agent name Genie can register: names are lower-case letters, digits and dashes, starting with a letter, at most 40. Rename the folder and it can be adopted.`;
    }
    if (!RESERVED_AGENT_NAMES.includes(folder)) return null;
    const granted = (sacredName ?? '').trim().toLowerCase();
    if (granted !== '' && RESERVED_AGENT_NAMES.includes(granted) && granted === folder) return null;
    return `"${folder}" is a reserved name and cannot be used for an agent. Reserved: ${RESERVED_AGENT_NAMES.join(', ')}. Rename the folder to say what the agent does.`;
}

/** Genie's default provider for an adopted agent. */
export const ADOPTION_DEFAULT_PROVIDER: AcpProvider = 'claude';

/** The provider to adopt on: project.json's `provider`, else its `tuis`' first provider Genie runs, else the default. */
function providerOf(config: AgentConfig | undefined, fallback: AcpProvider): AcpProvider {
    if (config?.provider !== undefined && isAcpProvider(config.provider)) return config.provider;
    const hint = config?.tuis?.find((t) => isAcpProvider(t));
    return hint && isAcpProvider(hint) ? hint : fallback;
}

/**
 * The agents a workspace brought and has not registered, alphabetically — each with its reason when it cannot be adopted,
 * so a refused file is said rather than silently missing. A name already registered in the workspace (any case) is left out.
 */
export function importedAgents(input: { files: readonly AgentFile[]; registered: readonly { name: string }[]; configs?: Readonly<Record<string, AgentConfig>>; sacredName?: string | null; defaultProvider?: AcpProvider }): ImportedAgent[] {
    const have = new Set(input.registered.map((a) => a.name.trim().toLowerCase()));
    return [...input.files]
        .filter((f) => !have.has(f.folder.toLowerCase()))
        .sort((a, b) => a.folder.localeCompare(b.folder))
        .map((f) => {
            const named = adoptionRefusal(f.folder, input.sacredName ?? null);
            const config = input.configs && Object.hasOwn(input.configs, f.folder) ? input.configs[f.folder] : undefined;
            const provider = providerOf(config, input.defaultProvider ?? ADOPTION_DEFAULT_PROVIDER);
            return { name: f.folder, provider, instructions: `.agents/${f.folder}/AGENT.md`, refusal: named };
        });
}

/** Genie 1's decision (lib/imported-agents.ts): a screen only when something is unregistered, and its headline. */
export function importedAgentsOffer(list: readonly ImportedAgent[]): { offer: boolean; headline: string } {
    const n = list.length;
    if (n === 0) return { offer: false, headline: '' };
    return { offer: true, headline: n === 1 ? '1 agent already belongs to this project and is not registered on this machine.' : `${n} agents already belong to this project and are not registered on this machine.` };
}

/**
 * The workspace's sacred grant: the `sacred_agent_name` Tynn gives its linked project (MeApiController::projectRow — the
 * reserved name or null; Tynn is the source of truth and Genie has no toggle of its own). Anything else grants nothing.
 */
export function sacredNameOf(rows: readonly unknown[], projectId: string | null): string | null {
    if (projectId === null) return null;
    for (const raw of rows) {
        if (typeof raw !== 'object' || raw === null) continue;
        const r = raw as { id?: unknown; sacred_agent_name?: unknown };
        if (String(r.id) !== projectId) continue;
        return typeof r.sacred_agent_name === 'string' && r.sacred_agent_name.trim() !== '' ? r.sacred_agent_name.trim().toLowerCase() : null;
    }
    return null;
}
