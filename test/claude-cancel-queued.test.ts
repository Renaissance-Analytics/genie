import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, CANCEL_STATE_UNCERTAIN, CANCEL_STATE_UNCERTAIN_CODE, type DriverEvents, type SessionDriver, type SessionDriverFactory, type TurnOutcomeLike } from '../src/core/session.js';
import { restartAgent, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { sessionHostPort } from '../src/main/agent-ops-host-port.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { NEW_DRIVER_NOTICE, startForYourMessage } from '../src/main/start-on-demand.js';

/**
 * STOP MEANS STOP, CLAUDE HALF (genie#1565, prism-acp 0.37.0). `ClaudeDriver.cancel()` now sends `cancel_queued: true`:
 * a prompt Genie handed Claude mid-turn (an inbox notice, the person's next message) is DROPPED by the Stop instead of
 * running after it. Each dropped prompt ends on its own, after the stopped turn, `stopReason: 'cancelled'`, raw
 * `dropped by cancel`. Before 0.37.0 Claude ran it, and Genie opened its turn at the stopped turn's end.
 *
 * And when Claude's cancel receipt is missing or inconsistent, prism-acp ends every unfinished prompt cancelled (raw
 * `cancel accounting mismatch`), says `cancel state uncertain; driver stopped` and stops the CLI; that driver never takes
 * a prompt again (`ClaudeCancelStateError`). The person's next message must start a new driver on the same conversation
 * — through the one Restart (genie#1238) — and be delivered, and the chat says why.
 *
 * Stub drivers shaped like prism-acp 0.37.0's ClaudeDriver: they take a prompt mid-turn, and their turn ends are fired by
 * the test in prism's order (the stopped turn first, then each dropped prompt, in submission order).
 */

const NOTICE = 'You have 1 unread AgentInbox message; collect it with agentinbox receive.';
const CANCELLED: TurnOutcomeLike = { stopReason: 'cancelled', isError: false, raw: 'cancelled' };
const DROPPED: TurnOutcomeLike = { stopReason: 'cancelled', isError: false, raw: 'dropped by cancel' };
const MISMATCH: TurnOutcomeLike = { stopReason: 'cancelled', isError: false, raw: 'cancel accounting mismatch' };

describe('AgentSession — a prompt Claude dropped at the person’s Stop', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-cancel-queued-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

    function session() {
        const prompts: unknown[] = [];
        const calls = { cancels: 0, kills: 0 };
        let events: DriverEvents = {};
        const factory: SessionDriverFactory = (options) => {
            events = options.events;
            const driver: SessionDriver = {
                start: () => {},
                prompt: (content) => { prompts.push(content); },
                cancel: () => { calls.cancels += 1; return Promise.resolve(); },
                kill: () => { calls.kills += 1; },
                get running() { return true; },
                get cliSessionId() { return null; },
            };
            return driver;
        };
        const rows: StreamEvent[] = [];
        const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
        const s = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: tree, onEvent: (e) => { rows.push(e); } });
        const order = () => rows.flatMap((r) => (r.kind === 'turn' ? [`turn ${r.n} by ${r.by}`] : r.kind === 'stopped' ? [`stopped ${r.n} by ${r.by}`] : []));
        return { s, prompts, calls, rows, order, endTurn: (o: TurnOutcomeLike) => events.onTurnEnd?.(o) };
    }

    it('a Genie notice taken mid-turn and dropped by the Stop records its cancelled end and starts nothing', async () => {
        const { s, prompts, calls, order, endTurn } = session();
        s.start();
        s.prompt('work', 'you');
        // Claude takes it mid-turn (folded), as the inbox push hands it over.
        expect(s.deliver(NOTICE, 'genie', null, { retold: true })).toBeNull();
        expect(prompts).toEqual(['work', NOTICE]);

        expect(s.cancel()).toEqual({ ok: true });
        endTurn(CANCELLED);
        endTurn(DROPPED);
        await Promise.resolve();

        expect(prompts).toEqual(['work', NOTICE]);
        expect(s.inTurn).toBe(false);
        expect(s.turnState).toBe('idle');
        expect(s.lastTurnEnd).toBe('stopped');
        expect(s.stoppedByYou).toBe(true);
        // One turn, stopped once, by the person — no turn for the dropped notice, and no second `stopped` row for it.
        expect(order()).toEqual(['turn 1 by you', 'stopped 1 by you']);
        expect(calls).toEqual({ cancels: 1, kills: 0 });
    });

    it('the person’s OWN message taken mid-turn and dropped by their Stop still goes, as its own turn (genie#1143), shown once', async () => {
        const { s, prompts, rows, order, endTurn } = session();
        s.start();
        s.prompt('work', 'you');
        s.prompt('also do this', 'you');
        expect(s.cancel()).toEqual({ ok: true });
        endTurn(CANCELLED);
        endTurn(DROPPED);
        await Promise.resolve();

        expect(prompts).toEqual(['work', 'also do this', 'also do this']);
        expect(s.inTurn).toBe(true);
        expect(s.turnState).toBe('working');
        expect(s.stoppedByYou).toBe(false);
        expect(order()).toEqual(['turn 1 by you', 'stopped 1 by you', 'turn 2 by you']);
        expect(rows.filter((r) => r.kind === 'message' && r.text === 'also do this')).toHaveLength(1);
    });
});

