import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';

/**
 * A REHYDRATED agent must be able to see ITSELF.
 *
 * The regression (shipped beta.277-284): `agentinbox list` returned
 * `{ ok: true, agents: [] }` with NO `self` block, on a workstation that had
 * shown 8 reachable peers a day earlier. Every one of the 49 rows in
 * `workspace_agents` had `ready_at = NULL`.
 *
 * `self` is the load-bearing assertion. Peers can legitimately be empty — you
 * may be the only agent running — but an agent that cannot see its own identity
 * is not registered at all, and nothing it does through AgentInbox can work.
 */
describe('a rehydrated agent sees itself', () => {
    const input = {
        agentId: 'inbox-uuid-1',
        terminalId: 'term-1',
        workspaceId: 'ws-1',
        workspaceName: 'Demo',
        slug: 'demo',
        agentType: 'claude' as const,
        label: 'claude · demo',
        purpose: 'demo',
        scope: 'all' as const,
        scopeWorkspaces: [],
        chatSessionId: null,
    };

    it('getInfo finds an agent restored by rehydrate', () => {
        const broker = new AgentInboxBroker();
        broker.rehydrate([input]);

        expect(broker.getInfo('inbox-uuid-1')).toBeTruthy();
    });

    it('does NOT require a harness transport before the agent exists', () => {
        // The transport gate decides DELIVERY. An agent that has not completed a
        // Channel / App Server handshake is still a registered agent — gating its
        // existence makes it invisible to itself with no way to recover, because
        // the recovery tool is the gated one.
        const broker = new AgentInboxBroker();
        broker.rehydrate([input]);

        const self = broker.getInfo('inbox-uuid-1');
        expect(self?.agentId).toBe('inbox-uuid-1');
    });

    it('lists a peer that was also rehydrated', () => {
        const broker = new AgentInboxBroker();
        broker.rehydrate([input, { ...input, agentId: 'inbox-uuid-2', terminalId: 'term-2' }]);

        expect(broker.discoverableFor('inbox-uuid-1').map((a) => a.agentId)).toContain(
            'inbox-uuid-2',
        );
    });
});

/**
 * SELF-HEAL — the property that was missing, and the reason 49 agents went dark
 * with no way back.
 *
 * `agentInboxForMcp` resolves the caller's identity from `spec.meta.agent_id`. If
 * that id is present it calls `markOnline(agentId)` — which is a NO-OP when the
 * broker does not know the agent:
 *
 *     markOnline(id) { const a = this.agents.get(id); if (!a || ...) return; }
 *
 * So an agent whose broker entry is missing (boot rehydrate skipped, failed, or
 * ran before its spec existed) can never come back. Every AgentInbox call it
 * makes is a no-op, `list` returns no `self`, and the tool it would use to report
 * the problem is the broken one.
 *
 * The lazy-create path already exists for an agent with NO id. This extends the
 * same forgiveness to an agent whose id the broker has lost — the identity is
 * durable in the spec, so re-joining restores it exactly rather than minting a
 * second one.
 */
describe('an agent whose broker entry is missing can rejoin', () => {
    const input = {
        agentId: 'inbox-uuid-1',
        terminalId: 'term-1',
        workspaceId: 'ws-1',
        workspaceName: 'Demo',
        slug: 'demo',
        agentType: 'claude' as const,
        label: 'claude · demo',
        purpose: 'demo',
        scope: 'all' as const,
        scopeWorkspaces: [],
        chatSessionId: null,
    };

    it('markOnline alone does NOT restore an unknown agent', () => {
        // The bug, pinned: this is what the caller was relying on.
        const broker = new AgentInboxBroker();
        broker.markOnline('inbox-uuid-1');

        expect(broker.getInfo('inbox-uuid-1')).toBeFalsy();
    });

    it('join restores it under the SAME durable id', () => {
        const broker = new AgentInboxBroker();
        broker.join(input);

        expect(broker.getInfo('inbox-uuid-1')?.agentId).toBe('inbox-uuid-1');
    });

    it('re-joining an agent the broker already has does not duplicate it', () => {
        // The heal must be safe to run on every call — join is documented as
        // idempotent per agentId, and this is what lets the caller do it blindly.
        const broker = new AgentInboxBroker();
        broker.join(input);
        broker.join(input);

        expect(broker.directory().filter((a) => a.agentId === 'inbox-uuid-1')).toHaveLength(1);
    });
});
