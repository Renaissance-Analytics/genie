import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { restartAgent, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { processTable } from './support/process-table.js';

/**
 * RESTART IS STOP-THEN-START, IN THAT ORDER, AND STOP IS VERIFIED (hosting plan 1.3 / 1.4; the owner, 2026-10-20:
 * agents got duplicated — a restart ran two Claudes on one conversation).
 *
 * `restartAgent` called `host.stop` and `host.start` in the same tick; `stop()` was synchronous and fire-and-forget, and
 * Genie never closed the provider's stdin (prism-acp's `endInput()`), so Claude had no chance to end on its own. Now:
 * stdin closes, Claude gets a short grace to flush its conversation, then the tree is killed, then the stop is VERIFIED
 * (every process the run owned is gone, by a fresh reading) — and only then may the next run start.
 *
 * Every process table here is a fake (test/support/process-table.ts); nothing on the machine is touched.
 */

const SELF = process.pid;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'genie2-stop-verified-')); dirs.push(d); return d; };
const THREAD = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c5d';

/** A Claude-like driver over a fake table: start spawns cmd.exe → claude.exe; endInput makes it exit `exitAfterMs` later. */
function claudeLike(t: ReturnType<typeof processTable>, log: string[], opts: { exitAfterMs: number | null; pidBase: number }) {
    let events: DriverEvents = {};
    let exited = false;
    const cmd = opts.pidBase, claude = opts.pidBase + 1;
    const exit = (why: string): void => {
        if (exited) return;
        exited = true;
        t.exit(claude); t.exit(cmd);
        log.push(`exit:${opts.pidBase}:${why}`);
        events.onExit?.(0, null);
    };
    const factory: SessionDriverFactory = (o) => {
        events = o.events;
        const driver: SessionDriver & { endInput(): void } = {
            start: () => { t.spawn(cmd, SELF, 'cmd.exe'); t.spawn(claude, cmd, 'claude.exe'); log.push(`start:${opts.pidBase}`); },
            prompt: () => {},
            endInput: () => {
                log.push(`endInput:${opts.pidBase}`);
                if (opts.exitAfterMs !== null) setTimeout(() => exit('stdin closed'), opts.exitAfterMs);
            },
            // Windows: the kill reaches cmd.exe only.
            kill: () => { log.push(`kill:${opts.pidBase}`); t.exit(cmd); },
            get running() { return !exited; },
            cliSessionId: THREAD,
        };
        return driver;
    };
    return { factory, emit: () => events, cmd, claude };
}

function sessionWith(t: ReturnType<typeof processTable>, factory: SessionDriverFactory, onEvent?: (e: StreamEvent) => void): AgentSession {
    const dir = tempDir();
    return new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: t.tree, ...(onEvent ? { onEvent } : {}) });
}

