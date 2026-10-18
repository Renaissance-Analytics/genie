import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { LIMIT_RESUME_PROMPT } from '../src/core/session.js';
import { RateLimitGate } from '../src/core/rate-limit-gate.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * ONE LIMIT, EVERY AGENT ON THAT LOGIN (Tynn #793, story #287). The owner, 2026-10-17: when a limit hits "you cannot
 * process anything else and everything dies… genie needs to detect that automatically… and then auto start back up a
 * little bit after the timer". Every Claude agent runs on the person's one Claude login, so one agent's breach holds
 * them all — and none on another provider. The gate (core/rate-limit-gate.ts) decides when the login opens; the host
 * holds and resumes the sessions, on a timer it is given (no polling).
 */
const MIN = 60_000;
let dir: string;
let now = Date.UTC(2026, 9, 17, 3, 0, 0);
let timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
const events = new Map<string, DriverEvents>();
const sent = new Map<string, unknown[]>();
const noTree: ProcessTree = { descendantsOf: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        events.set(record.name, options.events);
        sent.set(record.name, []);
        return { start: () => {}, prompt: (t) => { sent.get(record.name)!.push(t); }, kill: () => {}, get cliSessionId() { return null; } };
    };
    return factory;
};

let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-limit-host-'));
    now = Date.UTC(2026, 9, 17, 3, 0, 0);
    timers = [];
    events.clear();
    sent.clear();
    host = new SessionHost({
        userData: dir, driverFor, clock: () => now, processTree: noTree,
        rateLimit: {
            gate: new RateLimitGate({ marginMs: 2 * MIN }),
            schedule: (ms, fn) => { const t = { at: now + ms, fn, cleared: false }; timers.push(t); return () => { t.cleared = true; }; },
        },
    });
});
afterEach(async () => {
    host.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (name: string, provider: 'claude' | 'codex' = 'claude'): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider, name });
const rejected = (name: string, resetsAtMs: number) => events.get(name)!.onUpdate?.({
    sessionUpdate: 'notice', notice: { level: 'info', message: "You've hit your limit" },
    _meta: { 'particle.academy/rate_limit': { status: 'rejected', rateLimitType: 'five_hour', resetsAtMs, windows: { five_hour: { utilization: 1, resetsAtMs } }, raw: {} } },
});
const failTurn = (name: string) => events.get(name)!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution' });
/** Run every timer due by `now`, as the clock reaches it. */
const advanceTo = (t: number) => { now = t; for (const x of timers.filter((x) => !x.cleared && x.at <= t)) { x.cleared = true; x.fn(); } };

describe('one breach holds the whole login', () => {
    it('every Claude agent is held; a Codex agent is not; the probe says until when', () => {
        const a = record('atlas'); const b = record('wren'); const c = record('kai', 'codex');
        for (const r of [a, b, c]) expect(host.start(r, dir)).toEqual({ ok: true });
        host.prompt(a.id, 'build it', 'you');
        rejected('atlas', now + 60 * MIN);
        failTurn('atlas');
        expect(host.probe(a.id)?.limit).toMatchObject({ state: 'paused', resumeAtMs: now + 62 * MIN });
        expect(host.probe(b.id)?.limit).toMatchObject({ state: 'paused' });
        // wren did not hit it, but its login did: its prompt waits
        host.prompt(b.id, 'hello', 'you');
        expect(sent.get('wren')).toEqual([]);
        // CONTROL: codex is another login and keeps working
        expect(host.probe(c.id)?.limit).toEqual({ state: 'open' });
        host.prompt(c.id, 'go', 'you');
        expect(sent.get('kai')).toEqual(['go']);
    });

    it('an agent STARTED while its login is held is held from the start', () => {
        const a = record('atlas');
        host.start(a, dir);
        host.prompt(a.id, 'build it', 'you');
        rejected('atlas', now + 60 * MIN);
        failTurn('atlas');
        const late = record('late');
        host.start(late, dir);
        host.prompt(late.id, 'hi', 'you');
        expect(sent.get('late')).toEqual([]);
    });

    it('resumes ON ITS OWN at the reset plus the margin — not before — and every held agent goes on', () => {
        const a = record('atlas'); const b = record('wren');
        host.start(a, dir); host.start(b, dir);
        host.prompt(a.id, 'build it', 'you');
        rejected('atlas', now + 60 * MIN);
        failTurn('atlas');
        host.prompt(b.id, 'hello', 'you');
        const t0 = now;
        advanceTo(t0 + 61 * MIN); // inside the margin: nothing
        expect(sent.get('wren')).toEqual([]);
        expect(sent.get('atlas')).toEqual(['build it']);
        advanceTo(t0 + 62 * MIN);
        expect(sent.get('atlas')).toEqual(['build it', LIMIT_RESUME_PROMPT]);
        expect(sent.get('wren')).toEqual(['hello']);
        expect(host.probe(a.id)?.limit).toEqual({ state: 'open' });
    });

    it('Resume now opens the login at once and resumes its agents; the timer then does nothing', () => {
        const a = record('atlas');
        host.start(a, dir);
        host.prompt(a.id, 'build it', 'you');
        rejected('atlas', now + 60 * MIN);
        failTurn('atlas');
        host.resumeLimit('claude');
        expect(sent.get('atlas')).toEqual(['build it', LIMIT_RESUME_PROMPT]);
        advanceTo(now + 62 * MIN);
        expect(sent.get('atlas')).toEqual(['build it', LIMIT_RESUME_PROMPT]);
    });
});

/**
 * A TURN THAT FAILED ON THE LIMIT WITH NO READING (Tynn #791, prism-acp 0.18.0 `failure.kind: 'rate_limit'`). The gate
 * has no reset to wait for, so the login is held and tried again on the gate's STATED backoff — never a guessed reset.
 */
describe('a breach the turn reported itself', () => {
    const failOnLimit = (name: string) => events.get(name)!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind: 'rate_limit', reason: 'rate_limit' } });

    it('holds the whole login, retries on the first backoff step, and every held agent goes on then', () => {
        const a = record('atlas'); const b = record('wren'); const c = record('kai', 'codex');
        for (const r of [a, b, c]) host.start(r, dir);
        host.prompt(a.id, 'build it', 'you');
        failOnLimit('atlas');
        expect(host.probe(a.id)?.limit).toMatchObject({ state: 'retrying', nextTryAtMs: now + 15 * MIN, attempt: 1 });
        host.prompt(b.id, 'hello', 'you');
        expect(sent.get('wren')).toEqual([]);
        // CONTROL: codex is another login
        expect(host.probe(c.id)?.limit).toEqual({ state: 'open' });
        const t0 = now;
        advanceTo(t0 + 14 * MIN);
        expect(sent.get('wren')).toEqual([]);
        advanceTo(t0 + 15 * MIN);
        expect(sent.get('atlas')).toEqual(['build it', LIMIT_RESUME_PROMPT]);
        expect(sent.get('wren')).toEqual(['hello']);
    });

    it('CONTROL: a turn that failed for another reason holds nobody', () => {
        const a = record('atlas'); const b = record('wren');
        host.start(a, dir); host.start(b, dir);
        host.prompt(a.id, 'build it', 'you');
        events.get('atlas')!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind: 'overloaded', reason: 'overloaded' } });
        expect(host.probe(a.id)?.limit).toEqual({ state: 'open' });
        host.prompt(b.id, 'hello', 'you');
        expect(sent.get('wren')).toEqual(['hello']);
    });
});
