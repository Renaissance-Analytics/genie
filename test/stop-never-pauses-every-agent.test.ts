import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, CANCEL_STATE_UNCERTAIN, LIMIT_RESUME_PROMPT, type DriverEvents, type SessionDriverFactory, type TurnOutcomeLike } from '../src/core/session.js';
import { RateLimitGate } from '../src/core/rate-limit-gate.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { processTable } from './support/process-table.js';

/*
 * Tynn #556. The owner, live on beta.60 (b-mo-fluid, 2026-11-08 19:30Z): a Stop during a long Bash tool could not be
 * confirmed, so the driver ended the CLI. The turns still queued in that run ended "crashed", one of them was read as a
 * rate-limit hit, and that one breach held EVERY Claude agent for 15 minutes; the restart came up held without a word;
 * and the tool's shell kept running under the dead CLI.
 */
const MIN = 60_000;
let dir: string;
let now = Date.UTC(2026, 10, 8, 19, 0, 0);
let timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
const events = new Map<string, DriverEvents>();
const sent = new Map<string, unknown[]>();
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        events.set(record.name, options.events);
        sent.set(record.name, []);
        return { start: () => {}, prompt: (t) => { sent.get(record.name)!.push(t); }, cancel: () => Promise.resolve(), kill: () => {}, get cliSessionId() { return null; } };
    };
    return factory;
};
let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-stop-limit-'));
    now = Date.UTC(2026, 10, 8, 19, 0, 0);
    timers = []; events.clear(); sent.clear();
    host = new SessionHost({
        userData: dir, driverFor, clock: () => now, processTree: noTree,
        rateLimit: { gate: new RateLimitGate({ marginMs: 2 * MIN }), schedule: (ms, fn) => { const t = { at: now + ms, fn, cleared: false }; timers.push(t); return () => { t.cleared = true; }; } },
    });
});
afterEach(async () => { host.stopAll(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const record = (name: string): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name });
const advanceTo = (t: number) => { now = t; for (const x of timers.filter((x) => !x.cleared && x.at <= t)) { x.cleared = true; x.fn(); } };
/** What a CLI that is killed mid-turn can report: crashed, and (unproven which) classed as a rate limit. */
const DIED_AS_LIMIT: TurnOutcomeLike = { stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind: 'rate_limit', reason: 'rate_limit' } };
const rejected = (name: string, resetsAtMs: number) => events.get(name)!.onUpdate?.({
    sessionUpdate: 'notice', notice: { level: 'info', message: "You've hit your limit" },
    _meta: { 'particle.academy/rate_limit': { status: 'rejected', rateLimitType: 'five_hour', resetsAtMs, windows: { five_hour: { utilization: 1, resetsAtMs } }, raw: {} } },
});
const notices = (id: AgentRecord['id']) => host.rowsFor(id).map((r) => r.event).flatMap((e) => (e.kind === 'notice' ? [e.message] : []));

describe('a turn ended by a Stop is never a rate-limit hit', () => {
    it('the driver ending its CLI after an unconfirmed Stop pauses nobody, and says nothing about a limit', async () => {
        const a = record('atlas'), b = record('wren');
        host.start(a, dir); host.start(b, dir);
        host.prompt(a.id, 'run the suites', 'you');
        host.prompt(a.id, 'You have 1 unread AgentInbox message', 'genie'); // taken mid-turn
        expect(host.cancel(a.id)).toEqual({ ok: true });
        events.get('atlas')!.onProtocolError?.(CANCEL_STATE_UNCERTAIN, { recoverable: false });
        events.get('atlas')!.onTurnEnd?.(DIED_AS_LIMIT);
        events.get('atlas')!.onTurnEnd?.(DIED_AS_LIMIT);
        await host.settled();
        expect(host.probe(a.id)?.limit).toEqual({ state: 'open' });
        expect(host.probe(b.id)?.limit).toEqual({ state: 'open' });
        expect(host.prompt(b.id, 'hello', 'you')).toBe(true);
        expect(sent.get('wren')).toEqual(['hello']);
        expect(notices(a.id).filter((m) => /rate limit/i.test(m))).toEqual([]);
    });

    it('a CLI that dies while its Stop is pending is stopped, not limited', async () => {
        const a = record('atlas'), b = record('wren');
        host.start(a, dir); host.start(b, dir);
        host.prompt(a.id, 'run the suites', 'you');
        expect(host.cancel(a.id)).toEqual({ ok: true });
        events.get('atlas')!.onTurnEnd?.(DIED_AS_LIMIT);
        await host.settled();
        expect(host.probe(a.id)?.limit).toEqual({ state: 'open' });
        expect(host.probe(a.id)?.turnState).not.toBe('failed');
        host.prompt(b.id, 'hello', 'you');
        expect(sent.get('wren')).toEqual(['hello']);
    });

    it('CONTROL: the same failure with no Stop is a limit hit on that agent', async () => {
        const a = record('atlas');
        host.start(a, dir);
        host.prompt(a.id, 'run the suites', 'you');
        events.get('atlas')!.onTurnEnd?.(DIED_AS_LIMIT);
        await host.settled();
        expect(host.probe(a.id)?.limit).toMatchObject({ state: 'retrying', attempt: 1 });
        expect(notices(a.id).some((m) => /rate limit/i.test(m))).toBe(true);
    });
});

