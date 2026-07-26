import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import type { AgentInboxStore } from '../store';
import type { AgentInboxJoinInput, AgentInboxMessage } from '../types';

/**
 * genie #65 — CHANNEL MEMBERSHIP IS DURABLE STATE, and a channel send that
 * reaches nobody is a FAILURE, not a quiet success.
 *
 * The bug: an agent joined `<ws>:general`, delivered to it, and later found
 * itself silently out of the room with no `leave` call — its next send returned
 * `ok:true, delivered:0` and the report evaporated. Root cause: the broker's
 * `channelMembers` map was pure runtime state. The ONLY channel restored on a
 * (re)join was the agent's own `<workspaceId>:<purpose>` room, derived from spec
 * meta — so every explicitly-joined channel died with the map on:
 *   - a host restart (`rehydrateAgentInbox` re-registers every agent from
 *     `terminal_specs.meta`, which recorded no channels), and
 *   - a hard leave + re-register (`killTerminalById` → `leaveByTerminal` drops
 *     the agent from EVERY channel; `restartAgentTerminal` then relaunches it
 *     with a fresh identity carrying purpose/scope but no channels).
 *
 * These tests model the real host wiring: a {@link SpecStore} standing in for
 * `terminal_specs.meta`, which is the only place a membership can survive.
 */

function input(over: Partial<AgentInboxJoinInput> & { agentId: string }): AgentInboxJoinInput {
    return {
        terminalId: `t-${over.agentId}`,
        workspaceId: 'w1',
        workspaceName: 'Workspace One',
        slug: 'ws-one',
        agentType: 'claude',
        label: `Agent ${over.agentId}`,
        purpose: 'general',
        scope: 'self',
        scopeWorkspaces: [],
        chatSessionId: null,
        ...over,
    };
}

function fresh(): AgentInboxBroker {
    return new AgentInboxBroker();
}

/**
 * Stands in for the `terminal_specs` rows whose `meta` holds an agent's durable
 * AgentInbox identity. The host rebuilds every join input from these at boot
 * (`rehydrateAgentInbox`) and when restarting an agent terminal — so anything
 * NOT written here cannot survive.
 */
class SpecStore {
    private rows = new Map<string, AgentInboxJoinInput>();

    register(i: AgentInboxJoinInput): AgentInboxJoinInput {
        this.rows.set(i.agentId, { ...i });
        return i;
    }

    /** What the host writes back to `meta.whisper_channels` after a membership change. */
    noteChannels(agentId: string, keys: string[]): void {
        const row = this.rows.get(agentId);
        if (row) row.channels = [...keys];
    }

    channelsFor(agentId: string): string[] {
        return this.rows.get(agentId)?.channels ?? [];
    }

    /** The join inputs the host rebuilds at boot — `away`, like `rehydrateAgentInbox`. */
    bootInputs(): AgentInboxJoinInput[] {
        return [...this.rows.values()].map((r) => ({ ...r, status: 'away' as const }));
    }
}

/** Persist an agent's membership exactly as the host does after join/leave/send. */
function persist(b: AgentInboxBroker, specs: SpecStore, agentId: string): void {
    specs.noteChannels(agentId, b.persistableChannelKeys(agentId));
}

