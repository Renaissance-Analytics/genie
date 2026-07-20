import { describe, expect, it, vi } from 'vitest';
import { AgentInboxBroker, INBOX_CAP } from '../broker';
import type { AgentInboxBrokerEvent, AgentInboxJoinInput } from '../types';

/** Build a join input with sane defaults. */
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

describe('AgentInboxBroker — workspace access (outer tier)', () => {
    /** A broker whose workspace front doors are set per workspace id. */
    function withAccess(
        policies: Record<string, { access: 'none' | 'self' | 'specific' | 'all'; workspaces?: string[] }>,
    ): AgentInboxBroker {
        const b = fresh();
        b.setWorkspaceAccessResolver((id) => ({
            access: policies[id]?.access ?? 'all',
            workspaces: policies[id]?.workspaces ?? [],
        }));
        return b;
    }

    it('defaults permissive when no resolver is wired (pre-feature behaviour)', () => {
        const b = fresh();
        expect(b.workspaceAllows('w1', 'w2')).toBe(true);
    });

    it('a closed workspace omits its agents from another workspace entirely', () => {
        // Even scope:'all' can't escape a shut front door — the outer tier wins,
        // and denial OMITS rather than listing-as-unavailable so a closed
        // workspace never advertises its roster.
        const b = withAccess({ w2: { access: 'self' } });
        b.join(input({ agentId: 'A', workspaceId: 'w1' }));
        b.join(input({ agentId: 'Z', workspaceId: 'w2', slug: 'ws-two', scope: 'all' }));
        expect(b.discoverableFor('A').map((a) => a.agentId)).not.toContain('Z');
        expect(b.send({ fromAgentId: 'A', toAgentId: 'Z', text: 'x' }).ok).toBe(false);
    });

    it('a workspace never locks out its own agents', () => {
        const b = withAccess({ w1: { access: 'none' } });
        b.join(input({ agentId: 'A', workspaceId: 'w1' }));
        b.join(input({ agentId: 'B', workspaceId: 'w1', scope: 'self' }));
        expect(b.discoverableFor('A').map((a) => a.agentId)).toContain('B');
        expect(b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'hi' }).ok).toBe(true);
    });

    it('`specific` admits only the listed workspaces', () => {
        const b = withAccess({ w2: { access: 'specific', workspaces: ['w1'] } });
        expect(b.workspaceAllows('w1', 'w2')).toBe(true);
        expect(b.workspaceAllows('w3', 'w2')).toBe(false);
    });

    it('both tiers must admit a DM — an open door does not override agent scope', () => {
        const b = withAccess({ w2: { access: 'all' } });
        b.join(input({ agentId: 'A', workspaceId: 'w1' }));
        // Workspace is open, but the agent itself only accepts its own workspace.
        b.join(input({ agentId: 'S', workspaceId: 'w2', slug: 'ws-two', scope: 'self' }));
        const entry = b.discoverableFor('A').find((a) => a.agentId === 'S');
        expect(entry?.reachable).toBe(false); // listed, but unavailable
        expect(b.send({ fromAgentId: 'A', toAgentId: 'S', text: 'x' }).ok).toBe(false);
    });

    it('blocks cross-workspace channel join and broadcast when the door is shut', () => {
        const b = withAccess({ w2: { access: 'none' } });
        b.join(input({ agentId: 'A', workspaceId: 'w1', purpose: 'general' }));
        b.join(input({ agentId: 'V', workspaceId: 'w2', slug: 'ws-two', purpose: 'general' }));
        // Previously ANY agent could join and broadcast into ANY workspace's room.
        expect(b.joinChannel('A', 'ws-two:general')).toBe(false);
        const sent = b.send({ fromAgentId: 'A', channelArg: 'ws-two:general', text: 'intrusion' });
        expect(sent.ok).toBe(false);
        // A refused sender must not have been auto-joined as a side effect.
        expect(b.channelsForAgent('A').map((c) => c.key)).not.toContain('w2:general');
    });

    it('allows cross-workspace channel join when the door is open', () => {
        const b = withAccess({ w2: { access: 'all' } });
        b.join(input({ agentId: 'A', workspaceId: 'w1', purpose: 'general' }));
        b.join(input({ agentId: 'V', workspaceId: 'w2', slug: 'ws-two', purpose: 'general' }));
        expect(b.joinChannel('A', 'ws-two:general')).toBe(true);
        expect(b.send({ fromAgentId: 'A', channelArg: 'ws-two:general', text: 'hello' }).ok).toBe(true);
    });
});