describe('AgentSession.stop — stdin first, a grace, then the kill, then a verified end', () => {
    it('closes stdin and lets a provider that ends within the grace end on its own: no kill needed, verified', async () => {
        const t = processTable(SELF);
        const log: string[] = [];
        const d = claudeLike(t, log, { exitAfterMs: 50, pidBase: 940_000 });
        const s = sessionWith(t, d.factory);
        s.start();

        const verdict = await s.stop('SIGTERM', { graceMs: 2_000 });

        expect(log.indexOf('endInput:940000')).toBeGreaterThan(-1);
        expect(log.indexOf('exit:940000:stdin closed')).toBeGreaterThan(log.indexOf('endInput:940000'));
        expect(verdict).toMatchObject({ verified: true });
        expect(t.alive(d.claude)).toBe(false);
    });

    it('a provider that ignores stdin is killed after the grace, and its orphan reaped: verified only once nothing is left', async () => {
        const t = processTable(SELF);
        const log: string[] = [];
        const d = claudeLike(t, log, { exitAfterMs: null, pidBase: 941_000 });
        const s = sessionWith(t, d.factory);
        s.start();

        const stopping = s.stop('SIGTERM', { graceMs: 150 });
        // Inside the grace: stdin closed, nothing killed yet. (Read from the log, never a wall clock: a timer may fire a
        // millisecond either side of Date.now on a loaded VM; the 2026-10-20 re-run failed this test once, and the wall-clock bound was its one such assertion.)
        expect(log).toEqual(['start:941000', 'endInput:941000']);
        const verdict = await stopping;

        expect(log).toEqual(['start:941000', 'endInput:941000', 'kill:941000']);
        expect(t.alive(d.claude)).toBe(false);
        expect(verdict).toMatchObject({ verified: true });
    });

    it('a process that will not die makes the stop UNVERIFIED, naming it — never a success', async () => {
        const t = processTable(SELF);
        const log: string[] = [];
        const d = claudeLike(t, log, { exitAfterMs: null, pidBase: 942_000 });
        const s = sessionWith(t, d.factory);
        s.start();
        t.unkillable(d.claude);

        const verdict = await s.stop('SIGTERM', { graceMs: 10 });

        expect(verdict.verified).toBe(false);
        if (!verdict.verified) expect(verdict.survivors.map((p) => p.pid)).toEqual([d.claude]);
    });
});

describe('a stopped run stops listening (hosting plan 1.4)', () => {
    it('output from the old driver after stop writes 0 rows to the thread and 1 notice', async () => {
        const t = processTable(SELF);
        const log: string[] = [];
        const d = claudeLike(t, log, { exitAfterMs: null, pidBase: 943_000 });
        const seen: StreamEvent[] = [];
        const s = sessionWith(t, d.factory, (e) => seen.push(e));
        s.start();
        await s.stop();
        const before = seen.length;

        // A straggler: the old provider is still talking after its run was ended.
        const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' } };
        d.emit().onUpdate?.(chunk);
        d.emit().onUpdate?.(chunk);
        d.emit().onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });

        const after = seen.slice(before);
        expect(after.filter((e) => e.kind === 'message')).toHaveLength(0);
        expect(after.filter((e) => e.kind === 'notice')).toHaveLength(1);
        expect(s.turnState).toBe('stopped');
    });
});

describe('restart waits for the verified end of the previous run (hosting plan 1.3)', () => {
    function hostWith(t: ReturnType<typeof processTable>, log: string[], exitAfterMs: number | null, graceMs = 5_000) {
        const dir = tempDir();
        let base = 950_000;
        const drivers: Array<ReturnType<typeof claudeLike>> = [];
        const driverFor: DriverFor = () => {
            const d = claudeLike(t, log, { exitAfterMs, pidBase: (base += 10) });
            drivers.push(d);
            return d.factory;
        };
        const host = new SessionHost({ userData: dir, driverFor, processTree: t.tree, stopGraceMs: graceMs });
        let record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'ws_example', provider: 'claude', name: 'atlas' }), threadId: THREAD };
        const ports = {
            registry: { find: () => record, clearThread: async () => { record = { ...record, threadId: null }; return record; } },
            host,
            cwdFor: () => dir,
        } as unknown as AgentOpsPorts;
        return { host, ports, record: () => record, dir, drivers };
    }

    it('a graceful restart starts the new provider only AFTER the old one exited (its exit lands 2 s late)', async () => {
        const t = processTable(SELF);
        const log: string[] = [];
        const h = hostWith(t, log, 2_000);
        expect(h.host.start(h.record(), h.dir)).toEqual({ ok: true });

        const result = await restartAgent(h.ports, h.record().id, 'graceful');

        expect(result).toMatchObject({ ok: true, kind: 'graceful' });
        const firstExit = log.indexOf('exit:950010:stdin closed');
        const secondStart = log.indexOf('start:950020');
        expect(firstExit).toBeGreaterThan(-1);
        expect(secondStart).toBeGreaterThan(firstExit);
        // Exactly one provider is alive afterwards.
        expect([h.drivers[0]!.claude, h.drivers[1]!.claude].filter((p) => t.alive(p))).toEqual([h.drivers[1]!.claude]);
    }, 10_000);

    it('a start while the previous run is still alive is REFUSED with the reason, and allowed once it is gone', async () => {
        const t = processTable(SELF);
        const log: string[] = [];
        const h = hostWith(t, log, null, 50);
        h.host.start(h.record(), h.dir);
        const first = h.drivers[0]!;
        t.unkillable(first.claude);
        h.host.stop(h.record().id);

        const verdict = await h.host.ended(h.record().id);
        expect(verdict?.verified).toBe(false);
        const refused = h.host.start(h.record(), h.dir);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.reason).toContain(String(first.claude));
        expect(h.drivers).toHaveLength(1);

        // It dies after all: the next start re-checks and goes ahead.
        t.killable(first.claude);
        t.exit(first.claude);
        expect(h.host.start(h.record(), h.dir)).toEqual({ ok: true });
        expect(h.drivers).toHaveLength(2);
    }, 10_000);

    it('a restart whose stop cannot be verified is refused, and no second provider starts', async () => {
        const t = processTable(SELF);
        const log: string[] = [];
        const h = hostWith(t, log, null, 50);
        h.host.start(h.record(), h.dir);
        t.unkillable(h.drivers[0]!.claude);

        const result = await restartAgent(h.ports, h.record().id, 'fresh');

        expect(result.ok).toBe(false);
        expect(h.drivers).toHaveLength(1);
    }, 15_000);
});

