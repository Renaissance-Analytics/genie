import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { RateLimitGate } from '../src/core/rate-limit-gate.js';
import { LIMIT_RESUME_PROMPT, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A NO-RESET RETRY THAT FIRED IS OVER (genie#1195; found by tynn-slave reading the source, 2026-10-26; the owner: "codex
 * agents don't auto resume after their rate limit clears"). A turn that ends on its limit with NO reading is retried on
 * the gate's backoff. When that retry fired, the gate let the login go but kept its retry — so it still SAID "retrying"
 * with a time already past. Two things followed:
 *   1. the host's wake re-armed that past time at once (0 ms in production) — forever;
 *   2. an ALLOWED reading arriving then (Codex's, the limit lifted) found the login "not open" and held the session
 *      again, but the gate no longer counted the login held, so nothing ever let it go: every later prompt queued.
 * And a successful turn never told the gate (`ok` was never called), so the backoff never reset.
 *
 * The clock here runs timers ARMED WHILE IT RUNS (bounded): a production 0 ms re-arm is a loop, which a one-pass clock
 * would hide.
 */
const MIN = 60_000;
let dir: string;
let now = Date.UTC(2026, 9, 26, 3, 0, 0);
let timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
const events = new Map<string, DriverEvents>();
const sent = new Map<string, unknown[]>();
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

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
    dir = await mkdtemp(join(tmpdir(), 'genie2-limit-retry-'));
    now = Date.UTC(2026, 9, 26, 3, 0, 0);
    timers = [];
    events.clear();
    sent.clear();
    host = new SessionHost({
        userData: dir, driverFor, clock: () => now, processTree: noTree,
        rateLimit: {
            gate: new RateLimitGate({ marginMs: 2 * MIN }),
            // As production: a delay at or below 0 runs at once (setTimeout clamps it).
            schedule: (ms, fn) => { const t = { at: now + Math.max(0, ms), fn, cleared: false }; timers.push(t); return () => { t.cleared = true; }; },
        },
    });
});
afterEach(async () => {
    host.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/** Move the clock to `t`, running every timer due by then — INCLUDING those armed while running. Returns how many ran. */
const advanceTo = (t: number): number => {
    now = t;
    let ran = 0;
    for (;;) {
        const due = timers.filter((x) => !x.cleared && x.at <= t);
        if (due.length === 0) return ran;
        for (const x of due) { x.cleared = true; x.fn(); ran += 1; }
        if (ran > 50) return ran; // a loop: say so instead of hanging the suite
    }
};
const liveTimers = () => timers.filter((x) => !x.cleared);

const codexRecord = (name: string): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name });
const failOnLimit = (name: string) => events.get(name)!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'usageLimitExceeded', failure: { kind: 'rate_limit', reason: 'rate_limit' } });
const replied = (name: string) => {
    events.get(name)!.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
    events.get(name)!.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
};
/** Codex's account/rateLimits: both windows under 100% — the limit has lifted. */
const allowedReading = (name: string) => events.get(name)!.onUpdate?.({
    sessionUpdate: 'notice', notice: { level: 'info', message: 'Codex rate limit: 3% used' },
    _meta: { 'particle.academy/rate_limit': { primary: { usedPercent: 3, windowDurationMins: 300, resetsAtMs: now + 300 * MIN }, secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAtMs: now + 7 * 1440 * MIN } } },
});

describe('a no-reset retry, once it has fired', () => {
    it('resumes EXACTLY once, and leaves no timer at or before now (no 0 ms wake loop)', () => {
        const a = codexRecord('kai');
        host.start(a, dir);
        host.prompt(a.id, 'build it', 'you');
        failOnLimit('kai');
        expect(host.probe(a.id)?.limit).toMatchObject({ state: 'retrying', attempt: 1, nextTryAtMs: now + 15 * MIN });
        const ran = advanceTo(now + 15 * MIN);
        expect(ran).toBeLessThanOrEqual(2);
        expect(sent.get('kai')).toEqual(['build it', LIMIT_RESUME_PROMPT]);
        expect(liveTimers().every((x) => x.at > now)).toBe(true);
        // The retry is in flight: nothing is held, so nothing says "retrying" with a past time.
        expect(host.probe(a.id)?.limit).toEqual({ state: 'open' });
    });

    it('an ALLOWED reading then does not hold the agent again: the next prompt reaches the provider', () => {
        const a = codexRecord('kai');
        host.start(a, dir);
        host.prompt(a.id, 'build it', 'you');
        failOnLimit('kai');
        advanceTo(now + 15 * MIN);
        allowedReading('kai');
        replied('kai');
        host.prompt(a.id, 'next thing', 'you');
        expect(sent.get('kai')).toEqual(['build it', LIMIT_RESUME_PROMPT, 'next thing']);
        expect(host.probe(a.id)?.limit).toEqual({ state: 'open' });
    });

    it('a successful turn ends the backoff: the next breach starts again at its FIRST step', () => {
        const a = codexRecord('kai');
        host.start(a, dir);
        host.prompt(a.id, 'build it', 'you');
        failOnLimit('kai');
        advanceTo(now + 15 * MIN);
        replied('kai');
        host.prompt(a.id, 'again', 'you');
        failOnLimit('kai');
        expect(host.probe(a.id)?.limit).toMatchObject({ state: 'retrying', attempt: 1, nextTryAtMs: now + 15 * MIN });
    });

    it('CONTROL: the retried turn failing on the limit AGAIN takes the next backoff step', () => {
        const a = codexRecord('kai');
        host.start(a, dir);
        host.prompt(a.id, 'build it', 'you');
        failOnLimit('kai');
        advanceTo(now + 15 * MIN);
        failOnLimit('kai');
        expect(host.probe(a.id)?.limit).toMatchObject({ state: 'retrying', attempt: 2, nextTryAtMs: now + 30 * MIN });
    });
});