describe('AgentInboxBroker — discovery scopes', () => {
    it('lists un-DMable peers as unreachable, and omits only `hidden`', () => {
        const b = fresh();
        // Caller A in w1. (No workspace-access resolver wired → the OUTER tier is
        // permissive, so this exercises the per-agent scope tier in isolation.)
        b.join(input({ agentId: 'A', workspaceId: 'w1' }));
        // Same workspace, self → reachable.
        b.join(input({ agentId: 'B', workspaceId: 'w1', scope: 'self' }));
        // Other workspace, self → LISTED but unreachable.
        b.join(input({ agentId: 'C', workspaceId: 'w2', slug: 'ws-two', scope: 'self' }));
        // Other workspace, all → reachable.
        b.join(input({ agentId: 'D', workspaceId: 'w2', slug: 'ws-two', scope: 'all' }));
        // Other workspace, none → LISTED but unreachable (discoverable so a peer
        // can find it and ask for access; `none` closes the mailbox, not the door).
        b.join(input({ agentId: 'E', workspaceId: 'w2', slug: 'ws-two', scope: 'none' }));
        // Other workspace, specific [w1] → reachable by A.
        b.join(
            input({ agentId: 'F', workspaceId: 'w2', slug: 'ws-two', scope: 'specific', scopeWorkspaces: ['w1'] }),
        );
        // Other workspace, hidden → the true opt-out: omitted entirely.
        b.join(input({ agentId: 'G', workspaceId: 'w2', slug: 'ws-two', scope: 'hidden' }));

        const seen = b.discoverableFor('A');
        const ids = seen.map((a) => a.agentId).sort();
        // `hidden` is the ONLY scope that disappears; everything else is listed.
        expect(ids).toEqual(['B', 'C', 'D', 'E', 'F']);
        // Never includes itself in the peer list.
        expect(ids).not.toContain('A');

        const reachable = seen.filter((a) => a.reachable).map((a) => a.agentId).sort();
        expect(reachable).toEqual(['B', 'D', 'F']);
        const unavailable = seen.filter((a) => !a.reachable).map((a) => a.agentId).sort();
        expect(unavailable).toEqual(['C', 'E']);
    });

    it('redacts the `specific` allow-list from callers it excludes', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1' }));
        // Admits w9, so A (in w1) is excluded — and must not read the ACL.
        b.join(
            input({ agentId: 'S', workspaceId: 'w2', slug: 'ws-two', scope: 'specific', scopeWorkspaces: ['w9'] }),
        );
        const entry = b.discoverableFor('A').find((a) => a.agentId === 'S');
        expect(entry?.reachable).toBe(false);
        expect(entry?.scopeWorkspaces).toEqual([]);
        // The human panel still sees the real list — it owns the workstation.
        expect(b.directory().find((a) => a.agentId === 'S')?.scopeWorkspaces).toEqual(['w9']);
    });

    it('the human directory sees every agent regardless of scope', () => {
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'E', scope: 'none' }));
        expect(b.directory().map((a) => a.agentId).sort()).toEqual(['A', 'E']);
    });
});

