import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';
import { numberTurns } from '../src/core/turn-numbers.js';
import { type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import { sessionsDir } from '../src/main/paths.js';
import { Registry } from '../src/main/registry.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { Store } from '../src/main/store.js';

/**
 * TURNS READ 1, 2, 3 … IN ORDER, EVERYWHERE (the owner, 2026-10-18, a screenshot of the Turns column reading
 * 54, 54, 55, 55, 56 … and the strip's labels on top of each other: "why am I still getting messed up turn ux").
 *
 * Measured cause: a turn's marker is numbered from the turns that ENDED, and the record's `lastTurn` was written only
 * when a turn ended. A turn cut off by an exit or a quit — its marker already written — left `lastTurn` one short, and
 * the next run numbered its first turn the same again. Every interrupted turn left a duplicate in the thread for good.
 *
 * Two fixes, both needed:
 * - the SOURCE: the record's last turn is written when a turn is NUMBERED (its marker), not when it ends;
 * - the DISPLAY: what a person reads is the ordinal — the k-th turn of the agent's recorded life — so threads that
 *   already carry duplicates read in order too, and every surface (the Turns column, the strip, the stream rows, the
 *   cards) reads the same number because they read the same numbered ledger.
 */

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'genie2-renumber-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: null });
const turnNs = (rows: readonly TimedEvent[]) => rows.flatMap((r) => (r.event.kind === 'turn' ? [r.event.n] : []));

function fakeDriver() {
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = { start: () => {}, prompt: () => {}, kill: () => {}, cliSessionId: null };
        return driver;
    };
    return {
        factory,
        endTurn: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }),
        exit: () => events.onExit?.(1, null),
    };
}

describe('numberTurns — what a person reads', () => {
    it('a thread with duplicates and a jump reads 1, 2, 3, 4; a stopped row names the turn it stopped (COUNTED)', () => {
        const rows = [
            t('h0', { kind: 'turn', n: 54, by: 'you' }),
            t('h1', { kind: 'message', speaker: 'agent', peerName: null, text: 'a' }),
            t('h2', { kind: 'turn', n: 54, by: 'you' }),
            t('h3', { kind: 'stopped', n: 54, by: 'you' }),
            t('h4', { kind: 'turn', n: 1, by: 'genie' }),
            t('h5', { kind: 'turn', n: 270, by: null }),
        ];
        const out = numberTurns(rows);
        expect(turnNs(out)).toEqual([1, 2, 3, 4]);
        expect(out.find((r) => r.id === 'h3')!.event).toEqual({ kind: 'stopped', n: 2, by: 'you' });
        // Ids and everything else untouched: a selection or an open row survives the renumbering.
        expect(out.map((r) => r.id)).toEqual(rows.map((r) => r.id));
        expect(out[1]).toBe(rows[1]);
    });

    it('a windowed history numbers on from the turns cut off before it', () => {
        const out = numberTurns([t('e', { kind: 'earlier', count: 900, turns: 40 }), t('h0', { kind: 'turn', n: 7, by: 'you' }), t('h1', { kind: 'turn', n: 7, by: 'you' })]);
        expect(turnNs(out)).toEqual([41, 42]);
    });

    it('CONTROL: a thread already in order is returned as it is', () => {
        const rows = [t('a', { kind: 'turn', n: 1, by: 'you' }), t('b', { kind: 'turn', n: 2, by: 'you' })];
        expect(numberTurns(rows)).toEqual(rows);
    });
});

