import { AGENT_NAME, RESERVED_AGENT_NAMES } from './agent-adoption.js';
import { ACP_PROVIDERS } from './engine.js';

/**
 * A NEW AGENT, ASKED FOR (the owner, 2026-10-23: "it didn't give me any ux to choose name, purpose or anything that genie
 * 1 could even. it just created an agent with some dumb name and default settings"). Genie 1's NewAgentModal: a name,
 * shown as the folder it becomes; a purpose, required, written into the committed AGENT.md; a starting provider. Its
 * rules, on Genie 2's: the name pattern and reserved list adoption already applies (core/agent-adoption.ts), claude or
 * codex, and never a name the workspace already has. Model, mode and permissions are set afterwards, in Settings, as in
 * Genie 1. The pure half — the host writes the file and registers (main/agent-create-host.ts).
 */

/** The folder a typed name becomes: lower-case, every run of anything else one dash, the ends trimmed (Genie 1's slug). */
export function agentSlug(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export interface NewAgentInput {
    /** Already a slug (agentSlug). */
    readonly name: string;
    readonly purpose: string;
    readonly provider: string;
    /** The names the workspace already has. */
    readonly existing: readonly string[];
    /** The workspace's one Tynn grant (`sacred_agent_name`), which unlocks exactly that reserved name. */
    readonly sacredName: string | null;
}

/** Why this cannot be created, in words a person can act on — or `null`. */
export function newAgentRefusal(input: NewAgentInput): string | null {
    const name = input.name;
    if (name === '') return 'The agent needs a name.';
    if (!AGENT_NAME.test(name)) return `"${name}" cannot be an agent name: start with a letter, then lower-case letters, digits and dashes, at most 40.`;
    if (RESERVED_AGENT_NAMES.includes(name)) {
        const granted = (input.sacredName ?? '').trim().toLowerCase();
        if (granted !== name) return `"${name}" is a reserved name and cannot be used for an agent. Reserved: ${RESERVED_AGENT_NAMES.join(', ')}.`;
    }
    if (input.existing.some((n) => n.trim().toLowerCase() === name)) return `This workspace already has an agent named ${name}.`;
    if (input.purpose.trim() === '') return 'The agent needs a purpose: what it is for. It goes into its AGENT.md.';
    if (!(ACP_PROVIDERS as readonly string[]).includes(input.provider)) return `An agent here runs on ${ACP_PROVIDERS.join(' or ')}; "${input.provider}" is not one of them.`;
    return null;
}

/**
 * The AGENT.md a new agent starts with — Genie 1's `renderAgentFile`: its name and purpose, and `tuis:` naming the
 * provider it starts on (what adoption and Switch provider read back, core/agent-manifest.ts). The purpose is on one line.
 */
export function agentFileText(input: { name: string; purpose: string; provider: string }): string {
    const purpose = input.purpose.replace(/\s+/g, ' ').trim();
    return `---\nname: ${input.name}\npurpose: ${purpose}\ntuis: [${input.provider}]\n---\nYou are ${input.name}. ${purpose}\n`;
}
