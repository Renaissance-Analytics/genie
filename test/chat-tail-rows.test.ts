import { describe, expect, it } from 'vitest';
import { chatTailStart, chatThreadFrom, type ChatDetail } from '../src/core/chat-view.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * AN UPDATE DERIVES THE CHAT FROM THE TAIL OF THE LEDGER, NOT ALL OF IT (the owner, 2026-10-22: never recompute the whole
 * thread per update). Measured before (scripts/bench-live-views.ts): chatThreadFrom took 0.70 / 6.84 / 33.31 ms per push
 * at 3k / 30k / 100k rows — the whole history re-derived up to 20 times a second to show its last 500 lines.
 *
 * Everything a chat message depends on — whether it waits behind a step, whether thoughts merge, a queued prompt's
 * delivery — comes from rows at or after the last turn/stopped/run boundary before it (each of those resets the waiting
 * state, and a delivery always follows its message). So the chat for the last N lines is derived from the boundary at or
 * before where those lines begin, and it is EXACTLY the end of the full derivation: proven here differentially over
 * generated ledgers of every row kind, and the rows it reads are counted.
 */

/** A small deterministic PRNG, so a failure names a seed that reproduces it. */
function rng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function ledger(n: number, seed: number): TimedEvent[] {
    const r = rng(seed);
    const rows: TimedEvent[] = [];
    let turn = 0;
    const openTools: string[] = [];
    const pending: string[] = [];
    for (let i = 0; i < n; i += 1) {
        const p = r();
        const lines = 1 + Math.floor(r() * 4);
        const text = Array.from({ length: lines }, (_, j) => `t${i}.${j}`).join('\n');
        let event: unknown;
        if (p < 0.08) { turn += 1; event = { kind: 'turn', n: turn, by: r() < 0.5 ? 'you' : null }; }
        else if (p < 0.1) event = { kind: 'stopped', n: turn, by: r() < 0.5 ? 'you' : null };
        else if (p < 0.11) event = { kind: 'run', resumed: r() < 0.5 };
        else if (p < 0.25) {
            const id = `tc${i}`;
            openTools.push(id);
            event = { kind: 'tool', toolCallId: id, name: 'Bash', title: `step ${i}`, status: 'in_progress' };
        } else if (p < 0.35 && openTools.length > 0) {
            const id = openTools.splice(Math.floor(r() * openTools.length), 1)[0]!;
            event = { kind: 'tool', toolCallId: id, name: 'Bash', title: null, status: r() < 0.8 ? 'completed' : 'failed' };
        } else if (p < 0.5) event = { kind: 'think', text: r() < 0.1 ? '   ' : text };
        else if (p < 0.6) {
            const pend = r() < 0.3 ? { pending: { id: `q${i}`, content: null } } : {};
            if ('pending' in pend) pending.push(`q${i}`);
            event = { kind: 'message', speaker: 'you', peerName: null, text, ...pend };
        } else if (p < 0.64 && pending.length > 0) {
            const id = pending.splice(Math.floor(r() * pending.length), 1)[0]!;
            event = { kind: 'prompt_delivery', id, status: (['sent', 'undelivered', 'discarded'] as const)[Math.floor(r() * 3)] };
        } else if (p < 0.66) event = { kind: 'message', speaker: 'peer', peerName: 'genie', text, mail: r() < 0.5 ? [{ id: `m${i}`, from: 'human', fromName: null, text: 'subject\nbody' }] : [] };
        else if (p < 0.67) event = { kind: 'divider', variant: 'compaction', before: 9000, after: 1200 };
        else if (p < 0.7) event = { kind: 'notice', level: 'info', message: `n${i}` };
        else event = { kind: 'message', speaker: r() < 0.9 ? 'agent' : 'peer', peerName: r() < 0.9 ? null : 'wren', text };
        rows.push({ id: `e${i}`, event: event as TimedEvent['event'], at: 1_700_000_000_000 + i * 1000 });
    }
    return rows;
}

