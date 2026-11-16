import type { AgentId, AgentRecord } from '../core/identity.js';
import type { KeepGoingState } from '../core/plan-keepalive.js';
import type { LiveSession } from '../core/roster.js';

/** What the keepalive reads of the host: the session host's own answers. Not implemented: the RED commit's inert stub. */
export interface KeepaliveHostView {
    probe(agentId: AgentId): LiveSession | null;
    lastTurnEnd(agentId: AgentId): KeepGoingState['lastTurnEnd'];
    promptable(agentId: AgentId): number | null;
    stoppedByYou(agentId: AgentId): boolean;
}

export function keepGoingStateOf(
    _host: KeepaliveHostView,
    _find: (agentId: AgentId) => AgentRecord | undefined,
    _asked: (agentId: AgentId) => boolean,
    _agentId: AgentId,
): KeepGoingState | null {
    return null;
}