describe("one agent's breach holds only that agent unless the provider's reading says the login is limited", () => {
    it('a breach with no reading holds the agent that hit it; the others keep working, and one started now is not held', async () => {
        const a = record('atlas'), b = record('wren');
        host.start(a, dir); host.start(b, dir);
        host.prompt(a.id, 'build it', 'you');
        events.get('atlas')!.onTurnEnd?.(DIED_AS_LIMIT);
        expect(host.probe(a.id)?.limit).toMatchObject({ state: 'retrying', nextTryAtMs: now + 15 * MIN });
        host.prompt(a.id, 'next', 'you');
        expect(sent.get('atlas')).toEqual(['build it']);
        expect(host.probe(b.id)?.limit).toEqual({ state: 'open' });
        host.prompt(b.id, 'hello', 'you');
        expect(sent.get('wren')).toEqual(['hello']);
        const late = record('late');
        host.start(late, dir);
        host.prompt(late.id, 'hi', 'you');
        expect(sent.get('late')).toEqual(['hi']);
        // The held agent still goes on by itself at the backoff.
        advanceTo(now + 15 * MIN);
        expect(sent.get('atlas')!.length).toBeGreaterThan(1);
    });

    it("CONTROL: the provider's reading that the login is limited still holds every agent on it", () => {
        const a = record('atlas'), b = record('wren');
        host.start(a, dir); host.start(b, dir);
        host.prompt(a.id, 'build it', 'you');
        rejected('atlas', now + 60 * MIN);
        events.get('atlas')!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution' });
        host.prompt(b.id, 'hello', 'you');
        expect(sent.get('wren')).toEqual([]);
        expect(host.probe(b.id)?.limit).toMatchObject({ state: 'paused' });
        advanceTo(now + 62 * MIN);
        expect(sent.get('wren')).toEqual(['hello']);
        expect(sent.get('atlas')).toEqual(['build it', LIMIT_RESUME_PROMPT]);
    });
});

describe('a restart that comes up held says why and until when', () => {
    it('an agent started while its login is limited says so, with when it resumes', async () => {
        const a = record('atlas');
        host.start(a, dir);
        host.prompt(a.id, 'build it', 'you');
        rejected('atlas', now + 60 * MIN);
        events.get('atlas')!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution' });
        const late = record('late');
        host.start(late, dir);
        await host.settled();
        const said = notices(late.id).filter((m) => /rate limit/i.test(m));
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/resumes in 1h 2m/);
    });

    it('CONTROL: an agent started on an open login says nothing about a limit', async () => {
        const late = record('late');
        host.start(late, dir);
        await host.settled();
        expect(notices(late.id).filter((m) => /rate limit/i.test(m))).toEqual([]);
    });
});

/*
 * THE TOOL'S PROCESSES (Tynn #556): the driver's own kill after an unconfirmed Stop ends the CLI only; a Bash tool under
 * it lives on with a dead parent. Genie reads the run's tree when the Stop is asked, and ends and verifies what is left.
 */
const tdirs: string[] = [];
afterAll(() => { for (const d of tdirs) rmSync(d, { recursive: true, force: true }); });
const SELF = process.pid, CMD = 920_001, CLI = 920_002, BASH = 920_003, PHP = 920_004, OTHER = 920_100, OTHER_TOOL = 920_101;

function toolWorld() {
    const t = processTable(SELF);
    t.spawn(OTHER, SELF, 'claude.exe'); t.spawn(OTHER_TOOL, OTHER, 'bash.exe'); // another agent, mid-tool
    let ev!: DriverEvents;
    const factory: SessionDriverFactory = (options) => {
        ev = options.events;
        return { start: () => { t.spawn(CMD, SELF, 'prism-acp-supervisor.exe'); t.spawn(CLI, CMD, 'claude.exe'); }, prompt: () => {}, cancel: () => Promise.resolve(), kill: () => { t.exit(CMD); }, cliSessionId: null };
    };
    const d = mkdtempSync(join(tmpdir(), 'genie2-stop-tools-')); tdirs.push(d);
    const rows: StreamEvent[] = [];
    const s = new AgentSession({ agentId: mintAgentId(), cwd: d, store: openDurableStore(d), driverFactory: factory, processTree: t.tree, onEvent: (e) => { rows.push(e); } });
    s.start();
    s.prompt('run the suites', 'you');
    t.spawn(BASH, CLI, 'bash.exe'); t.spawn(PHP, BASH, 'php.exe'); // the tool, started after the spawn
    return { t, s, rows, ev: () => ev };
}

describe("Stop ends and verifies the stopped tool's processes", () => {
    it('the driver ending its CLI leaves no tool process running, and the chat says what was ended', async () => {
        const w = toolWorld();
        expect(w.s.cancel('you')).toEqual({ ok: true });
        await Promise.resolve();
        w.t.exit(CLI); // the driver's own kill: the CLI only
        w.ev().onProtocolError?.(CANCEL_STATE_UNCERTAIN, { recoverable: false });
        await vi.waitFor(() => { expect(w.t.alive(BASH)).toBe(false); expect(w.t.alive(PHP)).toBe(false); });
        await vi.waitFor(() => expect(w.rows.some((r) => r.kind === 'notice' && /bash\.exe/.test(r.message) && /php\.exe/.test(r.message))).toBe(true));
        // CONTROL, same run: another agent's CLI and tool are untouched.
        expect(w.t.alive(OTHER)).toBe(true); expect(w.t.alive(OTHER_TOOL)).toBe(true);
        expect(w.t.killsOf(OTHER) + w.t.killsOf(OTHER_TOOL)).toBe(0);
    });

    it('CONTROL: a confirmed Stop leaves the running CLI and its tools to the CLI', async () => {
        const w = toolWorld();
        expect(w.s.cancel('you')).toEqual({ ok: true });
        w.ev().onTurnEnd?.({ stopReason: 'cancelled', isError: false, raw: 'cancelled' });
        await new Promise((r) => setTimeout(r, 20));
        expect(w.t.kills()).toEqual([]);
    });
});