const detailOf = (rows: readonly TimedEvent[], comms: ChatDetail['comms'] = null, running = true): ChatDetail => ({
    agent: { id: 'agent_a', name: 'atlas', provider: 'claude', fidelity: 'declared' },
    session: running ? ({ running: true, turnState: 'working' } as unknown as ChatDetail['session']) : null,
    rows,
    comms,
});

describe('the tail is exactly the end of the full chat', () => {
    it('over 60 generated ledgers of every row kind, at several window sizes, with and without mail', () => {
        for (let seed = 1; seed <= 60; seed += 1) {
            const rows = ledger(400 + seed * 13, seed);
            const comms = seed % 2 === 0 ? Array.from({ length: 12 }, (_, k) => ({ id: `c${k}`, from: k % 2 ? 'human' : 'agent_a', to: k % 2 ? 'agent_a' : 'agent_w', text: `mail ${k}`, sentAt: new Date(1_700_000_000_000 + (k * 37 + seed) * 1000 * 7).toISOString(), readAt: null })) : null;
            const detail = detailOf(rows, comms, seed % 3 !== 0);
            const full = chatThreadFrom(detail, 'agent_a', [], Date.now).messages;
            for (const lines of [1, 20, 100, 500]) {
                const tail = chatThreadFrom(detail, 'agent_a', [], Date.now, lines);
                expect(tail.messages, `seed ${seed}, ${lines} lines`).toEqual(full.slice(full.length - tail.messages.length));
                // It covers the window it was asked for (or everything there is), and says whether rows are behind it.
                const covered = tail.messages.reduce((n, m) => n + m.text.split('\n').length, 0);
                if (tail.earlier) expect(covered, `seed ${seed}, ${lines} lines`).toBeGreaterThanOrEqual(Math.min(lines, 1));
                else expect(tail.messages, `seed ${seed}, ${lines} lines: nothing behind = the whole chat`).toEqual(full);
            }
        }
    });

    it('CONTROL: without a window the chat is the whole history, and nothing is behind it', () => {
        const rows = ledger(300, 7);
        const view = chatThreadFrom(detailOf(rows), 'agent_a', [], Date.now);
        expect(view.earlier).toBe(false);
        expect(view.messages.length).toBeGreaterThan(50);
    });
});

describe('what an update reads', () => {
    /** The ledger as a Proxy that counts every row read by index. */
    function counted(rows: TimedEvent[]) {
        let reads = 0;
        const proxy = new Proxy(rows, { get(target, key, recv) { if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1; return Reflect.get(target, key, recv); } });
        return { rows: proxy as readonly TimedEvent[], reads: () => reads, reset: () => { reads = 0; } };
    }

    it('FLAT: the last 500 lines of a 100,000-row ledger read about as many rows as of a 3,000-row one', () => {
        const small = counted(ledger(3_000, 11));
        const big = counted(ledger(100_000, 11));
        chatThreadFrom(detailOf(small.rows), 'agent_a', [], Date.now, 500);
        chatThreadFrom(detailOf(big.rows), 'agent_a', [], Date.now, 500);
        expect(big.reads()).toBeLessThan(5_000);
        expect(big.reads()).toBeLessThan(small.reads() * 3);
    });

    it('CONTROL: the full derivation reads every row (the counter can see it)', () => {
        const big = counted(ledger(100_000, 11));
        chatThreadFrom(detailOf(big.rows), 'agent_a', [], Date.now);
        expect(big.reads()).toBeGreaterThanOrEqual(100_000);
    });

    it('the tail starts at a turn/stopped/run boundary (or the very start)', () => {
        const rows = ledger(5_000, 3);
        const s = chatTailStart(rows, 500);
        expect(s === 0 || ['turn', 'stopped', 'run'].includes(rows[s]!.event.kind)).toBe(true);
        expect(s).toBeGreaterThan(0);
    });
});
