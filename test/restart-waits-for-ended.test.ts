import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { DriverEvents, SessionDriver, SessionDriverFactory } from '../src/core/session.js';
import { restartAgent, switchDriver, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { sessionHostPort } from '../src/main/agent-ops-host-port.js';
import { restartWithHandoff } from '../src/main/restart-with-handoff.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { processTable } from './support/process-table.js';

/**
 * A RESTART BRINGS THE AGENT BACK (the owner's lifecycle.log, 2026-10-22):
 *
 *     16:18:05.418Z exit kind=agent owner=… (fancy) run=2 verified
 *     … no spawn until 16:18:19, when the owner clicked "Restart fancy and send";
 *     meanwhile a message showed "Not delivered. fancy is not running."
 *
 * `restartAgent` waits on `ports.host.ended` before it starts the next run, but the port main.ts built never passed
 * `ended` — so the wait was a no-op, Claude's stop grace (`STOP_GRACE_MS`) was still running when `start()` came, and the
 * start was refused ("still stopping") into `refusals` with nothing to retry it. The existing restart tests handed in a
 * whole `SessionHost` (which HAS `ended`), so they never saw the wiring. These drive the REAL host through the SAME port
 * main.ts builds (`sessionHostPort`).
 *
 * Every process table is a fake (test/support/process-table.ts); nothing on the machine is touched.
 */

const SELF = process.pid;
const THREAD = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c5d';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'genie2-restart-ended-')); dirs.push(d); return d; };

/** A Claude-like driver: closing stdin makes it exit `exitAfterMs` later — inside the host's stop grace. */
function claudeLike(t: ReturnType<typeof processTable>, log: string[], exitAfterMs: number, pidBase: number) {
    let events: DriverEvents = {};
    let exited = false;
    const cmd = pidBase, claude = pidBase + 1;
    const exit = (): void => {
        if (exited) return;
        exited = true;
        t.exit(claude); t.exit(cmd);
        log.push(`exit:${pidBase}`);
        events.onExit?.(0, null);
    };
    const factory: SessionDriverFactory = (o) => {
        events = o.events;
        const driver: SessionDriver & { endInput(): void } = {
            start: () => { t.spawn(cmd, SELF, 'cmd.exe'); t.spawn(claude, cmd, 'claude.exe'); log.push(`start:${pidBase}`); },
            prompt: () => {},
            endInput: () => { setTimeout(exit, exitAfterMs); },
            kill: () => { t.exit(cmd); t.exit(claude); exited = true; },
            get running() { return !exited; },
            cliSessionId: null,
        };
        return driver;
    };
    return factory;
}

/** The real SessionHost, behind the port main.ts builds, with a registry fake that keeps one record. */
function world(options: { cwdForRestart?: string; graceMs?: number; exitAfterMs?: number } = {}) {
    const t = processTable(SELF);
    const log: string[] = [];
    const dir = tempDir();
    let base = 960_000;
    const driverFor: DriverFor = () => claudeLike(t, log, options.exitAfterMs ?? 150, (base += 10));
    const host = new SessionHost({ userData: dir, driverFor, processTree: t.tree, stopGraceMs: options.graceMs ?? 2_000 });
    let record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'ws_example', provider: 'claude', name: 'fancy' }), threadId: THREAD };
    const ports = {
        registry: {
            find: (id: string) => (id === record.id ? record : null),
            clearThread: async () => { record = { ...record, threadId: null }; return record; },
            setProvider: async (_id: string, provider: AgentRecord['provider']) => { record = { ...record, provider }; return { ok: true, record }; },
        },
        host: sessionHostPort(() => host),
        cwdFor: () => options.cwdForRestart ?? dir,
        readManifest: async () => null,
    } as unknown as AgentOpsPorts;
    // Providers actually SPAWNED (a driver's start ran) — `driverFor` is asked before the host's folder check, so a refused
    // start can still have asked for a driver without running one.
    return { host, ports, record: () => record, dir, log, spawned: () => log.filter((l) => l.startsWith('start:')).length };
}

