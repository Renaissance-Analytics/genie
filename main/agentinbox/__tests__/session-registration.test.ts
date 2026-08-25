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

        expect(result).toEqual({ ok: true, agentId: 'agent-1' });
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
