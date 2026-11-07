import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionStore } from '@particle-academy/prism-harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentDetailReceiver, type AgentPushPayload } from '../src/core/agent-push-wire.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { AgentPush } from '../src/main/agent-push.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * GENIE WAS CLOSE TO UNUSABLE (the owner, 2026-10-20): "severe UI lag like 3 seconds to show any text at all and a whole
 * minute plus to render an FTQ." Measured on his machine: Genie's main process at one full core, no spawn storm, no
 * terminal output — and the agent `tynn` streaming events nonstop into a thread of 66,373 rows (29 MB).
 *
 * Every event did work proportional to the agent's WHOLE ledger, several times over: the live session (`probe`) rescanned
 * every row for its usage, delivery, plan, model and turn; the detail rebuilt and renumbered the ledger; and main pushed
 * the entire ledger to the window — whether or not the window was showing that agent — once per event, every chunk of a
 * streamed reply included. These tests hold each of those to a cost that does not grow with the ledger.
 */

const ROWS = 60_000;

/** An in-memory thread store with the append log, so 60k rows do not mean 60k fsyncs in a unit test. */
function memoryStore(): SessionStore {
    const kv = new Map<string, Record<string, unknown>>();
    const logs = new Map<string, Record<string, unknown>[]>();
    const store = {
        get: async (k: string) => (kv.get(k) ?? null) as never,
        put: async (k: string, p: Record<string, unknown>) => { kv.set(k, p); },
        forget: async (k: string) => { kv.delete(k); logs.delete(k); },
        withLock: async <T>(_k: string, cb: () => T | Promise<T>) => cb(),
        durability: () => 'durable' as const,
        appendLog: async (k: string, entries: readonly Record<string, unknown>[]) => { const l = logs.get(k) ?? []; l.push(...entries); logs.set(k, l); },
        readLog: async (k: string) => (logs.get(k)?.slice() ?? null) as never,
        logLength: async (k: string) => logs.get(k)?.length ?? null,
        clearLog: async (k: string) => { logs.set(k, []); },
    };
    return store as unknown as SessionStore;
}

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

let dir: string;
let events: DriverEvents = {};
let now = 1_760_000_000_000;
const fakeDriverFor: DriverFor = () => {
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
    };
    return factory;
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-perf-'));
    now = 1_760_000_000_000;
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/** One step of a busy agent, as tynn's thread reads: a tool call, its completion, a progress notice; now and then a reply, a usage report. */
function step(i: number): void {
    const send = (u: Record<string, unknown>) => events.onUpdate?.(u);
    send({ sessionUpdate: 'tool_call', toolCallId: `t${i}`, name: 'Bash', title: `step ${i}`, kind: 'execute', status: 'pending', rawInput: { command: `npm run check -- --shard ${i}` } });
    send({ sessionUpdate: 'tool_call_update', toolCallId: `t${i}`, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `shard ${i} ok `.repeat(20) } }] });
    send({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'task progress' } });
    if (i % 10 === 0) for (const t of ['Working on ', `shard ${i}`, ' now.']) send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
    if (i % 50 === 0) send({ sessionUpdate: 'usage_update', used: 10_000 + i, size: 200_000 });
}

/**
 * Every read of a row SLOT older than the newest `fresh`, in each of `arrays`, counted: each old index becomes an accessor
 * that counts and returns the row. The host keeps its rows and the ledger it serves as arrays grown in place, so a read of
 * the ledger — a `for … of`, a spread, a `slice`, an index — goes through these, and a rescan reads every old slot. Rows
 * appended after this stay plain (they are the newest, which an event is allowed to read).
 */
function countOldRowReads(arrays: readonly (readonly unknown[])[], fresh: number): { reads: number; old: number } {
    const gauge = { reads: 0, old: 0 };
    const seen = new Set<readonly unknown[]>();
    for (const array of arrays) {
        if (seen.has(array)) continue;
        seen.add(array);
        const old = Math.max(0, array.length - fresh);
        if (gauge.old === 0) gauge.old = old;
        for (let i = 0; i < old; i += 1) {
            let row = array[i];
            Object.defineProperty(array, i, {
                configurable: true,
                enumerable: true,
                get: () => { gauge.reads += 1; return row; },
                set: (next: unknown) => { row = next; },
            });
        }
    }
    return gauge;
}

