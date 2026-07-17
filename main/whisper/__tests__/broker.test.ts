import { describe, expect, it, vi } from 'vitest';
import { WhisperBroker, INBOX_CAP } from '../broker';
import type { WhisperBrokerEvent, WhisperJoinInput } from '../types';

/** Build a join input with sane defaults. */
function input(over: Partial<WhisperJoinInput> & { agentId: string }): WhisperJoinInput {
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

function fresh(): WhisperBroker {
    return new WhisperBroker();
}

describe('WhisperBroker — discovery scopes', () => {
    it('applies the four scopes (none invisible, self same-ws, specific list, all)', () => {
        const b = fresh();
        // Caller A in w1.
        b.join(input({ agentId: 'A', workspaceId: 'w1' }));
        // Same workspace, self → visible.
        b.join(input({ agentId: 'B', workspaceId: 'w1', scope: 'self' }));
        // Other workspace, self → hidden.
        b.join(input({ agentId: 'C', workspaceId: 'w2', slug: 'ws-two', scope: 'self' }));
        // Other workspace, all → visible.
        b.join(input({ agentId: 'D', workspaceId: 'w2', slug: 'ws-two', scope: 'all' }));
        // Other workspace, none → hidden even though it can lurk.
        b.join(input({ agentId: 'E', workspaceId: 'w2', slug: 'ws-two', scope: 'none' }));
        // Other workspace, specific [w1] → visible to A.
        b.join(
            input({ agentId: 'F', workspaceId: 'w2', slug: 'ws-two', scope: 'specific', scopeWorkspaces: ['w1'] }),
        );

        const ids = b.discoverableFor('A').map((a) => a.agentId).sort();
        expect(ids).toEqual(['B', 'D', 'F']);
        // Never includes itself in the peer list.
        expect(ids).not.toContain('A');
    });

    it('the human directory sees every agent regardless of scope', () => {
        const b = fresh();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'E', scope: 'none' }));
        expect(b.directory().map((a) => a.agentId).sort()).toEqual(['A', 'E']);
    });
});

describe('WhisperBroker — direct messages', () => {
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

describe('WhisperBroker — channels', () => {
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

    it('a `none`-scope agent can still lurk + broadcast on a channel', async () => {
        const b = fresh();
        b.join(input({ agentId: 'A', workspaceId: 'w1', purpose: 'general' }));
        b.join(input({ agentId: 'L', workspaceId: 'w1', purpose: 'general', scope: 'none' }));
        // Undiscoverable...
        expect(b.discoverableFor('A').map((a) => a.agentId)).not.toContain('L');
        // ...but its broadcast still reaches the room.
        b.send({ fromAgentId: 'L', channelArg: 'general', text: 'lurker speaks' });
        expect((await b.receive('A', { cursor: 0 })).messages.map((m) => m.text)).toEqual(['lurker speaks']);
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
        // it here so WhisperChat (which prefers `label`) reflects it, not the stale one.
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

describe('WhisperBroker — cursor + inbox', () => {
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

describe('WhisperBroker — long-poll waiter', () => {
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

describe('WhisperBroker — presence + message events', () => {
    it('emits presence on join, offline on leave, and message on send', () => {
        const b = fresh();
        const events: WhisperBrokerEvent[] = [];
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
        const events: WhisperBrokerEvent[] = [];
        b.setEmitter((ev) => events.push(ev));
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B', terminalId: 't-B' }));
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'urgent', interrupt: true });
        const it = events.find((e) => e.type === 'interrupt');
        expect(it && it.type === 'interrupt' && it.terminalId).toBe('t-B');
    });
});

describe('WhisperBroker — history', () => {
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

describe('WhisperBroker — dmThreads (human panel)', () => {
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