describe('restart through the port main.ts builds waits for the old run to end', () => {
    it('a graceful restart of a Claude agent inside its stop grace starts the new run, and leaves no refusal', async () => {
        const w = world();
        expect(w.host.start(w.record(), w.dir)).toEqual({ ok: true });

        const result = await restartAgent(w.ports, w.record().id, 'graceful');

        // Red before the fix: { ok: false, reason: '"fancy" is still stopping; it starts once its previous run has ended.' }
        expect(result).toEqual({ ok: true, kind: 'graceful' });
        expect(w.host.refusals.get(w.record().id)).toBeUndefined();
        expect(w.spawned()).toBe(2);
        expect(w.host.probe(w.record().id)?.running).toBe(true);
        // The new provider started only after the old one exited.
        expect(w.log.indexOf('start:960020')).toBeGreaterThan(w.log.indexOf('exit:960010'));
        w.host.stop(w.record().id, { graceful: false });
    }, 10_000);

    it('a fresh restart whose start is refused keeps the conversation, and says why', async () => {
        const missing = join(tmpdir(), `genie2-restart-ended-gone-${Date.now()}`);
        const w = world({ cwdForRestart: missing });
        expect(w.host.start(w.record(), w.dir)).toEqual({ ok: true });

        const result = await restartAgent(w.ports, w.record().id, 'fresh');

        expect(result.ok).toBe(false);
        // The start's own reason — the folder — not "still stopping": the restart waited for the old run first.
        if (!result.ok) expect(result.reason).toMatch(/the folder is not there/);
        // Nothing started, so nothing was discarded.
        expect(w.record().threadId).toBe(THREAD);
        expect(w.spawned()).toBe(1);
    }, 10_000);

    it('a fresh restart that goes ahead starts with no thread and clears the stored one', async () => {
        const w = world();
        expect(w.host.start(w.record(), w.dir)).toEqual({ ok: true });

        const result = await restartAgent(w.ports, w.record().id, 'fresh');

        expect(result).toEqual({ ok: true, kind: 'fresh', discarded: THREAD });
        expect(w.record().threadId).toBeNull();
        expect(w.spawned()).toBe(2);
        w.host.stop(w.record().id, { graceful: false });
    }, 10_000);
});

describe('the other stop-then-start paths wait too', () => {
    it('"Restart with this" (the handoff) inside the stop grace starts the agent and hands it the note', async () => {
        const w = world();
        expect(w.host.start(w.record(), w.dir)).toEqual({ ok: true });
        const fin = { id: 'fin_1', agentId: w.record().id, agentName: 'fancy', handoff: 'next: merge #50', at: 't', seen: false };
        const seen: string[] = [];

        // main.ts hands the real host in as the port (genie:restart-with-handoff).
        const result = await restartWithHandoff(w.host, { finished: () => [fin], markSeen: (id) => { seen.push(id); } }, w.record(), w.dir, 'fin_1');

        expect(result).toEqual({ ok: true });
        expect(w.host.refusals.get(w.record().id)).toBeUndefined();
        expect(w.spawned()).toBe(2);
        expect(seen).toEqual(['fin_1']);
        w.host.stop(w.record().id, { graceful: false });
    }, 10_000);

    it('a provider switch returns only once the old run has ended, so "Start it when ready" is true when it is said', async () => {
        const w = world();
        expect(w.host.start(w.record(), w.dir)).toEqual({ ok: true });

        const switched = await switchDriver(w.ports, w.record().id, 'codex');
        expect(switched).toMatchObject({ ok: true, from: 'claude', to: 'codex' });

        // The person presses Start straight away.
        const started = w.host.start(w.record(), w.dir);
        expect(started).toEqual({ ok: true });
        expect(w.host.refusals.get(w.record().id)).toBeUndefined();
        w.host.stop(w.record().id, { graceful: false });
    }, 10_000);
});