describe('the host reports every spawn and every end to its lifecycle port (the ledger, the log, the Deck)', () => {
    it('spawned with the run’s own processes; ended verified — or unverified, naming what is left', async () => {
        const t = processTable(SELF);
        const dir = tempDir();
        const log: string[] = [];
        const events: string[] = [];
        let base = 970_000;
        const drivers: Array<ReturnType<typeof claudeLike>> = [];
        const driverFor: DriverFor = () => { const d = claudeLike(t, log, { exitAfterMs: null, pidBase: (base += 10) }); drivers.push(d); return d.factory; };
        const host = new SessionHost({
            userData: dir, driverFor, processTree: t.tree, stopGraceMs: 10,
            lifecycle: {
                spawned: (id, run, processes) => events.push(`spawned ${run} ${processes.map((p) => `${p.pid}:${p.name}`).join(',')}`),
                ended: (id, run, verdict) => events.push(`ended ${run} ${verdict.verified ? 'verified' : `unverified ${verdict.survivors.map((p) => p.pid).join(',')}`}`),
                straggler: (id, run) => events.push(`straggler ${run}`),
            },
        });
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'ws_example', provider: 'claude', name: 'atlas' });

        host.start(record, dir);
        host.stop(record.id);
        await host.ended(record.id);
        host.start(record, dir);
        t.unkillable(drivers[1]!.claude);
        host.stop(record.id);
        await host.ended(record.id);

        expect(events).toEqual([
            'spawned 1 970010:cmd.exe,970011:claude.exe',
            'ended 1 verified',
            'spawned 2 970020:cmd.exe,970021:claude.exe',
            'ended 2 unverified 970021',
        ]);
    }, 10_000);
});

describe('an unverified stop is on the Deck, in words', () => {
    it('the main-error book titles it as a stop, not a crash', async () => {
        const { MainErrorBook } = await import('../src/core/main-errors.js');
        const book = new MainErrorBook({ now: () => 0 });
        book.record('stop-unverified', new Error('atlas: Still running after the stop: 970021(claude.exe).'));
        const [item] = book.deckItems();
        expect(item?.title).toBe('A stop could not be verified: atlas: Still running after the stop: 970021(claude.exe). Each step is in ~/.genie/runtime/lifecycle.log.');
    });
});
