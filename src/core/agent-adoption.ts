import { parseAgentManifest } from './agent-manifest.js';
import { isAcpProvider, type AcpProvider } from './engine.js';

/**
 * "IT CAME WITH AGENTS" — THE PURE HALF (Add workspace parity item 6; Genie 1 genie#459: lib/imported-agents.ts,
 * main/agents/roster.ts, main/agents/reserved-names.ts).
 *
 * `.agents/<name>/AGENT.md` travels with the repository; the registry that names agents lives on each machine. A workspace
 * added here therefore arrives with its agents on disk and none of them registered, and the next screen offered only
 * "create an agent" — the act that discards the identity the file carries. This lists them so they can be ADOPTED:
 * registered with their AGENT.md as their instructions, the file read and never rewritten.
 *
 * OFFERED, NEVER AUTOMATIC (Genie 1's rule): adopting whatever a clone contains would make `git pull` a way to gain agents.
 *
 * NEVER A NAME GENIE REFUSES. Genie 2's registry had no name rules of its own; these are Genie 1's, kept for adoption:
 * - the shape an agent name has in Genie 2 (createAgent's: lower-case letters, digits and dashes, starting with a letter) —
 *   a folder that is not one is listed with the rename it needs, never registered under a name that is not its folder's;
 * - the reserved terms `general`, `genie`, `tynn` — `genie` is also the OS agent's name and address (`genie://agent/genie`),
 *   so a workspace agent of that name could not be reached — unless the workspace's Tynn project grants exactly that ONE
 *   term (`sacred_agent_name`; a grant that is not itself reserved is inert, and one grant never unlocks another);
 * - an AGENT.md whose `tuis:` names no provider Genie 2 runs (claude, codex): its own word that Genie may not run it.
 * NEVER A DUPLICATE: a name the workspace already has (in any case) is not offered.
 */

/** Genie 1's reserved agent names (reserved-names.ts), matched on the whole name. */
export const RESERVED_AGENT_NAMES: readonly string[] = Object.freeze(['general', 'genie', 'tynn']);

/** An agent name in Genie 2 — createAgent's shape (mcp-tools-agents.ts). */
export const AGENT_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** A folder under `.agents/` that holds an `AGENT.md`, with the file's text. */
export interface AgentFile {
    readonly folder: string;
    readonly text: string;
}

export interface ImportedAgent {
    readonly name: string;
    /** The provider it would run on: the first in its `tuis:` Genie 2 runs, else Claude; `null` when its file allows none. */
    readonly provider: AcpProvider | null;
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

/** The provider an AGENT.md allows: its first `tuis:` entry Genie 2 runs; no `tuis:` = any, so Claude (Genie 2's default). */
function providerOf(text: string, folder: string): { provider: AcpProvider | null; refusal: string | null } {
    const manifest = parseAgentManifest(text === '' ? null : text, folder);
    if (!manifest.tuis) return { provider: 'claude', refusal: null };
    const runs = manifest.tuis.find((t) => isAcpProvider(t));
    if (runs && isAcpProvider(runs)) return { provider: runs, refusal: null };
    return { provider: null, refusal: `Its AGENT.md allows tuis: ${manifest.tuis.join(', ') || '(none)'}; Genie runs claude or codex. Add one of them to tuis: and it can be adopted.` };
}

/**
 * The agents a workspace brought and has not registered, alphabetically — each with its reason when it cannot be adopted,
 * so a refused file is said rather than silently missing. A name already registered in the workspace (any case) is left out.
 */
export function importedAgents(input: { files: readonly AgentFile[]; registered: readonly { name: string }[]; sacredName?: string | null }): ImportedAgent[] {
    const have = new Set(input.registered.map((a) => a.name.trim().toLowerCase()));
    return [...input.files]
        .filter((f) => !have.has(f.folder.toLowerCase()))
        .sort((a, b) => a.folder.localeCompare(b.folder))
        .map((f) => {
            const named = adoptionRefusal(f.folder, input.sacredName ?? null);
            const { provider, refusal } = providerOf(f.text, f.folder);
            return { name: f.folder, provider, instructions: `.agents/${f.folder}/AGENT.md`, refusal: named ?? refusal };
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
