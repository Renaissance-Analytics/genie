import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import { ReminderBook } from '../src/core/inbox-reminders.js';
import type { NoticeMail } from '../src/core/stream-event.js';
import { wireInboxPush } from '../src/main/inbox-push.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const off of cleanups.splice(0)) off(); vi.useRealTimers(); });

function rig() {
    vi.useFakeTimers();
    const id = mintAgentId();
    const book = new ReminderBook();
    const pending: NoticeMail[] = [];
    const attempts: number[] = [];
    let ready = true;
    let refusals = Infinity;
    let seq = 0;
    let sent: (to: string, message?: { from: string }) => void = () => {};
    let changed: (agentId: AgentId) => void = () => {};
    const handOff = vi.fn(() => {
        attempts.push(Date.now());
        if (refusals > 0) { refusals -= 1; throw new Error('provider refused this handoff'); }
        return { queued: null };
    });
    cleanups.push(wireInboxPush({
        inbox: { onSend: (listener) => { sent = listener; return () => {}; } },
        host: {
            subscribe: (listener) => { changed = listener; return () => {}; },
            deliverable: () => ready ? 1 : null, runOf: () => 1, turnsEndedThisRun: () => 0,
            inTurn: () => false, hasQueuedPrompt: () => false, probe: () => null, handOff,
        },
        reminders: ({ run }) => {
            const text = book.due({ agentId: id, unread: pending.length, newestSeq: seq, run: run(id) });
            return text ? [{ agentId: id, text, mail: [...pending] }] : [];
        },
        settled: (agentId, delivered) => book.settled(agentId, delivered),
        delivered: () => { pending.splice(0); },
        cumulative: true,
        schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
    }));
    return {
        attempts, handOff,
        refuse: (count: number) => { refusals = count; },
        stateChanged: () => changed(id),
        ready: (value: boolean) => { ready = value; changed(id); },
        arrive: () => {
            seq += 1;
            pending.push({ id: `mail_${seq}`, from: 'human', fromName: null, text: 'pending mail', sentAt: new Date().toISOString() });
            sent(id, { from: 'human' });
        },
    };
}

describe('Tynn #672: refused inbox handoffs back off', () => {
    it('waits 1, 2, 4, 8, 16, 32 seconds then stays at 60; unrelated events cannot bypass the cap', async () => {
        const r = rig();
        const start = Date.now();
        r.arrive();
        expect(r.attempts).toEqual([start]);
        let elapsed = 0;
        for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
            const before = r.attempts.length;
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(r.attempts).toHaveLength(before);
            await vi.advanceTimersByTimeAsync(1);
            elapsed += delay;
            expect(r.attempts.at(-1)).toBe(start + elapsed);
            expect(r.attempts).toHaveLength(before + 1);
        }
        const before = r.attempts.length;
        r.stateChanged();
        r.arrive();
        expect(r.attempts).toHaveLength(before);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(r.attempts).toHaveLength(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(r.attempts).toHaveLength(before + 1);
    });

    it('a successful handoff resets the next refusal to a one-second retry', async () => {
        const r = rig();
        r.refuse(2);
        r.arrive();
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(r.handOff).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(r.handOff).toHaveBeenCalledTimes(3); // accepted
        r.refuse(1);
        r.arrive();
        expect(r.handOff).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(999);
        expect(r.handOff).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(r.handOff).toHaveBeenCalledTimes(5);
    });

    it('becoming ready resets the refusal streak and cancels its old retry timer', async () => {
        const r = rig();
        r.arrive();
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(r.handOff).toHaveBeenCalledTimes(3);
        r.ready(false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(r.handOff).toHaveBeenCalledTimes(3);
        r.ready(true);
        expect(r.handOff).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(999);
        expect(r.handOff).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(r.handOff).toHaveBeenCalledTimes(5);
        r.ready(false);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(r.handOff).toHaveBeenCalledTimes(5);
    });
});
