import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import type { AgentInboxJoinInput } from '../types';

const agent = (id: string): AgentInboxJoinInput => ({
    agentId: id,
    terminalId: `t-${id}`,
    workspaceId: 'w1',
    workspaceName: 'One',
    slug: 'one',
    agentType: 'claude',
    label: id,
    purpose: id.toLowerCase(),
    scope: 'all',
    scopeWorkspaces: [],
    chatSessionId: null,
});

describe('DM-only history deletion', () => {
    it('deletes one direct thread without disturbing another', () => {
        const broker = new AgentInboxBroker();
        broker.join(agent('A'));
        broker.join(agent('B'));
        broker.join(agent('C'));
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'ab' });
        broker.send({ fromAgentId: 'A', toAgentId: 'C', text: 'ac' });

        expect(broker.deleteThread('A|B')).toEqual({ ok: true, cleared: 1 });
        expect(broker.history({ dmPair: ['A', 'B'] })).toEqual([]);
        expect(broker.history({ dmPair: ['A', 'C'] }).map((m) => m.text)).toEqual(['ac']);
    });

    it('wipes several direct threads in one call', () => {
        const broker = new AgentInboxBroker();
        broker.join(agent('A'));
        broker.join(agent('B'));
        broker.join(agent('C'));
        broker.send({ fromAgentId: 'A', toAgentId: 'B', text: 'ab' });
        broker.send({ fromAgentId: 'A', toAgentId: 'C', text: 'ac' });

        expect(broker.wipeMany({ pairKeys: ['A|B', 'A|C'] })).toEqual({
            ok: true,
            cleared: 2,
            channels: 0,
            threads: 2,
        });
        expect(broker.dmThreads()).toEqual([]);
    });
});
