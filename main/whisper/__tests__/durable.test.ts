import { describe, it, expect, beforeEach } from 'vitest';
import { WhisperBroker } from '../broker';
import type { WhisperStore } from '../store';
import type { WhisperJoinInput, WhisperMessage } from '../types';
import { WAKE_QUIET_MS } from '../wake';
import { formatWhisperMailLine } from '../../mcp/protocol';

/**
 * Track B — durable inbox. The broker write-throughs every message to a store,
 * persists a per-agent ACK cursor, and on boot rehydrates its logs + undelivered
 * inboxes so a restart loses neither history nor a queued whisper.
 */

/** A tiny in-memory WhisperStore standing in for genie.db. */
function makeStore(): WhisperStore & { rows: WhisperMessage[]; cursors: Map<string, number> } {
    const rows: WhisperMessage[] = [];
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
        sentDmReceipts(fromId, limit) {
            return rows
                .filter((m) => m.from === fromId && m.kind === 'dm')
                .sort((a, b) => b.seq - a.seq)
                .slice(0, limit)
                .map((m) => ({
                    seq: m.seq,
                    id: m.id,
                    to: m.to ?? '',
                    text: m.text,
                    ts: m.ts,
                    seen: (cursors.get(m.to ?? '') ?? 0) >= m.seq,
                }));
        },
    };
}

function join(b: WhisperBroker, id: string, extra: Partial<WhisperJoinInput> = {}): void {
    const input: WhisperJoinInput = {
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
    };
    b.join(input);
}

describe('whisper durable inbox (Track B)', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
        store = makeStore();
    });

    it('write-throughs a DM to the store', () => {
        const b = new WhisperBroker();
        b.setStore(store);
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'hi b' });
        expect(store.rows).toHaveLength(1);
        expect(store.rows[0]).toMatchObject({ kind: 'dm', from: 'a', to: 'b', text: 'hi b' });
    });

    it('wake-on-DM: nudges an opted-in IDLE target, once, and NEVER after output (#9)', () => {
        let clock = 1_000_000;
        const b = new WhisperBroker();
        b.setStore(store);
        b.setClock(() => clock);
        const woken: Array<{ terminalId: string; text: string }> = [];
        b.setWakeSink((terminalId, text) => woken.push({ terminalId, text }));

        join(b, 'a');
        join(b, 'b', { wakeOnDm: true });

        // B finished a turn (imDone) → idle at its prompt, but not yet quiet enough.
        b.markTurnEnd('t-b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping1' });
        expect(woken).toHaveLength(0);

        // Past the quiet window → a DM wakes B with the canned nudge.
        clock += WAKE_QUIET_MS + 1;
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping2' });
        expect(woken).toHaveLength(1);
        expect(woken[0].terminalId).toBe('t-b');
        expect(woken[0].text).toContain('unread WhisperChat');

        // One wake per idle period — a further DM doesn't re-nudge.
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping3' });
        expect(woken).toHaveLength(1);

        // B produces output (a new turn / a human typing) → the core safety gate:
        // any output after the turn end means NOT idle, so no more wakes.
        clock += WAKE_QUIET_MS + 1;
        b.noteOutput('t-b');
        clock += WAKE_QUIET_MS + 1;
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping4' });
        expect(woken).toHaveLength(1);
    });

    it('wake-on-DM: an opted-OUT agent (default) is never woken', () => {
        let clock = 1_000_000;
        const b = new WhisperBroker();
        b.setStore(store);
        b.setClock(() => clock);
        const woken: string[] = [];
        b.setWakeSink((tid) => woken.push(tid));

        join(b, 'a');
        join(b, 'b'); // wakeOnDm defaults false
        b.markTurnEnd('t-b');
        clock += WAKE_QUIET_MS + 1;
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'hi' });
        expect(woken).toHaveLength(0);
    });

    it('read-receipts: a sent DM is unseen until the recipient receives it (#9)', async () => {
        const b = new WhisperBroker();
        b.setStore(store);
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping' });

        // Sender a sees its DM as NOT yet seen (b hasn't received).
        let receipts = b.receipts('a');
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ to: 'b', text: 'ping', seen: false });

        // b receives → its ACK cursor advances → the DM flips to seen.
        await b.receive('b', {});
        receipts = b.receipts('a');
        expect(receipts[0].seen).toBe(true);

        // Only the caller's OWN sent DMs are reported (b sent none).
        expect(b.receipts('b')).toHaveLength(0);
    });

    it('re-queues an undelivered DM after a restart', async () => {
        // First boot: a DMs b, but b never receives it before the app dies.
        const b1 = new WhisperBroker();
        b1.setStore(store);
        join(b1, 'a');
        join(b1, 'b');
        b1.send({ fromAgentId: 'a', toAgentId: 'b', text: 'you have mail' });

        // Restart: fresh broker, SAME store, identities rehydrated, then messages.
        const b2 = new WhisperBroker();
        b2.setStore(store);
        join(b2, 'a');
        join(b2, 'b');
        b2.rehydrateMessages();

        expect(b2.hasMail('b')).toBe(true);
        const res = await b2.receive('b', {});
        expect(res.messages.map((m) => m.text)).toEqual(['you have mail']);
    });

    it('resumes the global seq across a restart (cursors stay valid)', () => {
        const b1 = new WhisperBroker();
        b1.setStore(store);
        join(b1, 'a');
        join(b1, 'b');
        const first = b1.send({ fromAgentId: 'a', toAgentId: 'b', text: 'm1' });

        const b2 = new WhisperBroker();
        b2.setStore(store);
        join(b2, 'a');
        join(b2, 'b');
        b2.rehydrateMessages();
        const second = b2.send({ fromAgentId: 'a', toAgentId: 'b', text: 'm2' });

        const seq1 = first.ok ? first.message.seq : 0;
        const seq2 = second.ok ? second.message.seq : 0;
        expect(seq2).toBeGreaterThan(seq1);
    });

    it('persists an agent ACK cursor on receive (Track C foundation)', async () => {
        const b = new WhisperBroker();
        b.setStore(store);
        join(b, 'a');
        join(b, 'b');
        const sent = b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ack me' });
        const seq = sent.ok ? sent.message.seq : -1;

        expect(store.getCursor('b')).toBe(0);
        await b.receive('b', {});
        expect(store.getCursor('b')).toBe(seq);
        // Once acked, no more mail.
        expect(b.hasMail('b')).toBe(false);
    });

    it('reports unread mail for a terminal, cleared after receive (Track A signal)', async () => {
        const b = new WhisperBroker();
        b.setStore(store);
        join(b, 'a', { label: 'claude·general' });
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping' });

        // 'b' joined with terminalId 't-b'.
        expect(b.unreadForTerminal('t-b')).toEqual({ count: 1, fromLabels: ['claude·general'] });
        await b.receive('b', {});
        expect(b.unreadForTerminal('t-b')).toEqual({ count: 0, fromLabels: [] });
        // An unknown / non-agent terminal is empty, never throws.
        expect(b.unreadForTerminal('t-nope')).toEqual({ count: 0, fromLabels: [] });
    });

    it('rebuilds channel history after a restart', () => {
        const b1 = new WhisperBroker();
        b1.setStore(store);
        join(b1, 'a');
        b1.send({ fromAgentId: 'a', channelArg: 'general', text: 'channel note' });

        const b2 = new WhisperBroker();
        b2.setStore(store);
        join(b2, 'a');
        b2.rehydrateMessages();

        const key = 'ws1:general';
        const history = b2.history({ channelKey: key });
        expect(history.map((m) => m.text)).toContain('channel note');
    });
});

