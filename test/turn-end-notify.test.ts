import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { askAndWait } from '../src/main/doctor-mcp.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A TURN'S END IS ANNOUNCED AFTER THE STATE SAYS SO. Found in the first doctor-mode trials on the owner's machine
 * (2026-10-13): genie answered in four seconds and the doctor channel's `ask` waited its full ten minutes. The session
 * told its listeners a turn had ended (`#changed()`) BEFORE it set `turnState` to idle or failed, so every listener read
 * `working` — and nothing announced again. The same listeners redraw Genie's Agent view, Dashboard and chat, which kept
 * showing a finished turn as Working until some unrelated event came along. The state is now set first, then announced.
 */
const noProcessTree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const dirs: string[] = [];
// Sessions and hosts whose thread writes may still be in flight when a test ends — every test here returns as soon as the
// ledger or the state says so, before the rows are on disk. Removing the folders under those writes (a write re-creates
// its folder) is the race behind this file's FILE-level error about one full suite in three (2026-10-15; an afterAll
// error is reported outside the tests) — a remove racing a create fails ENOTEMPTY. See test/thread-writes-settle.test.ts.
const writers: { settled(): Promise<void> }[] = [];
afterAll(async () => {
    await Promise.all(writers.map((w) => w.settled()));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'genie2-turnend-')); dirs.push(d); return d; };

function fakeFactory() {
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
        return driver;
    };
    return { factory, ev: () => events };
}

describe('the session', () => {
    it('a clean turn end is announced with the state already idle; a crashed one with it already failed', () => {
        for (const [outcome, want] of [[{ stopReason: 'end_turn', isError: false }, 'idle'], [{ stopReason: null, isError: true }, 'failed']] as const) {
            const { factory, ev } = fakeFactory();
            const seen: string[] = [];
            const dir = tmp();
            const session: AgentSession = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: noProcessTree, onStateChange: () => seen.push(session.turnState) });
            writers.push(session);
            session.start();
            session.prompt('hello');
            expect(session.turnState).toBe('working');
            seen.length = 0;
            ev().onTurnEnd?.(outcome as never);
            // Every announcement of the turn's end reads the end state — none reads `working`.
            expect(seen.length).toBeGreaterThan(0);
            expect(seen).toEqual(seen.map(() => want));
        }
    });
});

describe('the doctor channel’s ask, over a real session host', () => {
    it('resolves with the reply as soon as the turn ends — not at its timeout', async () => {
        const { factory, ev } = fakeFactory();
        const driverFor: DriverFor = () => factory;
        const dir = tmp();
        const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
        writers.push(host);
        const record = agentRecord({ id: mintAgentId(), workspaceId: '__genie__', provider: 'claude', name: 'genie' });
        expect(host.start(record, dir)).toEqual({ ok: true });
        const started = Date.now();
        const pending = askAndWait(host, record.id, 'what is broken?', 5_000);
        await Promise.resolve();
        void ev().onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the MCP port is taken' } });
        await new Promise((r) => setTimeout(r, 10));
        ev().onTurnEnd?.({ stopReason: 'end_turn', isError: false } as never);
        const result = await pending;
        expect(result).toEqual({ ok: true, reply: 'the MCP port is taken' });
        // Positive control on the timing: it resolved on the turn's end, long before the 5 s timeout.
        expect(Date.now() - started).toBeLessThan(2_000);
        host.stop(record.id);
    });
});
