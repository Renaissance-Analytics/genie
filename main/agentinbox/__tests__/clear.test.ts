import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import { dbAgentInboxStore, noopAgentInboxStore, type AgentInboxStore } from '../store';
import { AGENTINBOX_HUMAN, type AgentInboxJoinInput, type AgentInboxMessage } from '../types';
import { initDatabase, getDb } from '../../db';

/**
 * genie #64 part 1 — DELETE a DM thread / CLEAR a channel.
 *
 * The human panel can wipe a conversation's history. That is a HOST op (the
 * durable log lives in genie.db `whisper_messages`), so it must wipe BOTH the
 * broker's in-memory panel logs AND the store rows — otherwise a restart
 * rehydrates what the human just deleted.
 *
 * Deliberately NOT touched: agent inboxes and `whisper_cursors`. Clearing the
 * human's VIEW of a conversation must not silently drop mail an agent has not
 * received yet, nor rewind an agent's ACK position.
 */

/** A tiny in-memory AgentInboxStore standing in for genie.db. */
function makeStore(): AgentInboxStore & { rows: AgentInboxMessage[]; cursors: Map<string, number> } {
    const rows: AgentInboxMessage[] = [];
    const cursors = new Map<string, number>();
    return {
        rows,
        cursors,
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
        clearChannel(channelKey) {
            const before = rows.length;
            for (let i = rows.length - 1; i >= 0; i--) {
                if (rows[i].kind === 'channel' && rows[i].channel === channelKey) rows.splice(i, 1);
            }
            return before - rows.length;
        },
        deleteDmThread(a, b) {
            const before = rows.length;
            for (let i = rows.length - 1; i >= 0; i--) {
                const m = rows[i];
                if (m.kind !== 'dm') continue;
                if ((m.from === a && m.to === b) || (m.from === b && m.to === a)) rows.splice(i, 1);
            }
            return before - rows.length;
        },
        getMessage(id) {
            return rows.find((m) => m.id === id) ?? null;
        },
        getAttachment(id) {
            for (const m of rows) {
                const a = m.attachments?.find((x) => x.id === id);
                if (a) return { ...a, messageId: m.id };
            }
            return null;
        },
    };
}

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

describe('broker.clearChannel', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
        store = makeStore();
    });

    it('wipes the in-memory channel log AND the durable rows, leaving other channels alone', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        join(b, 'a');
        join(b, 'b', { purpose: 'frontend' });
        b.send({ fromAgentId: 'a', channelArg: 'general', text: 'g1' });
        b.send({ fromAgentId: 'a', channelArg: 'general', text: 'g2' });
        b.send({ fromAgentId: 'b', channelArg: 'frontend', text: 'f1' });

        expect(b.history({ channelKey: 'ws1:general' })).toHaveLength(2);

        const res = b.clearChannel('ws1:general');
        expect(res).toEqual({ ok: true, cleared: 2 });

        // In-memory panel log gone…
        expect(b.history({ channelKey: 'ws1:general' })).toEqual([]);
        // …and the durable rows too, so a restart can't resurrect them.
        expect(store.rows.filter((m) => m.channel === 'ws1:general')).toEqual([]);
        // The OTHER channel is untouched.
        expect(b.history({ channelKey: 'ws1:frontend' }).map((m) => m.text)).toEqual(['f1']);
    });

    it('survives a restart — a cleared channel stays empty after rehydrate', () => {
        const b1 = new AgentInboxBroker();
        b1.setStore(store);
        join(b1, 'a');
        b1.send({ fromAgentId: 'a', channelArg: 'general', text: 'gone' });
        b1.clearChannel('ws1:general');

        const b2 = new AgentInboxBroker();
        b2.setStore(store);
        join(b2, 'a');
        b2.rehydrateMessages();
        expect(b2.history({ channelKey: 'ws1:general' })).toEqual([]);
    });

    it('emits a `cleared` event so open windows refresh', () => {
        const events: Array<{ type: string; scope?: string; key?: string }> = [];
        const b = new AgentInboxBroker();
        b.setStore(store);
        b.setEmitter((ev) => events.push(ev as never));
        join(b, 'a');
        b.send({ fromAgentId: 'a', channelArg: 'general', text: 'g1' });

        b.clearChannel('ws1:general');
        expect(events).toContainEqual({ type: 'cleared', scope: 'channel', key: 'ws1:general' });
    });

    it('leaves agent ACK cursors alone (clearing the human view never rewinds an agent)', async () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', channelArg: 'general', text: 'g1' });
        await b.receive('b', {});
        const acked = store.getCursor('b');
        expect(acked).toBeGreaterThan(0);

        b.clearChannel('ws1:general');
        expect(store.getCursor('b')).toBe(acked);
    });

    it('an unknown channel is a safe no-op', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        expect(b.clearChannel('ws1:nope')).toEqual({ ok: true, cleared: 0 });
        expect(b.clearChannel('')).toEqual({ ok: false, cleared: 0 });
    });

    it('works with the default no-op store (no durability wired)', () => {
        const b = new AgentInboxBroker();
        b.setStore(noopAgentInboxStore);
        join(b, 'a');
        b.send({ fromAgentId: 'a', channelArg: 'general', text: 'g1' });
        expect(b.clearChannel('ws1:general').ok).toBe(true);
        expect(b.history({ channelKey: 'ws1:general' })).toEqual([]);
    });
});