describe('AgentInboxBroker — direct messages', () => {
    it('delivers a DM to a discoverable peer and rejects an invisible one', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1' }));
        b.join(input({ agentId: 'B', workspaceId: 'w1', scope: 'self' }));
        b.join(input({ agentId: 'C', workspaceId: 'w2', slug: 'ws-two', scope: 'self' }));

        const ok = b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'hi B' });
        expect(ok.ok).toBe(true);

        const denied = b.send({ fromAgentId: 'A', toAgentId: 'C', text: 'hi C' });
        expect(denied.ok).toBe(false);
    });

    it('a `none`-scope agent is un-DMable', () => {
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'E', scope: 'none' }));
        expect(b.send({ fromAgentId: 'A', toAgentId: 'E', text: 'x' }).ok).toBe(false);
    });

    it('already-queued messages still deliver after the target hides itself', async () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1' }));
        b.join(input({ agentId: 'B', workspaceId: 'w1', scope: 'self' }));
        // Delivered while visible.
        expect(b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'queued' }).ok).toBe(true);
        // B hides — a NEW DM is rejected, but the queued one is untouched.
        b.setAccessibility('B', { scope: 'none' });
        expect(b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'blocked' }).ok).toBe(false);
        const { messages } = await b.receive('B', { cursor: 0 });
        expect(messages.map((m) => m.text)).toEqual(['queued']);
    });

    it('the human can DM any agent, even a hidden one', () => {
        const b = fresh();
        b.join(input({ agentId: 'E', scope: 'none' }));
        const r = b.send({ human: true, toAgentId: 'E', text: 'from you' });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.message.from).toBe('human');
            expect(r.message.fromLabel).toBe('You');
        }
    });
});

describe('AgentInboxBroker — channels', () => {
    it('fans a broadcast out to members with no self-echo', async () => {
        const b = fresh();
        // A, B, C all in w1 with purpose general → all in the w1:general room.
        b.join(input({ agentId: 'A', workspaceId: 'w1', purpose: 'general' }));
        b.join(input({ agentId: 'B', workspaceId: 'w1', purpose: 'general' }));
        b.join(input({ agentId: 'C', workspaceId: 'w1', purpose: 'general' }));

        const r = b.send({ fromAgentId: 'A', channelArg: 'general', text: 'hello room' });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.delivered).toBe(2); // B + C, not A

        expect((await b.receive('B', { cursor: 0 })).messages.map((m) => m.text)).toEqual(['hello room']);
        expect((await b.receive('C', { cursor: 0 })).messages.map((m) => m.text)).toEqual(['hello room']);
        // The sender doesn't receive its own broadcast.
        expect((await b.receive('A', { cursor: 0 })).messages).toEqual([]);
    });

    it('lists a channel by its slug:purpose display with a member count', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1', slug: 'ws-one', purpose: 'frontend' }));
        b.join(input({ agentId: 'B', workspaceId: 'w1', slug: 'ws-one', purpose: 'frontend' }));
        const chans = b.channels();
        const fe = chans.find((c) => c.purpose === 'frontend')!;
        expect(fe.key).toBe('w1:frontend');
        expect(fe.slug).toBe('ws-one');
        expect(fe.memberCount).toBe(2);
    });

    it('a `none`-scope agent broadcasts on a channel, and is listed as unreachable', async () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1', purpose: 'general' }));
        b.join(input({ agentId: 'L', workspaceId: 'w1', purpose: 'general', scope: 'none' }));
        // Discoverable but un-DMable — so a peer receiving its broadcast can now
        // actually find the sender in the directory instead of it appearing from
        // an agent that exists nowhere.
        const entry = b.discoverableFor('A').find((a) => a.agentId === 'L');
        expect(entry?.reachable).toBe(false);
        // Its broadcast reaches the room (scope governs DMs, not channels).
        b.send({ fromAgentId: 'L', channelArg: 'general', text: 'lurker speaks' });
        expect((await b.receive('A', { cursor: 0 })).messages.map((m) => m.text)).toEqual(['lurker speaks']);
    });

    it('a `hidden`-scope agent is omitted from discovery entirely', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1' }));
        b.join(input({ agentId: 'H', workspaceId: 'w1', scope: 'hidden' }));
        expect(b.discoverableFor('A').map((a) => a.agentId)).not.toContain('H');
        expect(b.send({ fromAgentId: 'A', toAgentId: 'H', text: 'x' }).ok).toBe(false);
        // The human panel still sees it.
        expect(b.directory().map((a) => a.agentId)).toContain('H');
    });

    it('re-keys the channel when an agent changes purpose', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1', purpose: 'general' }));
        expect(b.channelsForAgent('A').map((c) => c.key)).toEqual(['w1:general']);
        b.setAccessibility('A', { purpose: 'backend' });
        expect(b.channelsForAgent('A').map((c) => c.key)).toEqual(['w1:backend']);
        // The old room is gone (no members left).
        expect(b.channels().map((c) => c.key)).toEqual(['w1:backend']);
    });

    it('updates the display label when the caller supplies a renamed one', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1', purpose: 'general', label: 'claude · general' }));
        // The host recomputes an auto-derived label on a purpose rename and passes
        // it here so AgentInbox (which prefers `label`) reflects it, not the stale one.
        const info = b.setAccessibility('A', { purpose: 'tynn', label: 'claude · tynn' });
        expect(info?.purpose).toBe('tynn');
        expect(info?.label).toBe('claude · tynn');
    });

    it('leaves the label untouched when none is supplied (scope-only edit)', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1', label: 'Custom Bot' }));
        const info = b.setAccessibility('A', { scope: 'none' });
        expect(info?.label).toBe('Custom Bot');
    });
});

