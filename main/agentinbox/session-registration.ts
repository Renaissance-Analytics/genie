import { bindsSessionAfterLaunch, isSafeSessionId } from './session-capture';

/**
 * Late-bind a harness-generated chat session to an EXISTING AgentInbox agent.
 *
 * Codex owns its session id and only reveals it when SessionStart fires. The
 * terminal's persisted `agent_id` is therefore the durable identity: update its
 * metadata and the live broker record in place so inbox cursors, queued mail,
 * channel membership, and DM history remain attached to the same agent.
 *
 * IDEMPOTENT, and that is load-bearing. The managed hook's matcher is
 * `startup|resume|clear` (`main/mcp/agent-config.ts`), so it RE-FIRES inside a
 * live TUI and a resume hands back the id already stored. Claude binds its chat
 * id once at launch (`--session-id`) and never re-registers, which is why only
 * Codex agents showed genie#229. `changed` tells the caller whether anything
 * actually moved, so a re-bind of a KNOWN session broadcasts nothing: that
 * broadcast makes the master window re-fetch and replace its entire spec list.
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
): { ok: true; agentId: string; changed: boolean } | { ok: false; error: string } {
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
    // The CAPABILITY, not the name (genie#261 category C). This read
    // `!== 'codex'`, and `genie` carries the same `strategy: 'hook'` — it mints
    // its id after launch and reports it back exactly as codex does — so a
    // Genie TUI agent's chat id could never bind. Nothing failed to compile and
    // nothing was logged: the agent simply had no conversation attached.
    if (!bindsSessionAfterLaunch(spec.meta?.agent)) {
        return {
            ok: false,
            error: `Late session registration is only for an agent whose harness reports its session id after launch; ${String(spec.meta?.agent ?? 'this agent')} does not.`,
        };
    }

    if (spec.meta?.chat_session_id === normalized) return { ok: true, agentId, changed: false };

    deps.updateTerminalSpec(spec.id, {
        meta: { ...(spec.meta ?? {}), chat_session_id: normalized },
    });
    deps.setChatSession(agentId, normalized);
    return { ok: true, agentId, changed: true };
}
