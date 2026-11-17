import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { Resolution } from '../src/core/inbox.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { RateLimitGate } from '../src/core/rate-limit-gate.js';
import { LIMIT_RESUME_PROMPT, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { agentPrompter, type AgentSessionsPort } from '../src/main/flow-runner.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * TYNN #749, with the REAL SessionHost and AgentSession behind the flow's port (the stub driver is the provider: it sends
 * the provider's own rate-limit reading and its rate_limit turn failure, as test/limit-reset-nudge.test.ts does).
 */
const MIN = 60_000;
let dir: string;
let now = Date.UTC(2026, 10, 15, 3, 0, 0);
let timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
const events = new Map<string, DriverEvents>();
const sent = new Map<string, unknown[]>();
const cancels = new Map<string, number>();
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        events.set(record.name, options.events);
        sent.set(record.name, []);
        cancels.set(record.name, 0);
        return { start: () => {}, prompt: (t: unknown) => { sent.get(record.name)!.push(t); }, cancel: () => { cancels.set(record.name, (cancels.get(record.name) ?? 0) + 1); }, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } } as never;
    };
    return factory;
};

let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-limit-749-'));
    now = Date.UTC(2026, 10, 15, 3, 0, 0);
    timers = [];
    events.clear(); sent.clear(); cancels.clear();
    host = new SessionHost({
        userData: dir, driverFor, clock: () => now, processTree: noTree,
        rateLimit: { gate: new RateLimitGate({ marginMs: 2 * MIN }), schedule: (ms, fn) => { const t = { at: now + ms, fn, cleared: false }; timers.push(t); return () => { t.cleared = true; }; } },
    });
});
afterEach(async () => {
    host.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (name: string): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name });
const rejected = (name: string, resetsAtMs: number) => events.get(name)!.onUpdate?.({
    sessionUpdate: 'notice', notice: { level: 'info', message: "You've hit your limit" },
    _meta: { 'particle.academy/rate_limit': { status: 'rejected', rateLimitType: 'five_hour', resetsAtMs, windows: { five_hour: { utilization: 1, resetsAtMs } }, raw: {} } },
});
const cutByLimit = (name: string) => events.get(name)!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind: 'rate_limit', reason: 'rate_limit' } });
const endsCleanly = (name: string) => events.get(name)!.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: 'success' });
const advanceTo = (t: number) => { now = t; for (const x of timers.filter((x) => !x.cleared && x.at <= t)) { x.cleared = true; x.fn(); } };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

type Settled = 'pending' | 'resolved' | 'rejected';
async function stateOf(p: Promise<unknown>): Promise<Settled> {
    let out: Settled = 'pending';
    p.then(() => { out = 'resolved'; }, () => { out = 'rejected'; });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await tick();
    return out;
}

describe('#749 through the real host: a flow step whose agent is cut by the limit', () => {
    it('stays PENDING at the cut, and finishes when the resumed turn ends; the nudge it is resumed with names the task that was cut off', async () => {
        const r = record('atlas');
        expect(host.start(r, dir)).toEqual({ ok: true });
        const port: AgentSessionsPort = {
            session: (id) => host.probe(id as never) as never,
            rows: (id) => host.rowsFor(id as never),
            prompt: (id, text, by) => host.prompt(id as never, text, by),
            subscribe: (l) => host.subscribe((id) => l(id)),
        };
        const resolve = (text: string): Resolution => (text === 'claude:atlas' ? { kind: 'one', id: r.id } : { kind: 'none' });
        const asked = agentPrompter({ sessions: port, resolve, agent: () => ({ name: 'atlas', workspaceId: 'ws' }), asleep: () => false, by: 'flow "nightly"' })('claude:atlas', 'build the report');
        await tick();
        expect(sent.get('atlas')).toEqual(['build the report']);
        rejected('atlas', now + 60 * MIN);
        cutByLimit('atlas');
        await tick();
        // TODAY: the held session reads idle, so the step reads "turn ended" and resolves on whatever was said before the cut.
        expect(await stateOf(asked)).toBe('pending');
        advanceTo(now + 62 * MIN);
        await tick();
        expect(sent.get('atlas')!.length).toBe(2);
        expect(String(sent.get('atlas')!.at(-1))).toContain(LIMIT_RESUME_PROMPT);
        // TODAY: the nudge is the same words for every cut turn; it does not say what was being done.
        expect(String(sent.get('atlas')!.at(-1))).toContain('build the report');
        endsCleanly('atlas');
        await tick();
        expect(await stateOf(asked)).toBe('resolved');
    });
});

describe('#749 a resume does not cut a turn that is genuinely working', () => {
    it('a sibling held only because its LOGIN hit the limit keeps its working turn when the hold is lifted; what waited goes at its end', async () => {
        const atlas = record('atlas');
        const wren = record('wren');
        expect(host.start(atlas, dir)).toEqual({ ok: true });
        expect(host.start(wren, dir)).toEqual({ ok: true });
        host.prompt(wren.id, 'long job', 'you');
        // atlas's turn hits the limit; its login is held, wren's own turn goes on working.
        host.prompt(atlas.id, 'build it', 'you');
        rejected('atlas', now + 60 * MIN);
        cutByLimit('atlas');
        host.prompt(wren.id, 'also this', 'you');
        advanceTo(now + 62 * MIN);
        await tick();
        // TODAY: the reset cancels wren's open turn (resumeAfterLimit interrupts every turn still open).
        expect(cancels.get('wren')).toBe(0);
        endsCleanly('wren');
        await tick();
        expect(String(sent.get('wren')!.at(-1))).toContain('also this');
    });
});