describe('AgentInboxBroker — cursor + inbox', () => {
    it('pages by cursor monotonically', async () => {
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B' }));
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'm1' });
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'm2' });

        const first = await b.receive('B', { cursor: 0 });
        expect(first.messages.map((m) => m.text)).toEqual(['m1', 'm2']);
        // Nothing new at the returned cursor.
        expect((await b.receive('B', { cursor: first.cursor })).messages).toEqual([]);
        // A later send is picked up from that cursor.
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'm3' });
        const next = await b.receive('B', { cursor: first.cursor });
        expect(next.messages.map((m) => m.text)).toEqual(['m3']);
        expect(next.cursor).toBeGreaterThan(first.cursor);
    });

    it('caps the inbox, dropping the oldest', async () => {
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B' }));
        const total = INBOX_CAP + 10;
        for (let i = 0; i < total; i++) {
            b.send({ fromAgentId: 'A', toAgentId: 'B', text: `m${i}` });
        }
        const { messages } = await b.receive('B', { cursor: 0 });
        expect(messages.length).toBe(INBOX_CAP);
        // The oldest 10 were evicted; the newest survives.
        expect(messages[messages.length - 1].text).toBe(`m${total - 1}`);
        expect(messages[0].text).toBe(`m${total - INBOX_CAP}`);
    });
});

describe('AgentInboxBroker — long-poll waiter', () => {
    it('resolves a waiting receive when a message arrives', async () => {
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B' }));
        const pending = b.receive('B', { wait: true, timeoutMs: 5000 });
        // Not yet resolved — deliver after a tick.
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'awaited' });
        const { messages } = await pending;
        expect(messages.map((m) => m.text)).toEqual(['awaited']);
    });

    it('resolves a waiting receive (empty) when the agent leaves', async () => {
        const b = fresh();
        b.join(input({ agentId: 'B', terminalId: 't-B' }));
        const pending = b.receive('B', { wait: true, timeoutMs: 5000 });
        b.leaveByTerminal('t-B');
        const { messages } = await pending;
        expect(messages).toEqual([]);
    });

    it('resolves a waiting receive (empty) when the agent goes away', async () => {
        const b = fresh();
        b.join(input({ agentId: 'B', terminalId: 't-B' }));
        const pending = b.receive('B', { wait: true, timeoutMs: 5000 });
        b.away('t-B');
        const { messages } = await pending;
        expect(messages).toEqual([]);
    });

    it('resolves empty on timeout', async () => {
        const b = fresh();
        b.join(input({ agentId: 'B' }));
        const { messages } = await b.receive('B', { wait: true, timeoutMs: 5 });
        expect(messages).toEqual([]);
    });
});

describe('AgentInboxBroker — presence + message events', () => {
    it('emits presence on join, offline on leave, and message on send', () => {
        const b = fresh();
        const events: AgentInboxBrokerEvent[] = [];
        b.setEmitter((ev) => events.push(ev));
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B' }));
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'hey' });
        b.leave('B');

        expect(events.filter((e) => e.type === 'presence').length).toBeGreaterThanOrEqual(2);
        const msg = events.find((e) => e.type === 'message');
        expect(msg && msg.type === 'message' && msg.preview.preview).toBe('hey');
        expect(events.some((e) => e.type === 'offline' && e.agentId === 'B')).toBe(true);
    });

    it('emits an interrupt event for an interrupt DM (no pty write)', () => {
        const b = fresh();
        const events: AgentInboxBrokerEvent[] = [];
        b.setEmitter((ev) => events.push(ev));
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B', terminalId: 't-B' }));
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'urgent', interrupt: true });
        const it = events.find((e) => e.type === 'interrupt');
        expect(it && it.type === 'interrupt' && it.terminalId).toBe('t-B');
    });
});

