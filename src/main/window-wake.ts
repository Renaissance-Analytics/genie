import type { AgentRecord } from '../core/identity.js';

/**
 * THE WINDOW'S OWN WAKE (the emergency no-host path only: genie-host could not start, so this window runs the agents).
 * Mail and IssueWatch's `push` start a stopped agent through it, under the person's refusals (an asleep workspace, the
 * agent cap), each said by name. With genie-host the wake is the host's (host-mail-wake.ts).
 */
export interface WindowWakePorts {
    /** SAFE MODE (Tynn #386): read from the same runtime files genie-host would read (window-safe-mode.ts). */
    readonly safeMode: () => boolean;
    readonly find: (agentId: string) => AgentRecord | null;
    readonly running: (record: AgentRecord) => boolean;
    readonly refusal: (record: AgentRecord) => string | null;
    readonly start: (record: AgentRecord) => Promise<boolean>;
    readonly log: (line: string) => void;
}

export function windowWake(p: WindowWakePorts): (agentId: string) => Promise<boolean> {
    return async (agentId) => {
        const record = p.find(agentId);
        if (!record) return false;
        // SAFE MODE (Tynn #386): no stopped agent is started by itself; the notice waits. A running one is told as ever.
        if (p.safeMode() && !p.running(record)) {
            p.log(`[genie] a notice for ${record.name} waits: Genie is in safe mode, so nothing is started by itself`);
            return false;
        }
        const refused = p.refusal(record);
        if (refused) { p.log(`[genie] a notice for ${record.name} waits: ${refused}`); return false; }
        return p.start(record);
    };
}