describe('SessionHost — Claude’s cancel state uncertain: the person’s next message starts a new driver', () => {
    const THREAD = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c5d';
    let dir: string;
    const hosts: SessionHost[] = [];
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-cancel-uncertain-')); });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    interface Driver { prompts: unknown[]; cancels: number; events: DriverEvents; uncertain: () => void }
    function world() {
        const drivers: Driver[] = [];
        const resumedWith: Array<string | null> = [];
        let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
        const tree: ProcessTree = {
            snapshot: () => [...processes],
            killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
        };
        const driverFor: DriverFor = (_agent, _cwd, resume) => {
            resumedWith.push(resume);
            return ({ events }) => {
                const pid = process.pid + 1_000_000 + drivers.length + 1;
                let stopped = false;
                let running = false;
                const d: Driver = {
                    prompts: [], cancels: 0, events,
                    // prism-acp 0.37.0's #cancelMismatch, in its order: the error, the unfinished prompts' ends, the CLI's exit.
                    uncertain: () => {
                        stopped = true;
                        events.onProtocolError?.(CANCEL_STATE_UNCERTAIN, { recoverable: false });
                        events.onTurnEnd?.(MISMATCH);
                        running = false;
                        processes = processes.filter((p) => p.pid !== pid);
                        events.onExit?.(null, 'SIGTERM');
                    },
                };
                drivers.push(d);
                const driver: SessionDriver = {
                    start: () => { running = true; processes.push({ pid, ppid: process.pid, started: 3, name: 'claude-fixture' }); },
                    prompt: (content) => {
                        if (stopped) throw Object.assign(new Error(CANCEL_STATE_UNCERTAIN), { name: 'ClaudeCancelStateError', code: CANCEL_STATE_UNCERTAIN_CODE });
                        d.prompts.push(content);
                    },
                    cancel: () => { d.cancels += 1; return Promise.resolve(); },
                    kill: () => { running = false; processes = processes.filter((p) => p.pid !== pid); },
                    get running() { return running; },
                    get cliSessionId() { return THREAD; },
                };
                return driver;
            };
        };
        const host = new SessionHost({ userData: dir, driverFor, processTree: tree, stopGraceMs: 0 });
        hosts.push(host);
        const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'atlas' }), threadId: THREAD };
        const ops = {
            registry: { find: (id: string) => (id === record.id ? record : null), clearThread: async () => record },
            host: sessionHostPort(() => host),
            cwdFor: () => dir,
            startRefusal: () => null,
        } as unknown as AgentOpsPorts;
        const restarts: string[] = [];
        const ports = {
            probe: (id: AgentRecord['id']) => host.probe(id),
            start: (r: AgentRecord, cwd: string) => host.start(r, cwd),
            cwdFor: () => dir,
            startRefusal: () => null,
            needsNewDriver: (id: AgentRecord['id']) => host.needsNewDriver(id),
            restart: (id: AgentRecord['id']) => { restarts.push(id); return restartAgent(ops, id, 'graceful'); },
            notice: (id: AgentRecord['id'], message: string) => host.notice(id, message),
        };
        return { host, record, drivers, resumedWith, ports, restarts };
    }

    it('after the uncertain cancel, the next message from the person starts a NEW driver on the same conversation, is delivered, and the chat says why', async () => {
        const w = world();
        expect(w.host.start(w.record, dir)).toEqual({ ok: true });
        expect(w.host.prompt(w.record.id, 'work', 'you')).toBe(true);
        expect(w.host.cancel(w.record.id)).toEqual({ ok: true });
        w.drivers[0]!.uncertain();
        await w.host.settled();

        // Not stuck: the run is over, said once, and it is not painted Broken.
        expect(w.host.needsNewDriver(w.record.id)).toBe(true);
        expect(w.host.probe(w.record.id)?.running).toBe(false);
        expect(w.host.probe(w.record.id)?.turnState).not.toBe('failed');

        expect(await startForYourMessage(w.ports, w.record)).toEqual({ ok: true, started: true });
        expect(w.host.prompt(w.record.id, 'carry on', 'you')).toBe(true);

        expect(w.restarts).toEqual([w.record.id]);
        expect(w.drivers).toHaveLength(2);
        expect(w.resumedWith).toEqual([THREAD, THREAD]);
        expect(w.drivers[0]!.prompts).toEqual(['work']);
        await vi.waitFor(() => expect(w.drivers[1]!.prompts).toEqual(['carry on']));
        expect(w.host.needsNewDriver(w.record.id)).toBe(false);
        const notices = w.host.rowsFor(w.record.id).map((r) => r.event).filter((e) => e.kind === 'notice' && e.message === NEW_DRIVER_NOTICE);
        expect(notices).toHaveLength(1);
    });

    it('a message the person sent mid-turn that the uncertain cancel ended is kept, and the new driver gets it before their next one', async () => {
        const w = world();
        expect(w.host.start(w.record, dir)).toEqual({ ok: true });
        expect(w.host.prompt(w.record.id, 'work', 'you')).toBe(true);
        expect(w.host.prompt(w.record.id, 'also do this', 'you')).toBe(true);
        expect(w.host.cancel(w.record.id)).toEqual({ ok: true });
        // Both prompts end `cancel accounting mismatch`: the stopped one, then the one taken mid-turn.
        const d = w.drivers[0]!;
        d.events.onProtocolError?.(CANCEL_STATE_UNCERTAIN, { recoverable: false });
        d.events.onTurnEnd?.(MISMATCH);
        d.events.onTurnEnd?.(MISMATCH);
        d.events.onExit?.(null, 'SIGTERM');
        await w.host.settled();

        expect(await startForYourMessage(w.ports, w.record)).toEqual({ ok: true, started: true });
        expect(w.host.prompt(w.record.id, 'carry on', 'you')).toBe(true);
        await vi.waitFor(() => expect(w.drivers[1]?.prompts).toEqual(['also do this', 'carry on']));
    });

    it('CONTROL — a normal cancel keeps the SAME driver: no restart, no notice, the next message goes to it', async () => {
        const w = world();
        expect(w.host.start(w.record, dir)).toEqual({ ok: true });
        expect(w.host.prompt(w.record.id, 'work', 'you')).toBe(true);
        expect(w.host.cancel(w.record.id)).toEqual({ ok: true });
        w.drivers[0]!.events.onTurnEnd?.(CANCELLED);
        await w.host.settled();

        expect(w.host.needsNewDriver(w.record.id)).toBe(false);
        expect(await startForYourMessage(w.ports, w.record)).toEqual({ ok: true, started: false });
        expect(w.host.prompt(w.record.id, 'carry on', 'you')).toBe(true);
        expect(w.restarts).toEqual([]);
        expect(w.drivers).toHaveLength(1);
        expect(w.drivers[0]!.prompts).toEqual(['work', 'carry on']);
        expect(w.host.rowsFor(w.record.id).map((r) => r.event).filter((e) => e.kind === 'notice' && e.message === NEW_DRIVER_NOTICE)).toEqual([]);
    });
});