describe('genie #65 — channel membership survives re-registration', () => {
    it('an agent stays in a joined channel across a HOST RESTART', () => {
        // Two agents in one workspace, each with its own purpose room, meeting in
        // a shared `general` channel — the exact shape from the bug report.
        const specs = new SpecStore();
        const a = specs.register(input({ agentId: 'A', purpose: 'frontend' }));
        const bb = specs.register(input({ agentId: 'B', purpose: 'backend' }));

        const b1 = fresh();
        b1.join(a);
        b1.join(bb);
        expect(b1.joinChannel('A', 'general')).toBe(true);
        expect(b1.joinChannel('B', 'general')).toBe(true);
        persist(b1, specs, 'A');
        persist(b1, specs, 'B');
        // Baseline: the room works.
        expect(b1.send({ fromAgentId: 'A', channelArg: 'general', text: 'report' })).toMatchObject({
            ok: true,
            delivered: 1,
        });

        // The host restarts and re-registers every agent from its persisted specs.
        const b2 = fresh();
        b2.rehydrate(specs.bootInputs());

        // Before the fix BOTH agents came back holding only their own purpose room,
        // so each was alone in `general` and its reports evaporated.
        expect(b2.channelsForAgent('A').map((c) => c.key)).toContain('w1:general');
        expect(b2.channelsForAgent('B').map((c) => c.key)).toContain('w1:general');
        expect(b2.send({ fromAgentId: 'A', channelArg: 'general', text: 'report' })).toMatchObject({
            ok: true,
            delivered: 1,
        });
    });

    it('an agent stays in a joined channel across an AGENT-TERMINAL RESTART', () => {
        // `restartAgentTerminal` kills the terminal (a hard leave that drops the
        // agent from every channel) and relaunches it as a NEW terminal + identity
        // carrying the persisted spec meta forward.
        const specs = new SpecStore();
        const b = fresh();
        b.join(specs.register(input({ agentId: 'A', purpose: 'frontend' })));
        b.join(specs.register(input({ agentId: 'B', purpose: 'backend' })));
        b.joinChannel('A', 'general');
        b.joinChannel('B', 'general');
        persist(b, specs, 'A');

        // Teardown: pty + MCP endpoint + AgentInbox presence released.
        b.leaveByTerminal('t-A');
        expect(b.channelsForAgent('A')).toEqual([]);

        // Relaunch — fresh terminal + fresh agent id, same durable meta.
        b.join({
            ...specs.bootInputs().find((i) => i.agentId === 'A')!,
            agentId: 'A2',
            terminalId: 't-A2',
            status: 'online',
        });

        expect(b.channelsForAgent('A2').map((c) => c.key)).toContain('w1:general');
        expect(b.send({ fromAgentId: 'A2', channelArg: 'general', text: 'resumed' })).toMatchObject({
            ok: true,
            delivered: 1,
        });
    });

    it('a channel auto-joined by SENDING is persisted too', () => {
        // `send` auto-joins the room it posts to; that membership is as real as an
        // explicit `join` and must survive the same way.
        const specs = new SpecStore();
        const b = fresh();
        b.join(specs.register(input({ agentId: 'A', purpose: 'frontend' })));
        b.join(specs.register(input({ agentId: 'B', purpose: 'general' })));

        b.send({ fromAgentId: 'A', channelArg: 'general', text: 'first post' });
        persist(b, specs, 'A');

        expect(specs.channelsFor('A')).toEqual(['w1:general']);
    });

    it('does NOT restore a foreign channel whose workspace has since shut its door', () => {
        // Membership is durable, not privileged: the OUTER tier is re-checked on
        // restore, so revoking a workspace's access actually evicts.
        const specs = new SpecStore();
        const open = fresh();
        open.setWorkspaceAccessResolver(() => ({ access: 'all', workspaces: [] }));
        open.join(specs.register(input({ agentId: 'A', workspaceId: 'w1' })));
        open.join(
            specs.register(
                input({ agentId: 'V', workspaceId: 'w2', slug: 'ws-two', purpose: 'general' }),
            ),
        );
        expect(open.joinChannel('A', 'ws-two:general')).toBe(true);
        persist(open, specs, 'A');
        expect(specs.channelsFor('A')).toEqual(['w2:general']);

        // Restart — but w2 now admits nobody.
        const shut = fresh();
        shut.setWorkspaceAccessResolver((id) =>
            id === 'w2' ? { access: 'self', workspaces: [] } : { access: 'all', workspaces: [] },
        );
        shut.rehydrate(specs.bootInputs());
        expect(shut.channelsForAgent('A').map((c) => c.key)).not.toContain('w2:general');
    });

    it('replays the channel backlog missed while the host was down', async () => {
        // `rehydrateMessages` asks the store for undelivered messages using the
        // channels the agent is CURRENTLY in — so an agent restored without its
        // rooms also lost the mail that arrived in them while the host was down.
        const rows: AgentInboxMessage[] = [];
        const store: AgentInboxStore = {
            append: (m) => void rows.push(m),
            maxSeq: () => rows.reduce((mx, m) => Math.max(mx, m.seq), 0),
            loadRecent: (limit) => rows.slice(-limit),
            getCursor: () => 0,
            setCursor: () => {},
            undeliveredFor: (agentId, channelKeys, cursor) => {
                const keys = new Set(channelKeys);
                return rows.filter(
                    (m) =>
                        m.seq > cursor &&
                        m.from !== agentId &&
                        m.kind === 'channel' &&
                        !!m.channel &&
                        keys.has(m.channel),
                );
            },
            sentDmReceipts: () => [],
            clearChannel: () => 0,
            deleteDmThread: () => 0,
        };

        const specs = new SpecStore();
        const b1 = fresh();
        b1.setStore(store);
        b1.join(specs.register(input({ agentId: 'A', purpose: 'frontend' })));
        b1.join(specs.register(input({ agentId: 'B', purpose: 'backend' })));
        b1.joinChannel('A', 'general');
        b1.joinChannel('B', 'general');
        persist(b1, specs, 'A');
        persist(b1, specs, 'B');
        b1.send({ fromAgentId: 'B', channelArg: 'general', text: 'while you were out' });

        const b2 = fresh();
        b2.setStore(store);
        b2.rehydrate(specs.bootInputs());
        b2.rehydrateMessages();

        expect((await b2.receive('A', { cursor: 0 })).messages.map((m) => m.text)).toEqual([
            'while you were out',
        ]);
    });

    it('persists only EXPLICIT channels — the purpose room is always re-derived', () => {
        // The own-purpose room is rebuilt from `whisper_purpose` on every join, so
        // persisting it would resurrect a stale room after a purpose rename.
        const b = fresh();
        b.join(input({ agentId: 'A', purpose: 'frontend' }));
        expect(b.persistableChannelKeys('A')).toEqual([]);

        b.joinChannel('A', 'general');
        expect(b.persistableChannelKeys('A')).toEqual(['w1:general']);

        // A purpose rename re-keys the own room; the explicit list is unchanged and
        // never mentions either purpose room.
        b.setAccessibility('A', { purpose: 'backend' });
        expect(b.persistableChannelKeys('A')).toEqual(['w1:general']);

        // Leaving drops it from the persisted set.
        b.leaveChannel('A', 'general');
        expect(b.persistableChannelKeys('A')).toEqual([]);
    });
});

