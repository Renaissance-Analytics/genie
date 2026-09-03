import { describe, it, expect, beforeEach } from 'vitest';
import { AgentInboxBroker } from '../broker';
import { HarnessTransportRegistry } from '../harness-transport';
import { createHarnessTransportSink } from '../transport-sink';
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

    it('delivers a DM to the harness adapter even mid-turn without touching the PTY', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        const delivered: string[] = [];
        const woken: string[] = [];
        b.setTransportSink((_target, message) => { delivered.push(message.text); });
        b.setWakeSink((d) => { woken.push(d.text); });

        join(b, 'a');
        join(b, 'b'); // NOT opted in, and never finished a turn -- busy from birth.

        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping1' });
        expect(delivered).toEqual(['ping1']);
        expect(woken).toEqual([]);

        // Mid-turn output is no longer a gate: the agent is plainly working and
        // still gets told.
        b.noteOutput('t-b');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping2' });
        expect(delivered).toEqual(['ping1', 'ping2']);
        expect(woken).toEqual([]);
    });

    it('keeps interrupt priority in the durable message without synthesizing input text', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        const delivered: Array<boolean | undefined> = [];
        b.setTransportSink((_target, message) => { delivered.push(message.interrupt); });

        join(b, 'a');
        join(b, 'b');

        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'whenever', interrupt: false });
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'NOW', interrupt: true });

        expect(delivered).toEqual([undefined, true]);
    });

    it('user input state never participates in agent-to-agent delivery', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        const delivered: string[] = [];
        const sent: string[] = [];
        const pending: Array<{ terminalId: string; pending: boolean }> = [];
        b.setTransportSink((_target, message) => { delivered.push(message.text); });
        b.setWakeSink((d) => { sent.push(d.text); });
        b.setPendingNudgeSink((d) => pending.push(d));

        join(b, 'a');
        join(b, 'b');

        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping1' });
        b.noteUserInput('t-b', 'hold on, I am writing');
        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping2' });
        expect(delivered).toEqual(['ping1', 'ping2']);
        expect(sent).toEqual([]);
        expect(pending).toEqual([]);
    });

    it('IMMEDIATE notice: a DEFERRED notice is not counted as a wake', () => {
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

        expect(modes).toEqual([]);
    });

    it('legacy wake preferences do not disable native AgentInbox transport', () => {
        const b = new AgentInboxBroker();
        b.setStore(store);
        const delivered: string[] = [];
        b.setTransportSink((target) => { delivered.push(target.terminalId); });

        join(b, 'a');
        join(b, 'quiet', { wakeOnDm: false }); // explicit OFF
        join(b, 'normal'); // never set -> default ON

        b.send({ fromAgentId: 'a', toAgentId: 'quiet', text: 'shh' });
        b.send({ fromAgentId: 'a', toAgentId: 'normal', text: 'hello' });
        expect(delivered).toEqual(['t-quiet', 't-normal']);
    });

    it('a human draft queues the notice instead of injecting it', () => {
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

        expect(woken).toHaveLength(0);
    });

    it('a DECLINED native delivery stays durable AND announces on the PTY', async () => {
        // The contract this asserted has been deliberately reversed. It used to
        // require that a declined delivery never reach the PTY, which left an
        // agent that is running but not attached to Genie's services silently
        // unreachable: the mail sat durable and the sender saw nothing but a
        // stale read-receipt. The owner's rule now is that nothing posts to chat
        // WHILE the internal hooks are engaged -- and `false` is the harness
        // saying they are not.
        //
        // The message stays durable either way; that half never changed.
        const b = new AgentInboxBroker();
        b.setStore(store);
        const woken: string[] = [];
        b.setTransportSink(() => false);
        b.setWakeSink((d) => { woken.push(d.text); });

        join(b, 'a');
        join(b, 'b');

        b.send({ fromAgentId: 'a', toAgentId: 'b', text: 'ping' });
        // The ANNOUNCEMENT, immediately -- naming the sender, not a count. The
        // "you have N unread" wake is the rate-limited backstop and must NOT be
        // what lands here.
        expect(woken).toHaveLength(1);
        expect(woken[0]).not.toMatch(/unread/i);
        await expect(b.receive('b')).resolves.toMatchObject({
            messages: [expect.objectContaining({ text: 'ping' })],
        });
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

    it('wakeTerminalIfIdle: a sink VETO is reported as false, not swallowed into a false success', () => {
        // The sink's `false` is a real veto (background.ts: the terminal is
        // parked on someone else's modal, or another notice already holds the
        // input). Reporting `true` there tells the caller a nudge landed when
        // nothing was typed -- and `manageAgentUpgrade` turns that into
        // "Genie reconnected you", which the agent then acts on.
        let clock = 1_000_000;
        const idle = (b: AgentInboxBroker) => {
            b.markTurnEnd('t-b');
            clock += WAKE_QUIET_MS + 1;
        };

        // POSITIVE CONTROL: identical setup, sink accepts -> true. Without this
        // the veto assertion below would also pass against a wake that is simply
        // broken for every input.
        const ok = new AgentInboxBroker();
        ok.setStore(store);
        ok.setClock(() => clock);
        const landed: string[] = [];
        ok.setWakeSink((d) => { landed.push(d.text); return true; });
        join(ok, 'b');
        idle(ok);
        expect(ok.wakeTerminalIfIdle('t-b', 'iw text')).toBe(true);
        expect(landed).toEqual(['iw text']);

        // The veto.
        const vetoed = new AgentInboxBroker();
        vetoed.setStore(store);
        vetoed.setClock(() => clock);
        let asked = 0;
        vetoed.setWakeSink(() => { asked += 1; return false; });
        join(vetoed, 'b');
        idle(vetoed);
        expect(vetoed.wakeTerminalIfIdle('t-b', 'iw text')).toBe(false);
        expect(asked).toBe(1); // the sink WAS consulted -- this is a veto, not an earlier gate

        // A sink that returns nothing (the void-returning test sinks above, and
        // any sink that simply performs the write) still counts as delivered.
        const quiet = new AgentInboxBroker();
        quiet.setStore(store);
        quiet.setClock(() => clock);
        quiet.setWakeSink(() => {});
        join(quiet, 'b');
        idle(quiet);
        expect(quiet.wakeTerminalIfIdle('t-b', 'iw text')).toBe(true);
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

    /**
     * genie#346 — what an upgrade actually costs, and what it must not.
     *
     * The durable store survives (the test above). The HARNESS TRANSPORT REGISTRY
     * does not: it is in-memory in the main process, so the replacement Genie
     * starts with every agent looking unattached. `notifyNow` then correctly
     * falls through to the PTY and the notice is TYPED at the prompt — which is
     * the field evidence on #346, and the reason it defeats #344 on every single
     * upgrade.
     *
     * The channel bridge is now supervised (`claudeChannelBridge`), so it
     * re-registers itself seconds after the new server binds. This pins the
     * consequence: once it has, mail rides the channel again, and the message
     * that spanned the upgrade is still there to be read.
     */
    it('after an upgrade, mail rides the RE-BOUND channel instead of the keyboard', async () => {
        // Boot 1: `a` DMs `b`, and the app dies before `b` reads it.
        const b1 = new AgentInboxBroker();
        b1.setStore(store);
        join(b1, 'a');
        join(b1, 'b');
        b1.send({ fromAgentId: 'a', toAgentId: 'b', text: 'sent across the upgrade' });

        // Boot 2: fresh broker AND fresh registry — both die with the process —
        // against the SAME durable store, wired exactly as background.ts wires
        // them.
        const registry = new HarnessTransportRegistry();
        const woken: string[] = [];
        const b2 = new AgentInboxBroker();
        b2.setStore(store);
        b2.setTransportSink(createHarnessTransportSink(registry));
        b2.setWakeSink((d) => {
            woken.push(d.text);
        });
        join(b2, 'a');
        join(b2, 'b');
        b2.rehydrateMessages();

        // POSITIVE CONTROL, and the bug itself: with no channel bound — the
        // state every agent is in the instant an upgrade finishes — a new notice
        // IS typed at the prompt. If this did not happen the assertion below
        // would prove nothing, because "nothing was typed" passes against a
        // broker that never types at all.
        b2.send({ system: true, toAgentId: 'b', text: 'notice with no channel' });
        expect(woken).toHaveLength(1);

        // The supervised bridge reconnects and re-registers itself.
        registry.bindPull('b', 'claude-channel');

        b2.send({ system: true, toAgentId: 'b', text: 'notice over the channel' });
        // NOTHING new was typed: the agent is attached again.
        expect(woken).toHaveLength(1);

        // …and the message that spanned the upgrade is still deliverable, along
        // with everything queued behind it. Nothing in flight was lost.
        const res = await b2.receive('b', {});
        expect(res.messages.map((m) => m.text)).toEqual([
            'sent across the upgrade',
            'notice with no channel',
            'notice over the channel',
        ]);
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
