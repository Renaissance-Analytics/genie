import { describe, expect, it } from 'vitest';
import { StreamPrep, prepareStream } from '../src/core/stream-prep.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE WORK STREAM'S PREPARATION, INCREMENTALLY (the owner, 2026-10-22: "are we redrawing the whole chat and work
 * streams every time they update?"). Measured before (scripts/bench-live-views.ts): 0.24 / 1.22 / 6.26 ms per push at
 * 3k / 30k / 100k rows — every push re-ran activityRows, joinToolCalls, resolveThinkTokens, resolveTurnCosts and
 * resolveToolDurations over the WHOLE ledger.
 *
 * The chat's trick (derive from a turn boundary) does not carry over: a tool call's updates fold into the row where the
 * call first appeared, and costs / thought tokens / durations reach across any cut. So `StreamPrep` is a FOLD over the
 * ledger that keeps what those passes carry, processes only the rows a push adds, and undoes the newest row when the
 * wire replaces it (agent-push-wire: kept rows keep identity; only the newest is ever replaced). Proven DIFFERENTIALLY:
 * at every step of generated pushes its output deep-equals the full pipeline (`prepareStream`) — and the rows it reads
 * are counted.
 */

function rng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** One generated row: every kind the preparation treats specially, including tool updates long after their call. */
function makeRow(i: number, r: () => number, open: string[], state: { turn: number; used: number; cost: number; tin: number; tout: number }): TimedEvent {
    const p = r();
    const at = r() < 0.05 ? null : 1_700_000_000_000 + i * 1000;
    let event: unknown;
    if (p < 0.06) { state.turn += 1; event = { kind: 'turn', n: state.turn, by: 'you' }; }
    else if (p < 0.08) event = { kind: 'divider', variant: 'compaction', before: 9000, after: 1200 };
    else if (p < 0.2) {
        const id = r() < 0.05 ? '' : `tc${i}`;
        if (id) open.push(id);
        event = { kind: 'tool', toolCallId: id, name: r() < 0.7 ? 'Bash' : null, title: r() < 0.7 ? `step ${i}` : null, status: 'pending', toolKind: r() < 0.3 ? 'edit' : 'execute', rawInput: { cmd: `c${i}` } };
    } else if (p < 0.34 && open.length > 0) {
        // An update for a call opened any time before — often many rows (and turns) earlier.
        const id = open[Math.floor(r() * open.length)]!;
        const terminal = r() < 0.5;
        if (terminal) open.splice(open.indexOf(id), 1);
        event = { kind: 'tool', toolCallId: id, name: r() < 0.2 ? 'Read' : null, title: r() < 0.2 ? `late ${i}` : null, status: terminal ? (r() < 0.8 ? 'completed' : 'failed') : 'in_progress', toolKind: r() < 0.2 ? 'read' : null, rawInput: r() < 0.2 ? { late: i } : null };
    } else if (p < 0.48) event = { kind: 'think', text: `thinking ${i}`, tokens: null, ...(r() < 0.2 ? { estimate: Math.floor(r() * 500) } : {}) };
    else if (p < 0.54) event = { kind: 'notice', level: 'debug', message: 'thinking', ...(r() < 0.6 ? { estimate: Math.floor(r() * 900) } : {}) };
    else if (p < 0.58) event = { kind: 'notice', level: 'info', message: `note ${i}` };
    else if (p < 0.68) {
        state.used += Math.floor(r() * 3000) - (r() < 0.1 ? 5000 : 0);
        if (r() < 0.8) state.cost += r() * 0.05;
        const restart = r() < 0.05;
        if (restart) { state.cost = 0.01; state.tin = 0; state.tout = 0; }
        state.tin += Math.floor(r() * 4000);
        state.tout += Math.floor(r() * 800);
        event = { kind: 'usage', used: Math.max(0, state.used), size: 200_000, cost: r() < 0.15 ? null : state.cost, ...(r() < 0.7 ? { inTokens: state.tin, outTokens: state.tout } : {}) };
    } else if (p < 0.8) event = { kind: 'message', speaker: r() < 0.5 ? 'agent' : 'you', peerName: null, text: `m${i}` };
    else event = { kind: 'think', text: `more ${i}`, tokens: null };
    return { id: `e${i}`, event: event as TimedEvent['event'], at };
}

/** The newest row grown or advanced, as the wire replaces it: same id, a NEW object. */
function grown(row: TimedEvent, r: () => number): TimedEvent {
    const e = row.event;
    if (e.kind === 'think') return { ...row, event: { ...e, text: `${e.text} and more` } };
    if (e.kind === 'tool') return { ...row, event: { ...e, status: r() < 0.5 ? 'completed' : 'in_progress' } };
    if (e.kind === 'usage') return { ...row, event: { ...e, used: e.used + 100, cost: e.cost === null ? null : e.cost + 0.001 } };
    if (e.kind === 'notice') return { ...row, event: { ...e, estimate: 42 } };
    return { ...row };
}

describe('the fold is exactly the full preparation', () => {
    it('at EVERY step of 16 generated push sequences: appends of 1–6 rows, the newest row replaced, now and then a new base', () => {
        for (let seed = 1; seed <= 16; seed += 1) {
            const r = rng(seed);
            const open: string[] = [];
            const state = { turn: 0, used: 1000, cost: 0, tin: 0, tout: 0 };
            const prep = new StreamPrep();
            let rows: TimedEvent[] = [];
            let i = 0;
            for (let step = 0; step < 150; step += 1) {
                const q = r();
                if (q < 0.25 && rows.length > 0) rows = [...rows.slice(0, -1), grown(rows.at(-1)!, r)];
                else if (q < 0.27) rows = rows.map((x) => ({ ...x })); // a whole new ledger (a re-watch): every row a new object
                else {
                    const n = 1 + Math.floor(r() * 6);
                    rows = [...rows];
                    for (let k = 0; k < n; k += 1) rows.push(makeRow(i++, r, open, state));
                }
                expect(prep.update(rows), `seed ${seed}, step ${step}, ${rows.length} rows`).toEqual(prepareStream(rows));
            }
        }
    });

    it('CONTROL: the reference is the pipeline the Stream ran (a tool update folds into its call; costs rise per report)', () => {
        const rows: TimedEvent[] = [
            { id: 'a', event: { kind: 'tool', toolCallId: 'x', name: 'Bash', title: 'ls', status: 'pending', toolKind: 'execute', rawInput: null }, at: 1000 },
            { id: 'b', event: { kind: 'usage', used: 10, size: 100, cost: 0.5 }, at: 2000 } as TimedEvent,
            { id: 'c', event: { kind: 'tool', toolCallId: 'x', name: null, title: null, status: 'completed', toolKind: null, rawInput: null }, at: 4000 },
            { id: 'd', event: { kind: 'usage', used: 20, size: 100, cost: 0.75 }, at: 5000 } as TimedEvent,
        ];
        const p = prepareStream(rows);
        expect(p.rows.map((x) => x.id)).toEqual(['a', 'b', 'd']);
        expect(p.rows[0]!.event).toMatchObject({ status: 'completed', title: 'ls' });
        expect(p.durations.get('x')).toBe(3000);
        expect((p.rows[2]!.event as { turnCost: number }).turnCost).toBe(0.25);
    });
});

describe('what a push reads', () => {
    function counted(rows: TimedEvent[]) {
        let reads = 0;
        const proxy = new Proxy(rows, { get(target, key, recv) { if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1; return Reflect.get(target, key, recv); } });
        return { rows: proxy as readonly TimedEvent[], reads: () => reads };
    }

    it('FLAT: once a 100,000-row ledger is folded, appending one row reads a handful of rows, not 100,000', () => {
        const r = rng(9);
        const open: string[] = [];
        const state = { turn: 0, used: 1000, cost: 0, tin: 0, tout: 0 };
        const base: TimedEvent[] = Array.from({ length: 100_000 }, (_, i) => makeRow(i, r, open, state));
        const prep = new StreamPrep();
        prep.update(base);
        const next = counted([...base, makeRow(100_000, r, open, state)]);
        prep.update(next.rows);
        expect(next.reads()).toBeLessThan(50);
        // And replacing the newest row (the wire's only other change) is as cheap.
        const newest = makeRow(100_001, r, open, state);
        prep.update([...base, newest]);
        const replaced = counted([...base, grown(newest, r)]);
        prep.update(replaced.rows);
        expect(replaced.reads()).toBeLessThan(50);
    });

    it('CONTROL: the full pipeline reads every row (the counter sees it)', () => {
        const r = rng(9);
        const open: string[] = [];
        const state = { turn: 0, used: 1000, cost: 0, tin: 0, tout: 0 };
        const big = counted(Array.from({ length: 100_000 }, (_, i) => makeRow(i, r, open, state)));
        prepareStream(big.rows);
        expect(big.reads()).toBeGreaterThanOrEqual(100_000);
    });
});
