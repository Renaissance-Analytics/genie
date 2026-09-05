import { describe, expect, it, vi } from 'vitest';
import { AgentInboxBroker } from '../broker';
import type { AgentInboxJoinInput } from '../types';
import { inboxNoticeMode } from '../../agents/agent-mode';

/**
 * The broker words each notice for the agent it is going TO (genie#408).
 *
 * The wording itself is pinned in `agents/__tests__/agent-mode-nudges.test.ts`.
 * What is only checkable HERE is the wiring: that the broker asks per
 * recipient, that it hands the resolver the TERMINAL as well as the id, and
 * that an unwired broker still says something rather than nothing.
 *
 * The terminal matters because the AgentInbox id is minted per LAUNCH
 * (`spawnTerminal`), so it stops matching `workspace_agents.id` the first time
 * an agent is relaunched — and a resolver given only the id would then report
 * every Automated agent as Manual, silently. See `agents/agent-mode-source.ts`.
 */

function input(over: Partial<AgentInboxJoinInput> & { agentId: string }): AgentInboxJoinInput {
    return {
        terminalId: `t-${over.agentId}`,
        workspaceId: 'w1',
        workspaceName: 'Workspace One',
        slug: 'ws-one',
        agentType: 'claude',
        label: `Agent ${over.agentId}`,
        purpose: over.agentId,
        scope: 'self',
        scopeWorkspaces: [],
        chatSessionId: null,
        ...over,
    };
}

/** A broker with a pty sink and no harness transport, so a DM produces a
 *  NOTICE — the surface this test is about. */
function brokerWithNotices(): {
    broker: AgentInboxBroker;
    pty: ReturnType<typeof vi.fn>;
} {
    const broker = new AgentInboxBroker();
    const pty = vi.fn((_o: { terminalId: string; text: string }) => true);
    broker.setWakeSink(pty);
    return { broker, pty };
}

/** The notice text delivered to one terminal. */
const noticeFor = (pty: ReturnType<typeof vi.fn>, terminalId: string): string =>
    String(
        pty.mock.calls.find((c) => (c[0] as { terminalId: string }).terminalId === terminalId)?.[0]
            ?.text ?? '',
    );

describe('an AgentInbox notice is worded for its recipient', () => {
    it('resolves the mode PER AGENT, not once for the fleet', () => {
        // One workspace, one broker, two agents: a supervising Automated one and
        // a Manual one a person drives.
        const { broker, pty } = brokerWithNotices();
        broker.setAgentModeSource(({ agentId }) =>
            agentId === 'supervisor' ? 'automated' : 'manual',
        );
        broker.join(input({ agentId: 'sender' }));
        broker.join(input({ agentId: 'supervisor' }));
        broker.join(input({ agentId: 'hand' }));

        broker.send({ fromAgentId: 'sender', toAgentId: 'supervisor', text: 'x' });
        broker.send({ fromAgentId: 'sender', toAgentId: 'hand', text: 'x' });

        expect(noticeFor(pty, 't-supervisor')).toContain(inboxNoticeMode('automated'));
        expect(noticeFor(pty, 't-hand')).toContain(inboxNoticeMode('manual'));
    });

    it('hands the resolver the TERMINAL as well as the id', () => {
        // The load-bearing half. An id-only resolver looks correct and answers
        // Manual for every relaunched agent.
        const { broker, pty } = brokerWithNotices();
        const source = vi.fn().mockReturnValue('automated' as const);
        broker.setAgentModeSource(source);
        broker.join(input({ agentId: 'sender' }));
        broker.join(input({ agentId: 'moic', terminalId: 'term-42' }));

        broker.send({ fromAgentId: 'sender', toAgentId: 'moic', text: 'x' });

        expect(source).toHaveBeenCalledWith({ agentId: 'moic', terminalId: 'term-42' });
        expect(noticeFor(pty, 'term-42')).toContain(inboxNoticeMode('automated'));
    });

    it('falls back to Manual with no resolver wired, and still delivers', () => {
        // An unwired broker — every test, and any host that has not installed a
        // source — must not lose the notice, and must not promote the agent.
        const { broker, pty } = brokerWithNotices();
        broker.join(input({ agentId: 'sender' }));
        broker.join(input({ agentId: 'moic' }));

        broker.send({ fromAgentId: 'sender', toAgentId: 'moic', text: 'x' });

        const notice = noticeFor(pty, 't-moic');
        expect(notice).toContain(inboxNoticeMode('manual'));
        // The message itself is still announced — the mode changes wording, and
        // a mode that suppressed the notice would be a boundary.
        expect(notice).toContain('sender');
        expect(notice).toContain('agentinbox');
    });

    it('degrades to Manual when the resolver throws, rather than losing the notice', () => {
        const { broker, pty } = brokerWithNotices();
        broker.setAgentModeSource(() => {
            throw new Error('db closed');
        });
        broker.join(input({ agentId: 'sender' }));
        broker.join(input({ agentId: 'moic' }));

        broker.send({ fromAgentId: 'sender', toAgentId: 'moic', text: 'x' });

        expect(noticeFor(pty, 't-moic')).toContain(inboxNoticeMode('manual'));
    });
});