describe('AgentInboxBroker — history', () => {
    it('returns the channel log and the human↔agent DM thread', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1', purpose: 'general' }));
        b.join(input({ agentId: 'B', workspaceId: 'w1', purpose: 'general' }));
        b.send({ fromAgentId: 'A', channelArg: 'general', text: 'ch1' });
        b.send({ human: true, toAgentId: 'A', text: 'dm to A' });

        expect(b.history({ channelKey: 'w1:general' }).map((m) => m.text)).toEqual(['ch1']);
        expect(b.history({ agentId: 'A' }).map((m) => m.text)).toEqual(['dm to A']);
    });

    it('retrieves an agent↔agent DM thread by dmPair (order-independent)', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1' }));
        b.join(input({ agentId: 'B', workspaceId: 'w1' }));
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'a→b' });
        b.send({ fromAgentId: 'B', toAgentId: 'A', text: 'b→a' });

        // The pair key is order-independent — either arg order finds the thread.
        expect(b.history({ dmPair: ['A', 'B'] }).map((m) => m.text)).toEqual(['a→b', 'b→a']);
        expect(b.history({ dmPair: ['B', 'A'] }).map((m) => m.text)).toEqual(['a→b', 'b→a']);
        // The human↔agent thread stays separate from the agent↔agent one.
        b.send({ human: true, toAgentId: 'A', text: 'human→a' });
        expect(b.history({ agentId: 'A' }).map((m) => m.text)).toEqual(['human→a']);
        expect(b.history({ dmPair: ['A', 'B'] }).map((m) => m.text)).toEqual(['a→b', 'b→a']);
    });
});

describe('AgentInboxBroker — dmThreads (human panel)', () => {
    it('lists every DM thread — human↔agent AND agent↔agent — newest-first', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1', label: 'Backend' }));
        b.join(input({ agentId: 'B', workspaceId: 'w1', label: 'Frontend' }));
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'first, agent to agent' });
        b.send({ human: true, toAgentId: 'A', text: 'then, human to A' });

        const threads = b.dmThreads();
        expect(threads.length).toBe(2);
        // Sorted newest-first: the human↔A thread is most recent.
        expect(threads[0].withHuman).toBe(true);
        expect(threads[0].lastPreview).toBe('then, human to A');
        // The agent↔agent thread is present with both agents' labels.
        const aa = threads.find((t) => !t.withHuman)!;
        expect([aa.aLabel, aa.bLabel].sort()).toEqual(['Backend', 'Frontend']);
        expect(aa.lastPreview).toBe('first, agent to agent');
        expect(aa.count).toBe(1);
    });

    it('resolves the human label as "You"', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', label: 'Backend' }));
        b.send({ human: true, toAgentId: 'A', text: 'hi A' });
        const t = b.dmThreads()[0];
        expect([t.aLabel, t.bLabel].sort()).toEqual(['Backend', 'You']);
    });

    it('recovers a departed agent\'s label from the message log', () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1', label: 'Backend' }));
        b.join(input({ agentId: 'B', workspaceId: 'w1', label: 'Frontend' }));
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'ping' });
        b.send({ fromAgentId: 'B', toAgentId: 'A', text: 'pong' });
        // A leaves — its label must still resolve from the log, not vanish.
        b.leave('A');
        const t = b.dmThreads().find((x) => !x.withHuman)!;
        expect([t.aLabel, t.bLabel].sort()).toEqual(['Backend', 'Frontend']);
        // The thread is still retrievable after the agent left.
        expect(b.history({ dmPair: ['A', 'B'] }).map((m) => m.text)).toEqual(['ping', 'pong']);
    });

    it('omits pairs with no messages', () => {
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B' }));
        // No DMs sent yet.
        expect(b.dmThreads()).toEqual([]);
    });
});
