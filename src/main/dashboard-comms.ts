import type { AgentId } from '../core/identity.js';
import type { CommsMail } from '../core/comms.js';
import type { LiveSession } from '../core/roster.js';

/**
 * THE DASHBOARD'S COMMS ON A ROW PROBE (Tynn #956). RED stub: answers the probe unchanged.
 */
export function withComms(probe: (id: AgentId) => LiveSession | null, mailOf: (id: AgentId) => CommsMail | null, now: () => number = Date.now): (id: AgentId) => LiveSession | null {
    void mailOf;
    void now;
    return probe;
}