describe('genie #65 — a channel send that reaches nobody FAILS LOUDLY', () => {
    it('an agent send with 0 recipients is not a success', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', purpose: 'general' }));

        const r = b.send({ fromAgentId: 'A', channelArg: 'general', text: 'my build report' });

        // Used to be `{ ok: true, delivered: 0 }` — indistinguishable from a
        // delivered report, which is how the report was lost.
        expect(r.ok).toBe(false);
        expect(r).toMatchObject({ delivered: 0, channel: 'w1:general' });
        if (!r.ok) expect(r.error).toContain('w1:general');
    });

    it('records the message anyway so the human panel keeps the text', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', purpose: 'general' }));
        b.send({ fromAgentId: 'A', channelArg: 'general', text: 'my build report' });
        // Nobody RECEIVED it, but it is not destroyed — the human can still read it.
        expect(b.history({ channelKey: 'w1:general' }).map((m) => m.text)).toEqual([
            'my build report',
        ]);
    });

    it('reports when the sender had to be auto-rejoined', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', purpose: 'frontend' }));
        b.join(input({ agentId: 'B', purpose: 'general' }));

        // A is not in `general` yet — send auto-joins it and says so, so an agent
        // whose membership lapsed learns that it did.
        const first = b.send({ fromAgentId: 'A', channelArg: 'general', text: 'hi' });
        expect(first).toMatchObject({ ok: true, delivered: 1, rejoined: true });

        // Already a member the second time round.
        const second = b.send({ fromAgentId: 'A', channelArg: 'general', text: 'again' });
        expect(second).toMatchObject({ ok: true, delivered: 1, rejoined: false });
    });

    it('still succeeds when it actually reaches someone', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', purpose: 'general' }));
        b.join(input({ agentId: 'B', purpose: 'general' }));
        expect(b.send({ fromAgentId: 'A', channelArg: 'general', text: 'hello' })).toMatchObject({
            ok: true,
            delivered: 1,
        });
    });

    it('leaves the HUMAN panel post alone — an empty room is not a human error', () => {
        // The panel posts for the human's own record; there is nothing to mislead
        // (they can see the message land), so it must not start erroring.
        const b = fresh();
        b.join(input({ agentId: 'A', purpose: 'general' }));
        expect(b.send({ human: true, channelArg: 'w1:general', text: 'anyone?' }).ok).toBe(true);
    });
});
