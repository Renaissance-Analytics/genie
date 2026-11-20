import type { AgentId } from '../core/identity.js';
import { CommsCache, type CommsMail } from '../core/comms.js';
import type { LiveSession } from '../core/roster.js';
import { commsFields } from './session-host.js';

/**
 * THE DASHBOARD'S COMMS ON A ROW PROBE (Tynn #956). A row probe that answers what `probe` does, plus the comms cell (§4.1):
 * who the agent exchanged AgentInbox mail with since its session started, read from `mailOf` (the inbox's `involving`,
 * bounded) through a CommsCache, so an agent's mail is scanned once per change and not on every snapshot (beta.59).
 *
 * WHY IT EXISTS: since Tynn #898 step 2d-4b (beta.65) this machine's window is served by genie-host's RemoteHost, so the
 * Dashboard's rows are genie-host's registry's, probed by its SessionHost — which carries no comms (it pushes its probe to
 * every window, and an age that changes every second does not belong in that push). Without this the Comms cell was empty
 * on every row, and with no count there was no hover and no flight path. The window's SessionEngineClient adds the same
 * fields to its own probe the same way (`commsFields`).
 */
export function withComms(probe: (id: AgentId) => LiveSession | null, mailOf: (id: AgentId) => CommsMail | null, now: () => number = Date.now): (id: AgentId) => LiveSession | null {
    const cache = new CommsCache((id) => mailOf(id as AgentId));
    return (id) => {
        const session = probe(id);
        if (session === null) return null;
        return { ...session, ...commsFields(cache.read(id, session.startedAt ?? 0, now())) };
    };
}
