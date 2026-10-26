import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexDriver } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { RateLimitGate } from '../src/core/rate-limit-gate.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A HELD CODEX LOGIN IS READ AGAIN WHILE IT WAITS (genie#1195; the owner, 2026-10-26: "codex agents don't auto resume
 * after their rate limit clears"). Codex states a reset for its 7-day window, but the limit lifted ~5 days early in the
 * owner's own threads — and a held login is never read again: prism-acp's CodexDriver read its limits only at start and
 * during turns, and a held session runs no turn. prism-acp 0.26.0's `readRateLimits()` reads them on the live session with
 * no turn and answers through the SAME `_meta` path as the start-up read; it never rejects. So while a login is held, Genie
 * asks ONE of its running sessions to read every 15 minutes, and the answer decides — an allowed reading resumes it.
 */
const MIN = 60_000;
let dir: string;
let now = Date.UTC(2026, 9, 26, 3, 0, 0);
let timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
const events = new Map<string, DriverEvents>();
const sent = new Map<string, unknown[]>();
const reads = new Map<string, number>();
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

/** Codex's account/rateLimits, as prism-acp emits it under particle.academy/rate_limit. */
const codexReading = (name: string, usedPercent: number) => events.get(name)!.onUpdate?.({
    sessionUpdate: 'notice', notice: { level: 'info', message: `Codex rate limit: ${usedPercent}% used` },
    _meta: { 'particle.academy/rate_limit': {
        primary: { usedPercent: 3, windowDurationMins: 300, resetsAtMs: now + 300 * MIN },
        secondary: { usedPercent, windowDurationMins: 10080, resetsAtMs: now + 5 * 1440 * MIN },
    } },
});

/** What the provider answers when asked to read: set per test; `null` = the read reports nothing. */
let answer: ((name: string) => void) | null = null;

const driverFor = (canRead: boolean): DriverFor => (record) => {
    const factory: SessionDriverFactory = (options) => {
        events.set(record.name, options.events);
        sent.set(record.name, []);
        reads.set(record.name, 0);
        return {
            start: () => {}, prompt: (t) => { sent.get(record.name)!.push(t); }, kill: () => {}, get cliSessionId() { return null; },
            ...(canRead ? { readRateLimits: async () => { reads.set(record.name, reads.get(record.name)! + 1); answer?.(record.name); } } : {}),
        };
    };
    return factory;
};

let host: SessionHost;
const makeHost = (canRead = true) => {
    host = new SessionHost({
        userData: dir, driverFor: driverFor(canRead), clock: () => now, processTree: noTree,
        rateLimit: {
            gate: new RateLimitGate({ marginMs: 2 * MIN }),
            schedule: (ms, fn) => { const t = { at: now + Math.max(0, ms), fn, cleared: false }; timers.push(t); return () => { t.cleared = true; }; },
        },
    });
};
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-limit-reread-'));
    now = Date.UTC(2026, 9, 26, 3, 0, 0);
    timers = [];
    answer = null;
    events.clear();
    sent.clear();
    reads.clear();
});
afterEach(async () => {
    host.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/** Move the clock to `t`, running every timer due by then — including those armed while running (bounded). */
const advanceTo = (t: number): void => {
    for (let ran = 0; ran < 200;) {
        const next = timers.filter((x) => !x.cleared && x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = Math.max(now, next.at);
        next.cleared = true;
        next.fn();
        ran += 1;
    }
    now = t;
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const codex = (name: string): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name });

/** A Codex agent whose login is held on a 7-day window Codex says resets in 5 days, with a prompt waiting. */
function heldOnTheWeek(name = 'kai'): AgentRecord {
    const a = codex(name);
    host.start(a, dir);
    codexReading(name, 100);
    host.prompt(a.id, 'build it', 'you');
    expect(host.probe(a.id)?.limit).toMatchObject({ state: 'paused', window: 'secondary' });
    expect(sent.get(name)).toEqual([]);
    return a;
}

describe('a held Codex login is read again while it waits', () => {
    it('15 minutes after the hold it is read ONCE — and an allowed answer resumes it days before the stated reset', async () => {
        makeHost();
        const a = heldOnTheWeek();
        answer = (name) => codexReading(name, 2);
        advanceTo(now + 14 * MIN);
        expect(reads.get('kai')).toBe(0);
        advanceTo(now + MIN);
        await flush();
        expect(reads.get('kai')).toBe(1);
        expect(host.probe(a.id)?.limit).toEqual({ state: 'open' });
        expect(sent.get('kai')).toEqual(['build it']);
    });

    it('still spent: read again every 15 minutes, and nothing is sent', async () => {
        makeHost();
        heldOnTheWeek();
        answer = (name) => codexReading(name, 100);
        for (let i = 1; i <= 3; i += 1) { advanceTo(now + 15 * MIN); await flush(); }
        expect(reads.get('kai')).toBe(3);
        expect(sent.get('kai')).toEqual([]);
    });

    it('two agents on the one login: ONE read per interval, not one per agent', async () => {
        makeHost();
        heldOnTheWeek('kai');
        const b = codex('ana');
        host.start(b, dir);
        expect(host.probe(b.id)?.limit).toMatchObject({ state: 'paused' });
        advanceTo(now + 15 * MIN);
        await flush();
        expect((reads.get('kai') ?? 0) + (reads.get('ana') ?? 0)).toBe(1);
    });

    it('once it has resumed, it is not read again', async () => {
        makeHost();
        heldOnTheWeek();
        answer = (name) => codexReading(name, 2);
        advanceTo(now + 15 * MIN);
        await flush();
        advanceTo(now + 60 * MIN);
        await flush();
        expect(reads.get('kai')).toBe(1);
    });

    it('a LATER hold starts its own interval: not read at once on an old clock, read 15 minutes into the new hold', async () => {
        makeHost();
        const a = heldOnTheWeek();
        answer = (name) => codexReading(name, 2);
        advanceTo(now + 15 * MIN);
        await flush();
        expect(host.probe(a.id)?.limit).toEqual({ state: 'open' });
        advanceTo(now + 120 * MIN);
        codexReading('kai', 100); // held again, two hours on
        await flush();
        expect(reads.get('kai')).toBe(1);
        advanceTo(now + 14 * MIN);
        await flush();
        expect(reads.get('kai')).toBe(1);
        advanceTo(now + MIN);
        await flush();
        expect(reads.get('kai')).toBe(2);
    });

    it('CONTROL: an open login is never read', async () => {
        makeHost();
        const a = codex('kai');
        host.start(a, dir);
        codexReading('kai', 40);
        advanceTo(now + 120 * MIN);
        await flush();
        expect(reads.get('kai')).toBe(0);
    });

    it('a driver that cannot read is left alone: the hold stands until the reset, nothing throws', async () => {
        makeHost(false);
        const a = heldOnTheWeek();
        advanceTo(now + 60 * MIN);
        await flush();
        expect(host.probe(a.id)?.limit).toMatchObject({ state: 'paused' });
    });
});

describe('the pinned prism-acp can read', () => {
    it("CodexDriver has readRateLimits (prism-acp 0.26.0)", () => {
        expect(typeof (CodexDriver.prototype as unknown as Record<string, unknown>).readRateLimits).toBe('function');
    });
});
