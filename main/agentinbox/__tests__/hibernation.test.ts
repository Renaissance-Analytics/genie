import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import { noopAgentInboxStore, type AgentInboxStore } from '../store';
import type { AgentInboxJoinInput } from '../types';

/**
 * A HIBERNATING workspace's agents are asleep (genie#672).
 *
 * The owner: "agents in hibernation do not even list in the agent inbox, they are
 * asleep. Only active agents are in the inbox. On hibernation, delete all agent
 * dms for agents in the hibernating workspace."
 */

const agent = (id: string, workspaceId: string): AgentInboxJoinInput => ({
    agentId: id,
    terminalId: `t-${id}`,
    workspaceId,
    workspaceName: workspaceId,
    slug: workspaceId,
    agentType: 'claude',
    label: id,
    purpose: id.toLowerCase(),
    scope: 'all',
    scopeWorkspaces: [],
    chatSessionId: null,
});

function world(asleep: Set<string>, store: AgentInboxStore = noopAgentInboxStore) {
    const b = new AgentInboxBroker();
    b.setStore(store);
    b.setHibernationResolver((workspaceId) => asleep.has(workspaceId));
    b.join(agent('A', 'w-asleep'));
    b.join(agent('B', 'w-asleep'));
    b.join(agent('C', 'w-awake'));
    b.join(agent('D', 'w-awake'));
    return b;
}

describe('hibernated agents do not list', () => {
    it('are not discoverable — from another workspace, or from their own', () => {
        const b = world(new Set(['w-asleep']));
        expect(b.discoverableFor('C').map((a) => a.agentId)).toEqual(['D']);
        // Control: awake, the same agents are listed.
        const awake = world(new Set());
        expect(awake.discoverableFor('C').map((a) => a.agentId).sort()).toEqual(['A', 'B', 'D']);
    });

    it('are not in the human directory', () => {
        const b = world(new Set(['w-asleep']));
        expect(b.directory().map((a) => a.agentId).sort()).toEqual(['C', 'D']);
    });
});

describe('hibernated agents cannot be messaged', () => {
    it('refuses a DM from a peer, and from the human, naming why', () => {
        const b = world(new Set(['w-asleep']));
        const fromPeer = b.send({ fromAgentId: 'C', toAgentId: 'A', text: 'hello' });
        expect(fromPeer.ok).toBe(false);
        if (!fromPeer.ok) expect(fromPeer.error).toMatch(/hibernat/i);
        const fromHuman = b.send({ human: true, toAgentId: 'A', text: 'hello' });
        expect(fromHuman.ok).toBe(false);
        // Nothing was stored for a later delivery.
        expect(b.history({ dmPair: ['C', 'A'] })).toEqual([]);
    });

    it('POSITIVE CONTROL: the same DM goes through when the workspace is awake', () => {
        const b = world(new Set());
        expect(b.send({ fromAgentId: 'C', toAgentId: 'A', text: 'hello' }).ok).toBe(true);
    });
});

describe('hibernating deletes the workspace’s agent DMs', () => {
    it('removes every thread one of its agents is in — and no other — including the persisted copy', () => {
        const deleted: string[] = [];
        const store: AgentInboxStore = {
            ...noopAgentInboxStore,
            deleteDmsFor(agentId) {
                deleted.push(agentId);
                return 2;
            },
        };
        const asleep = new Set<string>();
        const b = world(asleep, store);
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'a→b' });
        b.send({ fromAgentId: 'C', toAgentId: 'A', text: 'c→a' });
        b.send({ human: true, toAgentId: 'B', text: 'you→b' });
        b.send({ fromAgentId: 'C', toAgentId: 'D', text: 'c→d' });

        asleep.add('w-asleep');
        const cleared = b.purgeAgents(['A', 'B']);

        expect(cleared).toBeGreaterThanOrEqual(3);
        expect(b.history({ dmPair: ['A', 'B'] })).toEqual([]);
        expect(b.history({ dmPair: ['C', 'A'] })).toEqual([]);
        expect(b.history({ agentId: 'B' })).toEqual([]);
        // Control: a thread between two awake agents is untouched.
        expect(b.history({ dmPair: ['C', 'D'] }).map((m) => m.text)).toEqual(['c→d']);
        expect(deleted.sort()).toEqual(['A', 'B']);
    });
});