describe('readHistory', () => {
    it('says how many TURNS the window cut off, not only how many rows', async () => {
        const dir = tempDir();
        const store = openDurableStore(dir);
        const d = fakeDriver();
        const { AgentSession } = await import('../src/core/session.js');
        const agentId = mintAgentId();
        const session = new AgentSession({ agentId, cwd: dir, store, driverFactory: d.factory, processTree: noProcessTree, onEvent: () => {}, turnsBefore: 0 });
        session.start();
        for (let i = 0; i < 5; i += 1) { session.prompt(`p${i}`, 'you'); d.endTurn(); }
        await session.settled();
        const all = await readHistory(store, agentId);
        expect(all.earlierTurns).toBe(0);
        expect(all.rows.filter((r) => r.event.kind === 'turn')).toHaveLength(5);
        // Cut to its last four rows: the turns cut off are COUNTED from the rows that were cut, and are some.
        const cut = await readHistory(store, agentId, { limit: 4 });
        const cutOff = all.rows.slice(0, all.rows.length - 4).filter((r) => r.event.kind === 'turn').length;
        expect(cutOff).toBeGreaterThan(0);
        expect(cut.earlierTurns).toBe(cutOff);
        expect(cut.earlierTurns + cut.rows.filter((r) => r.event.kind === 'turn').length).toBe(5);
    });
});

describe('the record’s last turn', () => {
    it('is written when the turn is NUMBERED — a turn cut off by an exit is not numbered again by the next run', async () => {
        const dir = tempDir();
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'example-host', healthy: true });
        await registry.addWorkspace({ id: 'example', path: dir });
        const record = await registry.register({ workspaceId: 'example', provider: 'claude', name: 'atlas' });
        await registry.setLastTurn(record.id, 53);

        const numbered: number[] = [];
        // The record's writes, AWAITED — never a guessed sleep: under a loaded machine (the Omarchy VM's full suite,
        // 2026-10-18) a 20 ms sleep ran the assertion before the write had landed.
        const writes: Promise<unknown>[] = [];
        const first = fakeDriver();
        const host = new SessionHost({ userData: dir, driverFor: (() => first.factory) as DriverFor, processTree: noProcessTree, onTurnNumbered: (_id, n) => { numbered.push(n); writes.push(registry.setLastTurn(record.id, n)); } });
        expect(host.start(registry.find(record.id)!, dir)).toEqual({ ok: true });
        host.prompt(record.id, 'start something long');
        expect(numbered).toEqual([54]); // at once, before the turn ends
        first.exit(); // cut off: the turn never ends
        host.stopAll();
        await Promise.all(writes);
        expect(registry.find(record.id)?.lastTurn).toBe(54);

        const second = fakeDriver();
        const again = new SessionHost({ userData: dir, driverFor: (() => second.factory) as DriverFor, processTree: noProcessTree, onTurnNumbered: (_id, n) => { numbered.push(n); } });
        expect(again.start(registry.find(record.id)!, dir)).toEqual({ ok: true });
        again.prompt(record.id, 'carry on');
        expect(numbered).toEqual([54, 55]);
        again.stopAll();
    });
});

describe('the host’s ledger', () => {
    it('is served numbered: a recorded thread with a duplicate reads in order (COUNTED against the raw thread)', async () => {
        const dir = tempDir();
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'example-host', healthy: true });
        await registry.addWorkspace({ id: 'example', path: dir });
        const record = await registry.register({ workspaceId: 'example', provider: 'claude', name: 'atlas' });
        // A thread as the old numbering left it: two runs that both opened turn 8.
        const { AgentSession } = await import('../src/core/session.js');
        for (let run = 0; run < 2; run += 1) {
            const d = fakeDriver();
            const s = new AgentSession({ agentId: record.id, cwd: dir, store: openDurableStore(sessionsDir(dir)), driverFactory: d.factory, processTree: noProcessTree, onEvent: () => {}, turnsBefore: 7 });
            s.start();
            s.prompt(`run ${run}`, 'you');
            await s.settled();
        }
        const raw = await readHistory(openDurableStore(sessionsDir(dir)), record.id);
        expect(raw.rows.flatMap((r) => (r.event.kind === 'turn' ? [r.event.n] : []))).toEqual([8, 8]);

        const host = new SessionHost({ userData: dir, driverFor: (() => fakeDriver().factory) as DriverFor, processTree: noProcessTree });
        host.ledgerFor(record.id); // starts the read
        // The history is read asynchronously: wait for the READ, not for a guessed time.
        await vi.waitFor(() => { expect(turnNs(host.ledgerFor(record.id))).toHaveLength(2); }, { timeout: 10_000, interval: 20 });
        expect(turnNs(host.ledgerFor(record.id))).toEqual([1, 2]);
    });
});
