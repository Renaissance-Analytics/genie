import { describe, expect, it, vi } from 'vitest';
import { registerAgentInboxSession } from '../session-registration';

describe('registerAgentInboxSession', () => {
    it('rebinds a generated Codex session id to the existing durable agent in place', () => {
        const spec = {
            id: 'term-1',
            meta: {
                agent: 'codex',
                agent_id: 'agent-1',
                whisper_purpose: 'tynn',
                chat_session_id: 'stale-session',
            },
        };
        const updateTerminalSpec = vi.fn();
        const setChatSession = vi.fn();

        const result = registerAgentInboxSession('term-1', 'generated-session', {
            getTerminalSpec: vi.fn(() => spec),
            updateTerminalSpec,
            setChatSession,
        });

        expect(result).toEqual({ ok: true, agentId: 'agent-1', changed: true });
        expect(updateTerminalSpec).toHaveBeenCalledWith('term-1', {
            meta: {
                agent: 'codex',
                agent_id: 'agent-1',
                whisper_purpose: 'tynn',
                chat_session_id: 'generated-session',
            },
        });
        expect(setChatSession).toHaveBeenCalledWith('agent-1', 'generated-session');
        expect(spec.meta.agent_id).toBe('agent-1');
    });

    it('refuses to create a replacement identity when the terminal has no existing agent', () => {
        const updateTerminalSpec = vi.fn();
        const setChatSession = vi.fn();

        expect(
            registerAgentInboxSession('term-1', 'generated-session', {
                getTerminalSpec: vi.fn(() => ({
                    id: 'term-1',
                    meta: { agent: 'codex' },
                })),
                updateTerminalSpec,
                setChatSession,
            }),
        ).toEqual({ ok: false, error: 'That terminal is not an AgentInbox agent.' });
        expect(updateTerminalSpec).not.toHaveBeenCalled();
        expect(setChatSession).not.toHaveBeenCalled();
    });

    it('rejects a session id that could become shell syntax on a later resume', () => {
        const updateTerminalSpec = vi.fn();
        const setChatSession = vi.fn();

        expect(
            registerAgentInboxSession('term-1', 'safe-id; Remove-Item secrets', {
                getTerminalSpec: vi.fn(() => ({
                    id: 'term-1',
                    meta: { agent: 'codex', agent_id: 'agent-1' },
                })),
                updateTerminalSpec,
                setChatSession,
            }),
        ).toEqual({ ok: false, error: 'The session id has an invalid format.' });
        expect(updateTerminalSpec).not.toHaveBeenCalled();
        expect(setChatSession).not.toHaveBeenCalled();
    });
});

/**
 * Codex's SessionStart hook matcher is `startup|resume|clear`
 * (`main/mcp/agent-config.ts:519`), so the hook RE-FIRES inside a live TUI --
 * a resume hands back the session id Genie already stored. Claude binds its
 * chat id once at launch (`--session-id`) and never re-registers, which is why
 * only Codex agents produced the repeated broadcasts of genie#229.
 *
 * A re-bind that changes nothing must therefore BE nothing: the caller
 * (`main/mcp/host-tools.ts`) broadcasts `terminal-spec:changed` on a truthy
 * result, and that event makes the master window re-fetch and replace its
 * entire spec list (`renderer/pages/master.tsx:1111`).
 */
describe('registerAgentInboxSession is idempotent', () => {
    const specWith = (chatSessionId: string | undefined) => ({
        id: 'term-1',
        meta: {
            agent: 'codex',
            agent_id: 'agent-1',
            ...(chatSessionId === undefined ? {} : { chat_session_id: chatSessionId }),
        },
    });

    it('POSITIVE CONTROL: a genuinely new binding still writes and reports a change', () => {
        // Without this, "did not write" below would pass just as happily against
        // a function that had stopped writing at all.
        const updateTerminalSpec = vi.fn();
        const setChatSession = vi.fn();
        const result = registerAgentInboxSession('term-1', 'session-a', {
            getTerminalSpec: vi.fn(() => specWith(undefined)),
            updateTerminalSpec,
            setChatSession,
        });
        expect(result).toEqual({ ok: true, agentId: 'agent-1', changed: true });
        expect(updateTerminalSpec).toHaveBeenCalledTimes(1);
        expect(setChatSession).toHaveBeenCalledTimes(1);
    });

    it('re-binding the session id already stored writes nothing and reports no change', () => {
        const updateTerminalSpec = vi.fn();
        const setChatSession = vi.fn();
        const result = registerAgentInboxSession('term-1', 'session-a', {
            getTerminalSpec: vi.fn(() => specWith('session-a')),
            updateTerminalSpec,
            setChatSession,
        });
        expect(result).toEqual({ ok: true, agentId: 'agent-1', changed: false });
        expect(updateTerminalSpec).not.toHaveBeenCalled();
        expect(setChatSession).not.toHaveBeenCalled();
    });

    it('treats surrounding whitespace as the same binding, not a new one', () => {
        // The hook pipes the id through stdin; a trailing newline is not news.
        const updateTerminalSpec = vi.fn();
        const result = registerAgentInboxSession('term-1', '  session-a  ', {
            getTerminalSpec: vi.fn(() => specWith('session-a')),
            updateTerminalSpec,
            setChatSession: vi.fn(),
        });
        expect(result).toEqual({ ok: true, agentId: 'agent-1', changed: false });
        expect(updateTerminalSpec).not.toHaveBeenCalled();
    });

    it('still rebinds when the harness really did mint a new session', () => {
        // `/clear` starts a new Codex conversation, so this re-fire carries a
        // DIFFERENT id -- something changed, and the renderer should hear it.
        const updateTerminalSpec = vi.fn();
        const setChatSession = vi.fn();
        const result = registerAgentInboxSession('term-1', 'session-b', {
            getTerminalSpec: vi.fn(() => specWith('session-a')),
            updateTerminalSpec,
            setChatSession,
        });
        expect(result).toEqual({ ok: true, agentId: 'agent-1', changed: true });
        expect(updateTerminalSpec).toHaveBeenCalledWith('term-1', {
            meta: { agent: 'codex', agent_id: 'agent-1', chat_session_id: 'session-b' },
        });
        expect(setChatSession).toHaveBeenCalledWith('agent-1', 'session-b');
    });
});
