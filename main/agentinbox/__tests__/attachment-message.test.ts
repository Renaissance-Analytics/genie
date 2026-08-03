import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import type { AgentInboxStore, StoredAttachment } from '../store';
import {
    canAccessMessageAttachment,
    type AgentInboxAttachment,
    type AgentInboxJoinInput,
    type AgentInboxMessage,
} from '../types';

/**
 * The attachment METADATA travelling with a message — send → store → receive —
 * and who is allowed to pull the bytes back out.
 *
 * The broker stays PURE (no fs, no db): the caller reads the sender's file and
 * stores the bytes, then hands the broker plain metadata. These pin that the
 * metadata survives every hop an agent actually observes, and that an attachment
 * is only reachable by someone the MESSAGE reached — an id is not a capability.
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
        scope: 'all',
        scopeWorkspaces: [],
        chatSessionId: null,
        ...over,
    };
}

const attachment = (over: Partial<AgentInboxAttachment> = {}): AgentInboxAttachment => ({
    id: 'att-1',
    filename: 'report.pdf',
    bytes: 1234,
    mime: 'application/pdf',
    sha256: 'a'.repeat(64),
    ...over,
});

/** A minimal in-memory store that records what the broker persisted. */
function makeStore(): AgentInboxStore & { rows: AgentInboxMessage[] } {
    const rows: AgentInboxMessage[] = [];
    const cursors = new Map<string, number>();
    return {
        rows,
        append(msg) {
            rows.push(msg);
        },
        maxSeq() {
            return rows.reduce((mx, m) => Math.max(mx, m.seq), 0);
        },
        loadRecent(limit) {
            return rows.slice(-limit);
        },
        getCursor(agentId) {
            return cursors.get(agentId) ?? 0;
        },
        setCursor(agentId, seq) {
            cursors.set(agentId, Math.max(cursors.get(agentId) ?? 0, seq));
        },
        undeliveredFor(agentId, channelKeys, cursor) {
            const keys = new Set(channelKeys);
            return rows.filter(
                (m) =>
                    m.seq > cursor &&
                    m.from !== agentId &&
                    ((m.kind === 'dm' && m.to === agentId) ||
                        (m.kind === 'channel' && !!m.channel && keys.has(m.channel))),
            );
        },
        sentDmReceipts() {
            return [];
        },
        clearChannel() {
            return 0;
        },
        deleteDmThread() {
            return 0;
        },
        getMessage(id) {
            return rows.find((m) => m.id === id) ?? null;
        },
        getAttachment(id) {
            for (const m of rows) {
                const a = m.attachments?.find((x) => x.id === id);
                if (a) return { ...a, messageId: m.id } as StoredAttachment;
            }
            return null;
        },
    };
}

describe('a message carries its attachments end to end', () => {
    it('a DM delivers the attachment metadata to the recipient', async () => {
        const b = new AgentInboxBroker();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B' }));

        const sent = b.send({
            fromAgentId: 'A',
            toAgentId: 'B',
            text: 'here you go',
            attachments: [attachment()],
        });
        expect(sent.ok).toBe(true);

        const { messages } = await b.receive('B');
        expect(messages).toHaveLength(1);
        expect(messages[0].attachments).toEqual([attachment()]);
    });

    it('a CHANNEL broadcast delivers them to every member', async () => {
        const b = new AgentInboxBroker();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B' }));

        const sent = b.send({
            fromAgentId: 'A',
            channelArg: 'general',
            text: 'shared',
            attachments: [attachment({ id: 'att-c' })],
        });
        expect(sent.ok).toBe(true);

        const { messages } = await b.receive('B');
        expect(messages[0].attachments?.[0].id).toBe('att-c');
    });

    it('persists them to the durable store and replays them on rehydrate', async () => {
        const store = makeStore();
        const first = new AgentInboxBroker();
        first.setStore(store);
        first.join(input({ agentId: 'A' }));
        first.join(input({ agentId: 'B' }));
        first.send({ fromAgentId: 'A', toAgentId: 'B', text: 'file', attachments: [attachment()] });

        expect(store.rows[0].attachments).toEqual([attachment()]);

        // A restart: identities rejoin, then the messages rehydrate.
        const next = new AgentInboxBroker();
        next.setStore(store);
        next.rehydrate([input({ agentId: 'B' })]);
        next.rehydrateMessages();

        const { messages } = await next.receive('B');
        expect(messages[0].attachments).toEqual([attachment()]);
        expect(next.history({ dmPair: ['A', 'B'] })[0].attachments).toEqual([attachment()]);
    });

    it('leaves a message with no attachments completely untouched', async () => {
        const b = new AgentInboxBroker();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B' }));
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'plain' });

        const { messages } = await b.receive('B');
        expect(messages[0]).not.toHaveProperty('attachments');
    });

    it('drops an EMPTY attachment list rather than stamping an empty array on the wire', async () => {
        const b = new AgentInboxBroker();
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B' }));
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'plain', attachments: [] });

        const { messages } = await b.receive('B');
        expect(messages[0]).not.toHaveProperty('attachments');
    });
});

