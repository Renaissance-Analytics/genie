import { describe, it, expect, beforeEach } from 'vitest';
import { AgentInboxBroker } from '../broker';
import type { AgentInboxStore } from '../store';
import type { AgentInboxJoinInput, AgentInboxMessage } from '../types';
import { WAKE_QUIET_MS } from '../wake';
import { formatAgentInboxMailLine } from '../../mcp/protocol';

/**
 * Track B — durable inbox. The broker write-throughs every message to a store,
 * persists a per-agent ACK cursor, and on boot rehydrates its logs + undelivered
 * inboxes so a restart loses neither history nor a queued message.
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
    const input: AgentInboxJoinInput = {
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

describe('AgentInbox durable inbox (Track B)', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
        store = makeStore();
    });

    it('write-throughs a DM to the store', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        join(b, 'a');
        join(b, 'b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'hi b' });
        expect(store.rows).toHaveLength(1);
        expect(store.rows[0]).toMatchObject({ kind: 'dm', from: 'a', to: 'b', text: 'hi b' });
    });

    it('IMMEDIATE notice: a DM announces itself in the recipient chat even MID-TURN (beta.248)', () => {
        // THE CHANGE. Wake-on-DM only reached a provably-IDLE agent, so a message
        // to a working agent sat unseen until its turn ended. A TUI queues text
        // that arrives mid-turn (it is how a human interjects), so the notice goes
        // in as soon as the message lands -- no idle wait, no opt-in.
        let clock = 1_000_000;
        const b = new AgentInboxBroker();
        b.setStore(store);
        b.setClock(() => clock);
        const woken: Array<{ terminalId: string; text: string }> = [];
        b.setWakeSink((d) => { woken.push({ terminalId: d.terminalId, text: d.text }); });

        join(b, 'a');
        join(b, 'b'); // NOT opted in, and never finished a turn -- busy from birth.

        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping1' });
        expect(woken).toHaveLength(1);
        expect(woken[0].terminalId).toBe('t-b');
        expect(woken[0].text).toMatch(/not urgent/i);
        expect(woken[0].text).toContain('a'); // the sender's label

        // Mid-turn output is no longer a gate: the agent is plainly working and
        // still gets told.
        b.noteOutput('t-b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping2' });
        expect(woken).toHaveLength(2);
    });

    it('IMMEDIATE notice: an interrupt DM says check it NOW, a normal one says when free', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        const woken: string[] = [];
        b.setWakeSink((d) => { woken.push(d.text); });

        join(b, 'a');
        join(b, 'b');

        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'whenever', interrupt: false });
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'NOW', interrupt: true });

        expect(woken[0]).toMatch(/when you are not busy/i);
        expect(woken[1]).toMatch(/immediately/i);
        expect(woken[1]).toMatch(/HIGH PRIORITY/i);
    });

    it('IMMEDIATE notice: a CHANNEL post notifies every member but the sender', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        const woken: Array<{ terminalId: string; text: string }> = [];
        b.setWakeSink((d) => { woken.push({ terminalId: d.terminalId, text: d.text }); });

        join(b, 'a');
        join(b, 'b');
        // Both are in the same workspace purpose room by construction.
        const res = b.send({ fromAgentId: 'a', channelArg: 'general', text: 'standup' });

        if (res.ok) {
            // Only the OTHER member is told -- never an echo to the sender.
            expect(woken.every((w) => w.terminalId !== 't-a')).toBe(true);
            for (const w of woken) expect(w.text).toMatch(/channel/i);
        }
    });

    it("IMMEDIATE notice: a human draft is PRESERVED, never dropped and never spliced", () => {
        // Rewritten for the owner's JOB 2 contract. This used to assert that a
        // draft in the box HELD the notice indefinitely — which is how a
        // half-typed prompt silenced an agent's mail. The draft is still
        // untouchable; the notice is no longer the thing that gives way.
        const b = new AgentInboxBroker();
        b.setStore(store);
        const sent: Array<{ terminalId: string; mode: string; restore?: string }> = [];
        b.setWakeSink((d) => {
            sent.push({
                terminalId: d.terminalId,
                mode: d.plan.mode,
                ...(d.plan.mode === 'swap' ? { restore: d.plan.restore } : {}),
            });
        });

        join(b, 'a');
        join(b, 'b');

        // Empty box: the notice is simply submitted, which starts the turn.
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping1' });
        expect(sent[0]).toEqual({ terminalId: 't-b', mode: 'submit' });

        // The human types a plain prompt. Genie modelled every keystroke, so it
        // may cut the draft out, deliver, and paste it back verbatim.
        b.noteUserInput('t-b', 'hold on, I am writing');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping2' });
        expect(sent[1]).toEqual({
            terminalId: 't-b',
            mode: 'swap',
            restore: 'hold on, I am writing',
        });

        // They press the up-arrow: the cursor is now somewhere Genie does not
        // track, so it stops claiming to know the box. The notice is APPENDED
        // without being submitted rather than cutting text Genie cannot restore.
        b.noteUserInput('t-b', '\x1b[A');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping3' });
        expect(sent[2]).toEqual({ terminalId: 't-b', mode: 'append' });

        // They submit. The box is empty and known again, so the next notice
        // simply starts a turn.
        b.noteUserInput('t-b', '\r');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping4' });
        expect(sent[3]).toEqual({ terminalId: 't-b', mode: 'submit' });
    });

    it('IMMEDIATE notice: an APPENDED notice is not counted as a wake', () => {
        // Nothing was submitted, so no turn started — and the agent must stay
        // eligible for a real wake once its prompt is free again.
        const b = new AgentInboxBroker();
        b.setStore(store);
        const modes: string[] = [];
        b.setWakeSink((d) => { modes.push(d.plan.mode); });

        join(b, 'a');
        join(b, 'b');
        b.noteUserInput('t-b', '\x1b[A'); // Genie is no longer certain
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping' });

        expect(modes).toEqual(['append']);
    });

    it('an agent explicitly opted OUT is never announced to (owner: default ON, OFF is honoured)', () => {
        // The per-agent toggle now governs the IMMEDIATE notice too, and its
        // default flipped to ON. Someone who deliberately silenced an agent must
        // keep that silence -- a setting that stops being honoured is worse than
        // no setting.
        const b = new AgentInboxBroker();
        b.setStore(store);
        const woken: string[] = [];
        b.setWakeSink((d) => { woken.push(d.terminalId); });

        join(b, 'a');
        join(b, 'quiet', { wakeOnDm: false }); // explicit OFF
        join(b, 'normal'); // never set -> default ON

        b.send({ fromAgentId: 'a', toAgentId: 'quiet', text: 'shh' });
        expect(woken).toHaveLength(0);

        b.send({ fromAgentId: 'a', toAgentId: 'normal', text: 'hello' });
        expect(woken).toEqual(['t-normal']);
    });

    it('a human draft no longer costs the agent its notice — it is preserved instead', () => {
        // Rewritten for the JOB 2 contract. This used to assert that a draft made
        // the immediate notice give way to the idle-only nudge, which is how a
        // busy agent with a half-typed prompt at its terminal heard nothing at
        // all. Now the draft is cut and restored, and the notice lands as itself.
        let clock = 1_000_000;
        const b = new AgentInboxBroker();
        b.setStore(store);
        b.setClock(() => clock);
        const woken: Array<{ terminalId: string; text: string; mode: string }> = [];
        b.setWakeSink((d) => {
            woken.push({ terminalId: d.terminalId, text: d.text, mode: d.plan.mode });
        });

        join(b, 'a');
        join(b, 'b', { wakeOnDm: true });

        b.noteUserInput('t-b', 'typing');
        b.markTurnEnd('t-b');
        clock += WAKE_QUIET_MS + 1;
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping' });

        expect(woken).toHaveLength(1);
        expect(woken[0].mode).toBe('swap');
        // The notice itself, not the "you have N unread" fallback nudge.
        expect(woken[0].text).toMatch(/just received a message/i);
    });

    it('wake-on-DM remains the FALLBACK when the host cannot deliver a notice', () => {
        // The opt-in idle nudge is not deleted. It covers the case the host
        // REFUSES — most often a swap already in flight on that terminal — and it
        // stays idle-gated, so it can never land mid-turn.
        let clock = 1_000_000;
        const b = new AgentInboxBroker();
        b.setStore(store);
        b.setClock(() => clock);
        const woken: Array<{ terminalId: string; text: string }> = [];
        let refuse = true;
        b.setWakeSink((d) => {
            if (refuse) {
                refuse = false; // the fallback nudge itself gets through
                return false;
            }
            woken.push({ terminalId: d.terminalId, text: d.text });
            return true;
        });

        join(b, 'a');
        join(b, 'b', { wakeOnDm: true });

        b.markTurnEnd('t-b');
        clock += WAKE_QUIET_MS + 1;
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping' });

        expect(woken).toHaveLength(1);
        expect(woken[0].text).toContain('unread AgentInbox');
    });

    it('wakeTerminalIfIdle (IssueWatch): wakes an IDLE agent regardless of the AgentInbox opt-in, but NEVER mid-turn', () => {
        let clock = 1_000_000;
        const b = new AgentInboxBroker();
        b.setStore(store);
        b.setClock(() => clock);
        const woken: Array<{ terminalId: string; text: string }> = [];
        b.setWakeSink((d) => { woken.push({ terminalId: d.terminalId, text: d.text }); });

        // 'b' has NOT opted into wake-on-DM — the IssueWatch opt-in is independent.
        join(b, 'b');

        // Never finished a turn → not provably idle → no wake.
        expect(b.wakeTerminalIfIdle('t-b', 'iw')).toBe(false);
        expect(woken).toHaveLength(0);

        // Turn ended but still inside the quiet window → no wake yet.
        b.markTurnEnd('t-b');
        expect(b.wakeTerminalIfIdle('t-b', 'iw')).toBe(false);
        expect(woken).toHaveLength(0);

        // Past the quiet window + genuinely idle → wakes with the IssueWatch text.
        clock += WAKE_QUIET_MS + 1;
        expect(b.wakeTerminalIfIdle('t-b', 'iw text')).toBe(true);
        expect(woken).toEqual([{ terminalId: 't-b', text: 'iw text' }]);

        // One wake per idle period — a second ping doesn't re-nudge.
        expect(b.wakeTerminalIfIdle('t-b', 'iw again')).toBe(false);
        expect(woken).toHaveLength(1);

        // Output after the turn end (new turn / human typing) → fail closed forever
        // this idle period, even in a fresh quiet window.
        b.markTurnEnd('t-b');
        clock += WAKE_QUIET_MS + 1;
        b.noteOutput('t-b');
        clock += WAKE_QUIET_MS + 1;
        expect(b.wakeTerminalIfIdle('t-b', 'iw mid-turn')).toBe(false);
        expect(woken).toHaveLength(1);
    });

    it('wakeTerminalIfIdle: an unknown terminal is a safe no-op', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        b.setWakeSink(() => {});
        expect(b.wakeTerminalIfIdle('nope', 'iw')).toBe(false);
    });

    it('read-receipts: a sent DM is unseen until the recipient receives it (#9)', async () => {
        const b = new AgentInboxBroker();
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
        const b1 = new AgentInboxBroker();
        b1.setStore(store);
        join(b1, 'a');
        join(b1, 'b');
        b1.send({ fromAgentId: 'a', toAgentId: 'b', text: 'you have mail' });

        // Restart: fresh broker, SAME store, identities rehydrated, then messages.
        const b2 = new AgentInboxBroker();
        b2.setStore(store);
        join(b2, 'a');
        join(b2, 'b');
        b2.rehydrateMessages();

        expect(b2.hasMail('b')).toBe(true);
        const res = await b2.receive('b', {});
        expect(res.messages.map((m) => m.text)).toEqual(['you have mail']);
    });

    it('resumes the global seq across a restart (cursors stay valid)', () => {
        const b1 = new AgentInboxBroker();
        b1.setStore(store);
        join(b1, 'a');
        join(b1, 'b');
        const first = b1.send({ fromAgentId: 'a', toAgentId: 'b', text: 'm1' });

        const b2 = new AgentInboxBroker();
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
        const b = new AgentInboxBroker();
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
        const b = new AgentInboxBroker();
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
        const b1 = new AgentInboxBroker();
        b1.setStore(store);
        join(b1, 'a');
        b1.send({ fromAgentId: 'a', channelArg: 'general', text: 'channel note' });

        const b2 = new AgentInboxBroker();
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
        const b = new AgentInboxBroker();
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

describe('imDone agentinbox-mail nudge (Track A)', () => {
    it('formats a nudge when there is unread mail, null when there is none', () => {
        expect(formatAgentInboxMailLine({ count: 0, fromLabels: [] })).toBeNull();
        const one = formatAgentInboxMailLine({ count: 1, fromLabels: ['claude·frontend'] });
        expect(one).toContain('1 unread AgentInbox message');
        expect(one).toContain('claude·frontend');
        expect(one).toContain('receive');
        const many = formatAgentInboxMailLine({ count: 3, fromLabels: ['a', 'b'] });
        expect(many).toContain('3 unread AgentInbox messages');
        expect(many).toContain('from a, b');
    });
});
