import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import type { AgentInboxJoinInput } from '../types';

/**
 * genie #64 part 2 — the header AgentInbox badge is an AGENT-LAG signal.
 *
 * The two read/unread concepts have OPPOSITE audiences:
 *   - the header badge answers "are my AGENTS keeping up?" — messages agents
 *     have not received/ACKed. Normal chatter an agent promptly drains never
 *     raises it; an agent falling behind does, because that is actionable.
 *   - the in-panel unread answers "where has there been activity since I last
 *     looked?" — purely the VIEWER's own client-side state (see
 *     renderer/lib/agentinbox-view.ts).
 *
 * So the badge is derived from the broker's delivery/ACK state, NOT from
 * counting message pushes while the panel is closed (what it used to do).
 */

function join(b: AgentInboxBroker, id: string, extra: Partial<AgentInboxJoinInput> = {}): void {
    b.join({
        agentId: id,
        terminalId: `t-${id}`,
        workspaceId: 'ws1',
        workspaceName: 'WS One',
        slug: 'ws-one',
        agentType: 'claude',
        label: id,
        purpose: 'general',
        scope: 'all',
        scopeWorkspaces: [],
        chatSessionId: null,
        ...extra,
    });
}

describe('broker.agentLagCount', () => {
    it('is zero with no agents and with agents that have no mail', () => {
        const b = new AgentInboxBroker();
        expect(b.agentLagCount()).toBe(0);
        join(b, 'a');
        join(b, 'b');
        expect(b.agentLagCount()).toBe(0);
    });

    it('counts an undelivered DM and clears it once the agent receives', async () => {
        const b = new AgentInboxBroker();
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping' });
        expect(b.agentLagCount()).toBe(1);

        await b.receive('b', {});
        expect(b.agentLagCount()).toBe(0);
    });

    it('sums ACROSS agents — a channel broadcast lags every member that has not drained it', async () => {
        const b = new AgentInboxBroker();
        join(b, 'a');
        join(b, 'b');
        join(b, 'c');
        // One broadcast, two recipients behind (the sender is never its own recipient).
        b.send({ fromAgentId: 'a', channelArg: 'general', text: 'standup' });
        expect(b.agentLagCount()).toBe(2);

        await b.receive('b', {});
        expect(b.agentLagCount()).toBe(1);
        await b.receive('c', {});
        expect(b.agentLagCount()).toBe(0);
    });

    it('never counts a message against its own sender', () => {
        const b = new AgentInboxBroker();
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', channelArg: 'general', text: 'mine' });
        // Only b is behind; a sent it.
        expect(b.agentLagCount()).toBe(1);
    });

    it('drops an agent that hard-left (its terminal is gone — nothing to chase)', () => {
        const b = new AgentInboxBroker();
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping' });
        expect(b.agentLagCount()).toBe(1);

        b.leaveByTerminal('t-b');
        expect(b.agentLagCount()).toBe(0);
    });

    it('still counts an AWAY agent — a revivable agent sitting on unread mail IS the actionable case', () => {
        const b = new AgentInboxBroker();
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping' });
        b.away('t-b');
        expect(b.agentLagCount()).toBe(1);
    });
});

describe('broker lag push', () => {
    function collecting() {
        const counts: number[] = [];
        const b = new AgentInboxBroker();
        b.setEmitter((ev) => {
            if (ev.type === 'lag') counts.push(ev.count);
        });
        return { b, counts };
    }

    it('pushes the new count when a send puts an agent behind, and when a receive catches it up', async () => {
        const { b, counts } = collecting();
        join(b, 'a');
        join(b, 'b');

        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping' });
        expect(counts).toEqual([1]);

        await b.receive('b', {});
        expect(counts).toEqual([1, 0]);
    });

    it('does not re-push an unchanged count (the badge is a level, not a stream)', async () => {
        const { b, counts } = collecting();
        join(b, 'a');
        join(b, 'b');
        await b.receive('b', {}); // nothing waiting → no change, no push
        expect(counts).toEqual([]);

        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'one' });
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'two' });
        expect(counts).toEqual([1, 2]);

        // Draining both is a single transition back to 0.
        await b.receive('b', {});
        expect(counts).toEqual([1, 2, 0]);
    });

    it('pushes when an agent leaves with mail outstanding', () => {
        const { b, counts } = collecting();
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping' });
        expect(counts).toEqual([1]);
        b.leave('b');
        expect(counts).toEqual([1, 0]);
    });
});
