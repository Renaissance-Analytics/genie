import type { AgentId } from '../core/identity.js';
import type { Resolution } from '../core/inbox.js';
import type { NudgeOutcome } from './process-scheduler.js';

/**
 * A SCHEDULED NUDGE, AND WHY IT DID NOT ARRIVE (Tynn #860). genie-host's nudge used to answer a bare false for every miss,
 * and the row said "Failed" with nothing else. Each miss now says which one it was, in words the person can act on:
 * - the address names no agent here (renamed, removed, a typo, a workspace slug that changed);
 * - it names more than one (a bare name two workspaces share) — the full addresses are listed;
 * - it names the person, not an agent;
 * - the agent has no running session to take it (the host's `deliver` answers false: the agent was never started in this
 *   Genie, or it was stopped) — a nudge does not start an agent;
 * - the delivery threw.
 */

export interface NudgeOnRosterDeps {
    readonly resolve: (address: string) => Resolution;
    /** The host's delivery, now or when the agent's turn ends; false = it has no session to take it. */
    readonly deliver: (id: AgentId, text: string, from: string) => boolean | Promise<boolean>;
    /** STUB (Tynn #860 RED): the host's one wake. */
    readonly wake?: (id: AgentId) => Promise<import('./host-mail-wake.js').HostWake>;
}

export async function nudgeOnRoster(deps: NudgeOnRosterDeps, address: string, text: string, task: string): Promise<NudgeOutcome> {
    const found = deps.resolve(address);
    if (found.kind === 'none') return { ok: false, reason: `no agent answers to "${address}" on this machine` };
    if (found.kind === 'human') return { ok: false, reason: `"${address}" is the person, not an agent` };
    if (found.kind === 'ambiguous') return { ok: false, reason: `"${address}" names more than one agent (${found.forms.join(', ')}); use the full address` };
    try {
        const delivered = await deps.deliver(found.id, text, `scheduled task "${task}"`);
        return delivered ? { ok: true } : { ok: false, reason: `${address} is not running: Genie has no session for it to take the nudge (start the agent, or send it a message)` };
    } catch (error) {
        return { ok: false, reason: `the delivery to ${address} failed: ${error instanceof Error ? error.message : String(error)}` };
    }
}
