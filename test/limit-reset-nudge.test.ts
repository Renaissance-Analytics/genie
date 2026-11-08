import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { OS_AGENT_NAME, OS_WORKSPACE } from '../src/core/os-agent.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { LIMIT_RESUME_PROMPT } from '../src/core/session.js';
import { RateLimitGate } from '../src/core/rate-limit-gate.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * THE RATE-LIMIT RESET NUDGE GOES ONLY TO A TURN THE LIMIT CUT OFF (Tynn #543). The owner, 2026-11-08, with a screenshot:
 * Genie sent the OS agent (genie@system) "The provider's rate limit has reset. Continue where you left off." four times
 * while it was idle with nothing in progress — "the genie osa is mostly used for diagnostics and system setup, it doesn't
 * do work, so it does not need to be nudged".
 *
 * One agent's breach holds every agent on that login (Tynn #793), and at the reset every held agent with nothing waiting
 * was told to "continue" — including the ones the limit never interrupted. Now:
 *  1. the OS agent is never sent it;
 *  2. any other agent gets it only if ITS last turn was cut off by the limit, at most once per reset; an idle agent, or
 *     one whose last turn ended cleanly, gets nothing (what it was sent while held still goes, as before);
 *  3. the same for every provider.
 */
const MIN = 60_000;
let dir: string;
let now = Date.UTC(2026, 10, 8, 3, 0, 0);
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
    dir = await mkdtemp(join(tmpdir(), 'genie2-limit-nudge-'));
    now = Date.UTC(2026, 10, 8, 3, 0, 0);
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

type Provider = 'claude' | 'codex';
const record = (name: string, provider: Provider = 'claude', workspaceId = 'ws'): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId, provider, name });
const osAgent = (provider: Provider = 'claude'): AgentRecord => record(OS_AGENT_NAME, provider, OS_WORKSPACE);
/** The provider's reading: this login is at its limit until `resetsAtMs`. */
const rejected = (name: string, resetsAtMs: number) => events.get(name)!.onUpdate?.({
    sessionUpdate: 'notice', notice: { level: 'info', message: "You've hit your limit" },
    _meta: { 'particle.academy/rate_limit': { status: 'rejected', rateLimitType: 'five_hour', resetsAtMs, windows: { five_hour: { utilization: 1, resetsAtMs } }, raw: {} } },
});
/** The turn the limit cut off: it ended on the provider's rate_limit error. */
const cutByLimit = (name: string) => events.get(name)!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind: 'rate_limit', reason: 'rate_limit' } });
const endsCleanly = (name: string) => events.get(name)!.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: 'success' });
const advanceTo = (t: number) => { now = t; for (const x of timers.filter((x) => !x.cleared && x.at <= t)) { x.cleared = true; x.fn(); } };
/** One agent's turn is cut off by the limit, which resets in an hour; the clock goes past the reset and its margin. */
const breachAndReset = (name: string, prompt = 'build it') => {
    const id = [...ids.entries()].find(([n]) => n === name)![1];
    host.prompt(id, prompt, 'you');
    rejected(name, now + 60 * MIN);
    cutByLimit(name);
    advanceTo(now + 62 * MIN);
};
const ids = new Map<string, AgentRecord['id']>();
const start = (r: AgentRecord) => { expect(host.start(r, dir)).toEqual({ ok: true }); ids.set(r.name, r.id); return r; };
beforeEach(() => { ids.clear(); });

describe.each<Provider>(['claude', 'codex'])('the reset nudge on %s', (provider) => {
    it('CONTROL: the agent whose turn the limit cut off is told to continue, once, at the reset', () => {
        start(record('atlas', provider));
        breachAndReset('atlas');
        expect(sent.get('atlas')).toEqual(['build it', LIMIT_RESUME_PROMPT]);
    });

    it('an IDLE agent on the same login, held only because its login was, is told nothing', () => {
        start(record('atlas', provider));
        start(record('wren', provider));
        breachAndReset('atlas');
        expect(sent.get('atlas')).toEqual(['build it', LIMIT_RESUME_PROMPT]);
        expect(sent.get('wren')).toEqual([]);
        expect(host.probe(ids.get('wren')!)?.limit).toEqual({ state: 'open' });
    });

    it('an agent whose last turn ENDED CLEANLY is told nothing; what it was sent while held still goes', () => {
        start(record('atlas', provider));
        start(record('wren', provider));
        host.prompt(ids.get('wren')!, 'first', 'you');
        endsCleanly('wren');
        host.prompt(ids.get('atlas')!, 'build it', 'you');
        rejected('atlas', now + 60 * MIN);
        cutByLimit('atlas');
        expect(sent.get('wren')).toEqual(['first']);
        advanceTo(now + 62 * MIN);
        expect(sent.get('wren')).toEqual(['first']);
    });

    it('CONTROL: what the person sent a held agent while it waited goes at the reset, and no nudge with it', () => {
        start(record('atlas', provider));
        start(record('wren', provider));
        host.prompt(ids.get('atlas')!, 'build it', 'you');
        rejected('atlas', now + 60 * MIN);
        cutByLimit('atlas');
        host.prompt(ids.get('wren')!, 'while held', 'you');
        expect(sent.get('wren')).toEqual([]);
        advanceTo(now + 62 * MIN);
        expect(sent.get('wren')).toEqual(['while held']);
    });

    it('the OS agent is NEVER told to continue — idle, or even when its own turn was the one cut off', () => {
        start(osAgent(provider));
        start(record('atlas', provider));
        breachAndReset('atlas');
        expect(sent.get(OS_AGENT_NAME)).toEqual([]);
        // Its own turn cut off: held, then released at the reset, with nothing sent for it.
        host.prompt(ids.get(OS_AGENT_NAME)!, 'check the toolchain', 'you');
        rejected(OS_AGENT_NAME, now + 60 * MIN);
        cutByLimit(OS_AGENT_NAME);
        advanceTo(now + 62 * MIN);
        expect(sent.get(OS_AGENT_NAME)).toEqual(['check the toolchain']);
        expect(host.probe(ids.get(OS_AGENT_NAME)!)?.limit).toEqual({ state: 'open' });
    });

    it('at most ONCE per reset: a later hold the agent was not cut off by sends it nothing more', () => {
        start(record('atlas', provider));
        start(record('wren', provider));
        breachAndReset('atlas');
        expect(sent.get('atlas')).toEqual(['build it', LIMIT_RESUME_PROMPT]);
        endsCleanly('atlas');
        // Resume now again after the reset changes nothing.
        host.resumeLimit(provider);
        expect(sent.get('atlas')).toEqual(['build it', LIMIT_RESUME_PROMPT]);
        // Another agent's breach holds atlas again; atlas was not cut off this time, so the next reset tells it nothing.
        breachAndReset('wren', 'your turn');
        expect(sent.get('atlas')).toEqual(['build it', LIMIT_RESUME_PROMPT]);
        expect(sent.get('wren')).toEqual(['your turn', LIMIT_RESUME_PROMPT]);
    });
});
