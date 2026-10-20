import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { openDurableStore } from '../src/core/thread-store.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import { Registry } from '../src/main/registry.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { Store } from '../src/main/store.js';

/**
 * TURNS ARE NUMBERED ONCE, IN ORDER (the owner, 2026-10-16: "the way you are managing turns is very messed up" — a
 * rail reading 268, 270, 269, 268, 268, 268 … 261, 1, 259). Measured from the agent's own thread:
 * - the first turn after a Genie restart was numbered 1: the recorded turns are counted ASYNCHRONOUSLY at start, and a
 *   prompt that arrived first numbered from 0. Now the count is KNOWN at start — the agent's record carries its last
 *   turn number, written as each turn ends — and the first turn after a restart continues it.
 * - a prompt the provider REFUSED (Codex while a turn runs, a driver that throws) had already written its turn marker
 *   and your message, and left the session "in a turn" with nothing running — "Working" forever, a clock that never
 *   moves — and the next prompt reused the number. Now nothing is written unless the provider took the prompt.
 */

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'genie2-turns-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function fakeDriver(refuse: () => string | null = () => null) {
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = {
            start: () => {},
            prompt: () => { const r = refuse(); if (r !== null) throw new Error(r); },
            kill: () => {},
            cliSessionId: null,
        };
        return driver;
    };
    return { factory, endTurn: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }) };
}
const turnsIn = (rows: readonly StreamEvent[]) => rows.filter((r): r is Extract<StreamEvent, { kind: 'turn' }> => r.kind === 'turn').map((r) => r.n);

describe('the first turn after a restart', () => {
    it("continues the count it was started with — at once, never from 1 while the history is still being read", () => {
        const rows: StreamEvent[] = [];
        const d = fakeDriver();
        const session = new AgentSession({ agentId: mintAgentId(), cwd: tempDir(), store: openDurableStore(tempDir()), driverFactory: d.factory, processTree: noProcessTree, onEvent: (e) => rows.push(e), turnsBefore: 267 });
        session.start();
        session.prompt('hello again', 'you');
        expect(turnsIn(rows)).toEqual([268]);
        d.endTurn();
        session.prompt('and again', 'you');
        expect(turnsIn(rows)).toEqual([268, 269]);
    });
});

describe('a prompt the provider refuses', () => {
    it('writes nothing, leaves the session out of a turn, and the next prompt takes the number', () => {
        const rows: StreamEvent[] = [];
        let refuse: string | null = 'Codex turn already in flight';
        const d = fakeDriver(() => refuse);
        const session = new AgentSession({ agentId: mintAgentId(), cwd: tempDir(), store: openDurableStore(tempDir()), driverFactory: d.factory, processTree: noProcessTree, onEvent: (e) => rows.push(e), turnsBefore: 10 });
        session.start();
        d.endTurn(); // the session is idle and ready
        const before = rows.length;
        expect(() => session.prompt('ignored', 'genie')).toThrow(/already in flight/);
        expect(rows.slice(before)).toEqual([]);
        expect(session.turnState).not.toBe('working');
        refuse = null;
        session.prompt('taken', 'you');
        expect(turnsIn(rows.slice(before))).toEqual([12]); // 10 recorded + the one that ended above + this one
    });
});

describe('the count survives a relaunch', () => {
    it('the host starts a session with the record’s last turn, and reports each turn as it is NUMBERED; the registry keeps it', async () => {
        const dir = tempDir();
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'example-host', healthy: true });
        await registry.addWorkspace({ id: 'example', path: dir });
        const record = await registry.register({ workspaceId: 'example', provider: 'claude', name: 'atlas' });
        await registry.setLastTurn(record.id, 267);
        const d = fakeDriver();
        const driverFor: DriverFor = () => d.factory;
        const reported: number[] = [];
        const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree, onTurnNumbered: (_id, n) => { reported.push(n); } });
        expect(host.start(registry.find(record.id)!, dir)).toEqual({ ok: true });
        host.prompt(record.id, 'hello');
        // Reported when the turn is numbered, not when it ends: a turn cut off before its end is not numbered again.
        expect(reported).toEqual([268]);
        d.endTurn();
        expect(reported).toEqual([268]);
        // The registry keeps what its owner (main, on each numbered turn) writes, across a relaunch.
        await registry.setLastTurn(record.id, 268);
        const reopened = new Registry(new Store(dir));
        await reopened.load({ name: 'example-host', healthy: true });
        expect(reopened.find(record.id)?.lastTurn).toBe(268);
        host.stopAll();
    });
});
