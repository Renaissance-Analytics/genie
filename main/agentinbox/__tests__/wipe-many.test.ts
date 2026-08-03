import { beforeEach, describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import type { AgentInboxStore } from '../store';
import { AGENTINBOX_HUMAN, type AgentInboxJoinInput, type AgentInboxMessage } from '../types';

/**
 * genie #66 part 2 — MASS delete.
 *
 * The owner wipes many conversations at once, so the panel sends ONE host call
 * instead of N. `wipeMany` batches the existing `clearChannel` / `deleteThread`
 * ops rather than re-implementing them, so the durable semantics — and the
 * deliberate non-interference with agent inboxes and ACK cursors — are
 * identical to a single delete by construction.
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
        undeliveredFor() {
            return [];
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

const humanPair = (agentId: string) => [AGENTINBOX_HUMAN, agentId].sort().join('|');

describe('broker.wipeMany', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
        store = makeStore();
    });

    /** Two channels with traffic + two human DM threads. */
    function seeded(): AgentInboxBroker {
        const b = new AgentInboxBroker();
        b.setStore(store);
        join(b, 'a');
        join(b, 'b', { purpose: 'frontend' });
        join(b, 'c', { purpose: 'backend' });
        b.send({ fromAgentId: 'a', channelArg: 'general', text: 'g1' });
        b.send({ fromAgentId: 'b', channelArg: 'frontend', text: 'f1' });
        b.send({ fromAgentId: 'b', channelArg: 'frontend', text: 'f2' });
        b.send({ fromAgentId: 'c', channelArg: 'backend', text: 'k1' });
        b.send({ human: true, toAgentId: 'a', text: 'hey a' });
        b.send({ human: true, toAgentId: 'b', text: 'hey b' });
        return b;
    }

    it('clears several channels AND deletes several threads in one call, reporting totals', () => {
        const b = seeded();
        const res = b.wipeMany({
            channelKeys: ['ws1:general', 'ws1:frontend'],
            pairKeys: [humanPair('a')],
        });

        expect(res).toEqual({ ok: true, cleared: 4, channels: 2, threads: 1 });

        // Wiped.
        expect(b.history({ channelKey: 'ws1:general' })).toEqual([]);
        expect(b.history({ channelKey: 'ws1:frontend' })).toEqual([]);
        expect(b.history({ agentId: 'a' })).toEqual([]);
        // Untouched.
        expect(b.history({ channelKey: 'ws1:backend' }).map((m) => m.text)).toEqual(['k1']);
        expect(b.history({ agentId: 'b' }).map((m) => m.text)).toEqual(['hey b']);
    });

    it('wipes the DURABLE rows too, so a restart cannot resurrect the batch', () => {
        const b = seeded();
        b.wipeMany({ channelKeys: ['ws1:general'], pairKeys: [humanPair('a')] });

        const b2 = new AgentInboxBroker();
        b2.setStore(store);
        join(b2, 'a');
        b2.rehydrateMessages();
        expect(b2.history({ channelKey: 'ws1:general' })).toEqual([]);
        expect(b2.dmThreads().map((t) => t.key)).not.toContain(humanPair('a'));
    });

    it('emits ONE cleared event per target, so per-key cache invalidation stays exact', () => {
        const events: Array<{ type: string; scope?: string; key?: string }> = [];
        const b = seeded();
        b.setEmitter((ev) => events.push(ev as never));

        b.wipeMany({ channelKeys: ['ws1:general', 'ws1:frontend'], pairKeys: [humanPair('a')] });

        const cleared = events.filter((e) => e.type === 'cleared');
        expect(cleared).toEqual([
            { type: 'cleared', scope: 'channel', key: 'ws1:general' },
            { type: 'cleared', scope: 'channel', key: 'ws1:frontend' },
            { type: 'cleared', scope: 'dm', key: humanPair('a') },
        ]);
    });

    it('dedupes repeated keys — a key listed twice is wiped and counted once', () => {
        const events: Array<{ type: string }> = [];
        const b = seeded();
        b.setEmitter((ev) => events.push(ev as never));

        const res = b.wipeMany({
            channelKeys: ['ws1:general', 'ws1:general'],
            pairKeys: [humanPair('a'), humanPair('a')],
        });

        expect(res).toEqual({ ok: true, cleared: 2, channels: 1, threads: 1 });
        expect(events.filter((e) => e.type === 'cleared')).toHaveLength(2);
    });

    it('skips a malformed pair key WITHOUT aborting the rest of the batch', () => {
        const b = seeded();
        const res = b.wipeMany({
            channelKeys: ['ws1:general'],
            pairKeys: ['not-a-pair', humanPair('a')],
        });
        // The good targets still went; the malformed one counted for nothing.
        expect(res).toEqual({ ok: true, cleared: 2, channels: 1, threads: 1 });
        expect(b.history({ channelKey: 'ws1:general' })).toEqual([]);
        expect(b.history({ agentId: 'a' })).toEqual([]);
    });

    it('counts only targets that actually held history', () => {
        const b = seeded();
        // 'ws1:nope' exists in neither log nor store.
        const res = b.wipeMany({ channelKeys: ['ws1:nope'], pairKeys: [] });
        expect(res).toEqual({ ok: true, cleared: 0, channels: 0, threads: 0 });
    });

    it('an empty batch is a safe no-op', () => {
        const b = seeded();
        const events: Array<{ type: string }> = [];
        b.setEmitter((ev) => events.push(ev as never));
        expect(b.wipeMany({})).toEqual({ ok: true, cleared: 0, channels: 0, threads: 0 });
        expect(b.wipeMany({ channelKeys: [], pairKeys: [] })).toEqual({
            ok: true,
            cleared: 0,
            channels: 0,
            threads: 0,
        });
        expect(events.filter((e) => e.type === 'cleared')).toHaveLength(0);
    });

    it('leaves agent ACK cursors alone across a whole batch', async () => {
        const b = seeded();
        await b.receive('b', {});
        const acked = store.getCursor('b');
        expect(acked).toBeGreaterThan(0);

        b.wipeMany({
            channelKeys: ['ws1:general', 'ws1:frontend', 'ws1:backend'],
            pairKeys: [humanPair('a'), humanPair('b')],
        });
        expect(store.getCursor('b')).toBe(acked);
    });
});