describe('unACKed-urgent escalation (Track C)', () => {
    function collectingBroker() {
        const events: Array<{ type: string; escalation?: { targetLabel: string; fromLabel: string } }> = [];
        const b = new WhisperBroker();
        b.setEmitter((ev) => events.push(ev as never));
        b._setEscalationMs(15);
        return { b, events };
    }

    it('escalates an interrupt DM the target never receives', async () => {
        const { b, events } = collectingBroker();
        join(b, 'a', { label: 'claude·ops' });
        join(b, 'b', { label: 'claude·frontend' });
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'URGENT', interrupt: true });
        await new Promise((r) => setTimeout(r, 45));
        const esc = events.find((e) => e.type === 'escalation');
        expect(esc).toBeTruthy();
        expect(esc?.escalation?.targetLabel).toBe('claude·frontend');
        expect(esc?.escalation?.fromLabel).toBe('claude·ops');
    });

    it('does NOT escalate if the target receives in time', async () => {
        const { b, events } = collectingBroker();
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'urgent', interrupt: true });
        await b.receive('b', {}); // drains → acks before the timer
        await new Promise((r) => setTimeout(r, 45));
        expect(events.find((e) => e.type === 'escalation')).toBeFalsy();
    });

    it('resolves a fired escalation once the target finally receives', async () => {
        const { b, events } = collectingBroker();
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'urgent', interrupt: true });
        await new Promise((r) => setTimeout(r, 45)); // let it fire
        expect(events.find((e) => e.type === 'escalation')).toBeTruthy();
        await b.receive('b', {}); // b finally picks it up
        expect(events.find((e) => e.type === 'escalation-resolved')).toBeTruthy();
    });

    it('does not escalate a non-interrupt DM', async () => {
        const { b, events } = collectingBroker();
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'just fyi' });
        await new Promise((r) => setTimeout(r, 45));
        expect(events.find((e) => e.type === 'escalation')).toBeFalsy();
    });
});

describe('imDone whisper-mail nudge (Track A)', () => {
    it('formats a nudge when there is unread mail, null when there is none', () => {
        expect(formatWhisperMailLine({ count: 0, fromLabels: [] })).toBeNull();
        const one = formatWhisperMailLine({ count: 1, fromLabels: ['claude·frontend'] });
        expect(one).toContain('1 unread whisper');
        expect(one).toContain('claude·frontend');
        expect(one).toContain('receive');
        const many = formatWhisperMailLine({ count: 3, fromLabels: ['a', 'b'] });
        expect(many).toContain('3 unread whispers');
        expect(many).toContain('from a, b');
    });
});