describe('a live session with a 60k-row ledger', () => {
    it('costs the same per event as an empty one: what main reads per event does not rescan the rows', () => {
        /*
         * COUNTED, NOT TIMED (genie#1273, and again 2026-11-01). This compared ms per event at 600 and 60,000 rows. The
         * ratio was right in every run (x0.64–x1.01, the control x60–x185) — and the test still failed most full-suite
         * runs on omarchy-test (2 vCPU), timed out at 5 s building and timing the ledgers. What it names is "does not
         * rescan the rows", and that is a count: every read of a row slot is counted (`countOldRowReads`), on the host's
         * rows and on the ledger it serves, and an event of a 60,000-row session must read no more of its old rows than
         * an event of a 600-row one. A rescan reads every one of them, per read.
         */
        // Per event, main read the session three times (the window's detail, the Dashboard's snapshot twice) and the
        // ledger twice (the detail's rows and its turn count).
        const live = (rows: number) => {
            const host = new SessionHost({ userData: dir, driverFor: fakeDriverFor, clock: () => now, processTree: noProcessTree, store: memoryStore });
            const r = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'tynn' });
            expect(host.start(r, dir)).toEqual({ ok: true });
            // Each session keeps its own driver's events: `step` sends to whichever started last, so hold this one's.
            const mine = events;
            let i = 0;
            const event = (scan: boolean) => {
                events = mine;
                step(i++);
                for (let k = 0; k < 3; k += 1) host.probe(r.id);
                for (let k = 0; k < 2; k += 1) host.ledgerFor(r.id);
                // The CONTROL's extra reads: the ledger walked once per read, five per event — what the reads did before the fix.
                if (scan) for (let k = 0; k < 5; k += 1) { let n = 0; for (const row of host.rowsFor(r.id)) if (row.at !== null) n += 1; if (n < 0) throw new Error('unreachable'); }
            };
            while (host.rowsFor(r.id).length < rows) { events = mine; step(i++); }
            expect(host.rowsFor(r.id).length).toBeGreaterThanOrEqual(rows);
            // The first reads build what is then KEPT (the ledger served, the background count): once, not per event.
            for (let k = 0; k < 5; k += 1) event(false);
            // Every row but the newest 100 (a reply, its tool calls — what an event may read) is counted from here on.
            const gauge = countOldRowReads([host.rowsFor(r.id), host.ledgerFor(r.id)], 100);
            /** Old row slots read per event, over `n` events. */
            const perEvent = (n: number, scan: boolean) => { const before = gauge.reads; for (let k = 0; k < n; k += 1) event(scan); return (gauge.reads - before) / n; };
            return { host, gauge, perEvent };
        };
        const small = live(600);
        const large = live(ROWS);
        const reads = { small: small.perEvent(200, false), large: large.perEvent(200, false), smallScan: small.perEvent(2, true), largeScan: large.perEvent(2, true) };
        console.log(`PERF: old rows main reads per event: ${reads.small} at 600 rows, ${reads.large} at ${ROWS}; with the ledger walked per read ${reads.smallScan} / ${reads.largeScan} (${large.gauge.old} old rows counted)`);
        // POSITIVE CONTROL: the same gauge, the same events, plus the ledger walked five times per event (what the reads did
        // before the fix) — and the gauge sees every old row, five times.
        expect(reads.largeScan, `control: ${reads.largeScan} old rows read per event`).toBeGreaterThanOrEqual(5 * large.gauge.old);
        expect(large.gauge.old).toBeGreaterThan(ROWS - 1_000);
        // A hundred times the rows, and no more of them read per event. Before the fix each read walked all 60k rows (a
        // delivery read alone built a map of 15k calls and sorted it): 59,900 or more per read, five reads per event.
        expect(reads.large - reads.small, `old rows read per event: ${reads.large} at ${ROWS} rows, ${reads.small} at 600`).toBeLessThan(100);
        expect(reads.large, `old rows read per event at ${ROWS} rows`).toBeLessThan(100);
        small.host.stopAll();
        large.host.stopAll();
    }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------------

interface Row { readonly id: string; readonly event: { readonly kind: string; readonly text: string } }
interface Detail { readonly agent: { readonly id: string }; readonly turns: number; readonly rows: readonly Row[] }

/** A ledger the size of tynn's, rows the size of tynn's (29 MB / 66k ≈ 440 bytes). */
function ledgerOf(n: number): Row[] {
    return Array.from({ length: n }, (_, i) => ({ id: `a:${i}`, event: { kind: 'tool', text: `row ${i} `.padEnd(400, '.') } }));
}

function harness(initial: Row[]) {
    let ledger: readonly Row[] = initial;
    let clock = 0;
    let timers: { at: number; fn: () => void; live: boolean }[] = [];
    const sent: AgentPushPayload<Omit<Detail, 'rows'>, Row>[] = [];
    let built = 0;
    const push = new AgentPush<Detail, Row>({
        detailFor: () => { built += 1; return { agent: { id: 'a' }, turns: ledger.length, rows: ledger }; },
        send: (_id, payload) => { sent.push(payload); },
        schedule: (ms, fn) => { const t = { at: clock + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
        now: () => clock,
    });
    return {
        push,
        sent,
        get built() { return built; },
        get ledger() { return ledger; },
        set ledger(next: readonly Row[]) { ledger = next; },
        /** Let time pass, running the timers that fall due. */
        advance(ms: number) {
            clock += ms;
            for (;;) {
                const due = timers.filter((t) => t.live && t.at <= clock).sort((a, b) => a.at - b.at)[0];
                if (!due) break;
                due.live = false;
                due.fn();
            }
            timers = timers.filter((t) => t.live);
        },
        bytes: (from = 0) => sent.slice(from).reduce((sum, p) => sum + JSON.stringify(p).length, 0),
    };
}

describe('what main pushes to the window when an agent changes', () => {
    it('builds and sends NOTHING for an agent the window is not showing', () => {
        const h = harness(ledgerOf(1_000));
        for (let i = 0; i < 50; i += 1) { h.push.changed('a'); h.advance(10); }
        h.advance(1_000);
        expect(h.built).toBe(0);
        expect(h.sent).toHaveLength(0);
    });

    it('coalesces a burst: the first change goes at once, the rest as ONE push carrying the last state', () => {
        const h = harness(ledgerOf(1_000));
        h.push.watch('a', true);
        h.advance(1_000);
        const before = h.sent.length;
        for (let i = 0; i < 300; i += 1) { h.ledger = [...h.ledger, { id: `b:${i}`, event: { kind: 'tool', text: `${i}` } }]; h.push.changed('a'); }
        h.advance(1_000);
        const burst = h.sent.length - before;
        expect(burst).toBeGreaterThanOrEqual(1);
        expect(burst).toBeLessThanOrEqual(2);
        // The last state, nothing lost: the window holds every row.
        const r = new AgentDetailReceiver<Omit<Detail, 'rows'>, Row>();
        let shown: Detail | null | undefined;
        for (const p of h.sent) shown = r.apply(p) ?? shown;
        expect(shown?.rows.map((x) => x.id)).toEqual(h.ledger.map((x) => x.id));
    });

    it('sends the rows that CHANGED, not the 60k-row ledger, on every push', () => {
        const h = harness(ledgerOf(ROWS));
        h.push.watch('a', true);
        h.advance(1_000);
        const first = h.sent.length;
        // 300 events, each far enough apart to be pushed on its own (the worst case for coalescing): a new row, or the
        // last row growing (a streamed reply).
        for (let i = 0; i < 300; i += 1) {
            const grow = i % 3 === 2;
            const last = h.ledger.at(-1)!;
            h.ledger = grow ? [...h.ledger.slice(0, -1), { id: last.id, event: { kind: 'message', text: `${last.event.text} more` } }] : [...h.ledger, { id: `n:${i}`, event: { kind: 'tool', text: `n ${i}`.padEnd(400, '.') } }];
            h.push.changed('a');
            h.advance(200);
        }
        const pushes = h.sent.length - first;
        expect(pushes).toBe(300);
        const perPush = h.bytes(first) / pushes;
        console.log(`PERF: bytes per push over a ${ROWS}-row ledger: ${Math.round(perPush)}`);
        // Budget: 4 KB a push — a row or two. Before the fix every push carried all 60k rows (~26 MB).
        expect(perPush, `bytes per push ${Math.round(perPush)}`).toBeLessThan(4_096);
    });

    it('the window rebuilds EXACTLY the ledger — order kept, a growing reply replaced in place, history arriving in front', () => {
        const h = harness(ledgerOf(500));
        const r = new AgentDetailReceiver<Omit<Detail, 'rows'>, Row>();
        let shown: Detail | null | undefined;
        const check = () => {
            for (const p of h.sent.splice(0)) { const d = r.apply(p); if (d !== undefined) shown = d; }
            expect(shown?.rows).toEqual(h.ledger);
            expect(shown?.turns).toBe(h.ledger.length);
        };
        h.push.watch('a', true);
        h.advance(1_000);
        check();
        let seed = 7;
        const rand = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
        for (let i = 0; i < 400; i += 1) {
            const x = rand();
            const last = h.ledger.at(-1)!;
            if (x < 0.5) h.ledger = [...h.ledger, { id: `n:${i}`, event: { kind: 'tool', text: `${i}` } }];
            else if (x < 0.85) h.ledger = [...h.ledger.slice(0, -1), { ...last, event: { kind: 'message', text: `${last.event.text}+` } }];
            else if (x < 0.95) h.ledger = [...h.ledger.slice(0, 3), { id: `r:${i}`, event: { kind: 'turn', text: `${i}` } }, ...h.ledger.slice(4)];
            else h.ledger = [{ id: `h:${i}`, event: { kind: 'earlier', text: '' } }, ...h.ledger];
            h.push.changed('a');
            h.advance(Math.floor(rand() * 120));
            if (i % 37 === 0) { h.advance(1_000); check(); }
        }
        h.advance(1_000);
        check();
    });

    it('a ledger the host GROWS IN PLACE (appends, the newest row replaced) still arrives exactly — and the window never shares the host’s array', () => {
        /*
         * The host keeps ONE array per run and grows it (session-host `ledgerFor`): rebuilding 60k rows per change was
         * most of what an event still cost (measured 2026-10-21: 1.32 ms of 1.18–2.12). So the array the push held last
         * time IS the one it gets now, longer. The patch is read from the length and last row it held, not by comparing
         * the array with itself — which would find nothing changed and send nothing.
         */
        const live: Row[] = ledgerOf(50);
        const h = harness(live);
        const r = new AgentDetailReceiver<Omit<Detail, 'rows'>, Row>();
        let shown: Detail | null | undefined;
        const check = () => {
            for (const p of h.sent.splice(0)) { const d = r.apply(p); if (d !== undefined) shown = d; }
            expect(shown?.rows).toEqual([...h.ledger]);
            // The window's rows are its own: what the host does to its array next does not reach them.
            expect(shown?.rows).not.toBe(h.ledger);
        };
        h.push.watch('a', true);
        h.advance(1_000);
        check();
        let seed = 11;
        const rand = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
        let appended = 0;
        let replaced = 0;
        for (let i = 0; i < 400; i += 1) {
            const arr = h.ledger as Row[];
            const x = rand();
            if (x < 0.55) { arr.push({ id: `n:${i}`, event: { kind: 'tool', text: `${i}` } }); appended += 1; }
            else if (x < 0.95) { const last = arr.at(-1)!; arr[arr.length - 1] = { ...last, event: { kind: 'message', text: `${last.event.text}+` } }; replaced += 1; }
            // A renumber or the history landing: a NEW array, as the host makes one then.
            else h.ledger = [{ id: `h:${i}`, event: { kind: 'earlier', text: '' } }, ...arr];
            h.push.changed('a');
            h.advance(Math.floor(rand() * 120));
            if (i % 29 === 0) { h.advance(1_000); check(); }
        }
        h.advance(1_000);
        check();
        // COUNTED: both in-place kinds happened, so "exact" was not measured on appends alone.
        expect(appended).toBeGreaterThan(50);
        expect(replaced).toBeGreaterThan(50);
    });

    it('a window that stops watching and starts again is sent the whole ledger again, and a stale patch is never applied', () => {
        const h = harness(ledgerOf(100));
        const r = new AgentDetailReceiver<Omit<Detail, 'rows'>, Row>();
        h.push.watch('a', true);
        h.advance(1_000);
        for (const p of h.sent.splice(0)) r.apply(p);
        h.push.watch('a', false);
        r.reset();
        h.ledger = [...h.ledger, { id: 'x', event: { kind: 'tool', text: 'x' } }];
        h.push.changed('a');
        h.advance(1_000);
        expect(h.sent).toHaveLength(0);
        h.push.watch('a', true);
        h.advance(1_000);
        let shown: Detail | null | undefined;
        for (const p of h.sent.splice(0)) { const d = r.apply(p); if (d !== undefined) shown = d; }
        expect(shown?.rows).toEqual(h.ledger);
        // A patch against a push this receiver never held is ignored, not applied to the wrong rows.
        expect(r.apply({ seq: 999, detail: { agent: { id: 'a' }, turns: 0 }, rows: { base: 998, keep: 1, append: [] } })).toBeUndefined();
    });
});