describe('broker.deleteThread', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
        store = makeStore();
    });

    it('deletes a human↔agent thread from the DM list AND the durable rows', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        join(b, 'a');
        join(b, 'b');
        b.send({ human: true, toAgentId: 'a', text: 'hey a' });
        b.send({ human: true, toAgentId: 'b', text: 'hey b' });

        expect(b.dmThreads()).toHaveLength(2);

        const res = b.deleteThread([AGENTINBOX_HUMAN, 'a'].sort().join('|'));
        expect(res).toEqual({ ok: true, cleared: 1 });

        // The thread is GONE from the list (not merely emptied).
        expect(b.dmThreads().map((t) => t.key)).toEqual([
            [AGENTINBOX_HUMAN, 'b'].sort().join('|'),
        ]);
        expect(b.history({ agentId: 'a' })).toEqual([]);
        expect(store.rows.filter((m) => m.to === 'a')).toEqual([]);
        // The other thread survives.
        expect(b.history({ agentId: 'b' }).map((m) => m.text)).toEqual(['hey b']);
    });

    it('deletes an agent↔agent thread by its pair key', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'peer note' });
        b.send({ fromAgentId: 'b', toAgentId: 'a', text: 'peer reply' });

        expect(b.deleteThread('a|b')).toEqual({ ok: true, cleared: 2 });
        expect(b.dmThreads()).toEqual([]);
        expect(b.history({ dmPair: ['a', 'b'] })).toEqual([]);
        expect(store.rows).toEqual([]);
    });

    it('survives a restart — a deleted thread stays deleted after rehydrate', () => {
        const b1 = new AgentInboxBroker();
        b1.setStore(store);
        join(b1, 'a');
        b1.send({ human: true, toAgentId: 'a', text: 'gone' });
        b1.deleteThread([AGENTINBOX_HUMAN, 'a'].sort().join('|'));

        const b2 = new AgentInboxBroker();
        b2.setStore(store);
        join(b2, 'a');
        b2.rehydrateMessages();
        expect(b2.dmThreads()).toEqual([]);
    });

    it('emits a `cleared` event so open windows refresh', () => {
        const events: Array<{ type: string; scope?: string; key?: string }> = [];
        const b = new AgentInboxBroker();
        b.setStore(store);
        b.setEmitter((ev) => events.push(ev as never));
        join(b, 'a');
        b.send({ human: true, toAgentId: 'a', text: 'x' });

        const key = [AGENTINBOX_HUMAN, 'a'].sort().join('|');
        b.deleteThread(key);
        expect(events).toContainEqual({ type: 'cleared', scope: 'dm', key });
    });

    it('rejects a malformed pair key and no-ops on an unknown one', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        expect(b.deleteThread('not-a-pair')).toEqual({ ok: false, cleared: 0 });
        expect(b.deleteThread('')).toEqual({ ok: false, cleared: 0 });
        expect(b.deleteThread('x|y')).toEqual({ ok: true, cleared: 0 });
    });
});

describe('dbAgentInboxStore delete/clear (real sqlite)', () => {
    let dir: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-agentinbox-clear-'));
        initDatabase(dir);
    });

    afterAll(() => {
        try {
            getDb().prepare("DELETE FROM whisper_messages WHERE id LIKE 'clr-%'").run();
        } catch {
            /* best-effort */
        }
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
    });

    const msg = (over: Partial<AgentInboxMessage> & { id: string; seq: number }): AgentInboxMessage =>
        ({
            kind: 'channel',
            from: 'a',
            fromLabel: 'a',
            text: 't',
            ts: 1,
            ...over,
        }) as AgentInboxMessage;

    it('clearChannel deletes only that channel_key', () => {
        dbAgentInboxStore.append(msg({ id: 'clr-1', seq: 9001, channel: 'ws:one' }));
        dbAgentInboxStore.append(msg({ id: 'clr-2', seq: 9002, channel: 'ws:one' }));
        dbAgentInboxStore.append(msg({ id: 'clr-3', seq: 9003, channel: 'ws:two' }));

        expect(dbAgentInboxStore.clearChannel('ws:one')).toBe(2);

        const left = getDb()
            .prepare<[], { id: string }>("SELECT id FROM whisper_messages WHERE id LIKE 'clr-%'")
            .all()
            .map((r) => r.id);
        expect(left).toEqual(['clr-3']);
    });

    it('deleteDmThread deletes BOTH directions of the pair only', () => {
        dbAgentInboxStore.append(
            msg({ id: 'clr-4', seq: 9004, kind: 'dm', from: 'human', to: 'a', channel: undefined }),
        );
        dbAgentInboxStore.append(
            msg({ id: 'clr-5', seq: 9005, kind: 'dm', from: 'a', to: 'human', channel: undefined }),
        );
        dbAgentInboxStore.append(
            msg({ id: 'clr-6', seq: 9006, kind: 'dm', from: 'human', to: 'b', channel: undefined }),
        );

        expect(dbAgentInboxStore.deleteDmThread('human', 'a')).toBe(2);

        const left = getDb()
            .prepare<[], { id: string }>(
                "SELECT id FROM whisper_messages WHERE id LIKE 'clr-%' AND kind = 'dm'",
            )
            .all()
            .map((r) => r.id);
        expect(left).toEqual(['clr-6']);
    });

    it('leaves whisper_cursors untouched', () => {
        dbAgentInboxStore.setCursor('clr-agent', 42);
        dbAgentInboxStore.append(msg({ id: 'clr-7', seq: 9007, channel: 'ws:three' }));
        dbAgentInboxStore.clearChannel('ws:three');
        expect(dbAgentInboxStore.getCursor('clr-agent')).toBe(42);
        getDb().prepare("DELETE FROM whisper_cursors WHERE agent_id = 'clr-agent'").run();
    });
});
