import type { AgentId } from '../core/identity.js';
import type { Resolution } from '../core/inbox.js';
import type { NudgeOutcome } from './process-scheduler.js';

/** STUB (Tynn #860 RED). */
export interface NudgeOnRosterDeps {
    readonly resolve: (address: string) => Resolution;
    readonly deliver: (id: AgentId, text: string, from: string) => boolean | Promise<boolean>;
}

export async function nudgeOnRoster(_deps: NudgeOnRosterDeps, _address: string, _text: string, _from: string): Promise<NudgeOutcome> {
    return { ok: true };
}