describe('canAccessMessageAttachment', () => {
    const dm: Pick<AgentInboxMessage, 'kind' | 'from' | 'to' | 'channel'> = {
        kind: 'dm',
        from: 'A',
        to: 'B',
    };
    const channel: Pick<AgentInboxMessage, 'kind' | 'from' | 'to' | 'channel'> = {
        kind: 'channel',
        from: 'A',
        channel: 'w1:general',
    };

    it('lets the DM sender and the DM recipient through', () => {
        expect(canAccessMessageAttachment({ msg: dm, agentId: 'A', channelKeys: [] })).toBe(true);
        expect(canAccessMessageAttachment({ msg: dm, agentId: 'B', channelKeys: [] })).toBe(true);
    });

    it('REFUSES a third agent that merely knows the attachment id', () => {
        expect(canAccessMessageAttachment({ msg: dm, agentId: 'C', channelKeys: [] })).toBe(false);
    });

    it('lets a member of the channel through and refuses a non-member', () => {
        expect(
            canAccessMessageAttachment({ msg: channel, agentId: 'B', channelKeys: ['w1:general'] }),
        ).toBe(true);
        expect(
            canAccessMessageAttachment({ msg: channel, agentId: 'B', channelKeys: ['w1:other'] }),
        ).toBe(false);
    });

    it('lets the channel POSTER through even if it has since left the room', () => {
        expect(canAccessMessageAttachment({ msg: channel, agentId: 'A', channelKeys: [] })).toBe(
            true,
        );
    });

    it('lets the HUMAN panel through — it owns the workstation', () => {
        expect(canAccessMessageAttachment({ msg: dm, agentId: 'human', channelKeys: [] })).toBe(
            true,
        );
        expect(canAccessMessageAttachment({ msg: channel, agentId: 'human', channelKeys: [] })).toBe(
            true,
        );
    });
});

describe('broker.attachmentFor', () => {
    it('resolves an attachment only for an agent the message reached', () => {
        const store = makeStore();
        const b = new AgentInboxBroker();
        b.setStore(store);
        b.join(input({ agentId: 'A' }));
        b.join(input({ agentId: 'B' }));
        b.join(input({ agentId: 'C', workspaceId: 'w2', slug: 'ws-two', purpose: 'other' }));
        b.send({ fromAgentId: 'A', toAgentId: 'B', text: 'x', attachments: [attachment()] });

        expect(b.attachmentFor('B', 'att-1')?.filename).toBe('report.pdf');
        expect(b.attachmentFor('A', 'att-1')?.filename).toBe('report.pdf');
        expect(b.attachmentFor('C', 'att-1')).toBeNull();
        expect(b.attachmentFor('B', 'nope')).toBeNull();
    });
});
