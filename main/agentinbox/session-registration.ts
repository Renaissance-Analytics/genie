import { isSafeSessionId } from './session-capture';

/**
 * Late-bind a harness-generated chat session to an EXISTING AgentInbox agent.
 *
 * Codex owns its session id and only reveals it when SessionStart fires. The
 * terminal's persisted `agent_id` is therefore the durable identity: update its
 * metadata and the live broker record in place so inbox cursors, queued mail,
 * channel membership, and DM history remain attached to the same agent.
 */
export function registerAgentInboxSession(
    terminalId: string,
    sessionId: string,
    deps: {
        getTerminalSpec: (id: string) => {
            id: string;
            meta?: Record<string, unknown> | null;
        } | null;
        updateTerminalSpec: (
            id: string,
            patch: { meta: Record<string, unknown> },
        ) => unknown;
        setChatSession: (agentId: string, sessionId: string) => void;
    },
): { ok: true; agentId: string } | { ok: false; error: string } {
    const normalized = sessionId.trim();
    if (!normalized) return { ok: false, error: 'A non-empty session id is required.' };
    if (!isSafeSessionId(normalized)) {
        return { ok: false, error: 'The session id has an invalid format.' };
    }

    const spec = deps.getTerminalSpec(terminalId);
    if (!spec) return { ok: false, error: 'Terminal not found.' };
    const agentId = spec.meta?.agent_id;
    if (typeof agentId !== 'string' || !agentId) {
        return { ok: false, error: 'That terminal is not an AgentInbox agent.' };
    }
    if (spec.meta?.agent !== 'codex') {
        return { ok: false, error: 'Late session registration is only supported for Codex agents.' };
    }

    deps.updateTerminalSpec(spec.id, {
        meta: { ...(spec.meta ?? {}), chat_session_id: normalized },
    });
    deps.setChatSession(agentId, normalized);
    return { ok: true, agentId };
}
