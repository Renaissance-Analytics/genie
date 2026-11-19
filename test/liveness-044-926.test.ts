import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { statePill } from '../src/core/agent-view.js';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriver, SessionDriverFactory } from '../src/core/session.js';
import { deferredDriverFactory } from '../src/main/deferred-driver.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * PRISM-ACP 0.44.0 INTO GENIE'S LIVENESS SEAM (Tynn #926; follow-up to #855).
 *
 * G-314: `ping({ timeoutMs })` resolves TRUE when the provider answered and FALSE when it did not (timeout, exit, a write
 * failure, a stopped driver) — it never rejects. `lastFrameAt` is when the provider last wrote anything. CodexDriver has
 * `running` now. G-313: a turn Claude started itself ends with `unsolicited: true` and `unsolicitedTurnId`; a prompt of
 * Genie's folded into it ends with `foldedInto: <unsolicitedTurnId>`.
 *
 * #855 read a RESOLVED ping as alive. Against 0.44 that is exactly backwards for the case it exists for: an unresponsive
 * provider resolves `false`, and would have read alive — never Stalled.
 */

const noTree: ProcessTree = { snapshot: () => [], killTree: (t) => ({ killed: t.length, refused: false }) };
interface Fake { events: DriverEvents; prompts: string[]; running: boolean; answer: boolean; pings: unknown[]; lastFrameAt: number | undefined }
const fakes = new Map<string, Fake>();
let t = 1_800_000_000_000;

/** prism-acp 0.44's drivers, as far as this needs. */
const driver044 = (fake: Fake): SessionDriver => ({
    start: () => {},
    prompt: (content: unknown) => { fake.prompts.push(String(content)); return `p${fake.prompts.length}`; },
    kill: () => {},
    cancel: () => {},
    cliSessionId: null,
    get running() { return fake.running; },
    ping: (options?: { timeoutMs?: number }) => { fake.pings.push(options); return Promise.resolve(fake.answer); },
    get lastFrameAt() { return fake.lastFrameAt; },
} as SessionDriver);

const direct: DriverFor = (record) => (options) => {
    const fake: Fake = { events: options.events, prompts: [], running: true, answer: true, pings: [], lastFrameAt: undefined };
    fakes.set(record.id, fake);
    return driver044(fake);
};
/** As genie-host builds it: every real driver is behind the deferred factory (MCP preparation, then the provider). */
const deferred: DriverFor = (record) => deferredDriverFactory(async () => ((options) => {
    const fake: Fake = { events: options.events, prompts: [], running: true, answer: true, pings: [], lastFrameAt: undefined };
    fakes.set(record.id, fake);
    return driver044(fake);
}) as SessionDriverFactory);

let dir: string;
let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-926-'));
    fakes.clear();
    t = 1_800_000_000_000;
});
afterEach(async () => {
    host.stopAll();
    await host.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'prism-engine' });
const fake = (id: AgentId): Fake => fakes.get(id)!;
const MIN = 60_000;

async function started(factory: DriverFor): Promise<AgentRecord> {
    host = new SessionHost({ userData: dir, driverFor: factory, processTree: noTree, clock: () => t });
    const r = record();
    expect(host.start(r, dir)).toEqual({ ok: true });
    for (let i = 0; i < 50 && !fakes.has(r.id); i += 1) await new Promise((res) => setTimeout(res, 5));
    expect(fakes.has(r.id)).toBe(true);
    return r;
}

describe('G-314 ping: one boolean, one meaning (Tynn #926)', () => {
    it('a ping that resolves FALSE is unresponsive — never alive', async () => {
        const r = await started(direct);
        fake(r.id).answer = false;
        expect(await host.checkAlive(r.id, 2_000)).toBe('unresponsive');
    });

    it('CONTROL: a ping that resolves true is alive', async () => {
        const r = await started(direct);
        expect(await host.checkAlive(r.id, 2_000)).toBe('alive');
    });

    it('the ping is asked with prism\'s own option, { timeoutMs }', async () => {
        const r = await started(direct);
        await host.checkAlive(r.id, 2_000);
        expect(fake(r.id).pings).toEqual([{ timeoutMs: 2_000 }]);
    });

    it('a process that is not running is dead, and is not pinged', async () => {
        const r = await started(direct);
        fake(r.id).running = false;
        expect(await host.checkAlive(r.id, 2_000)).toBe('dead');
        expect(fake(r.id).pings).toEqual([]);
    });

    it('an unresponsive provider, ended as stalled, reads Stalled — the whole path', async () => {
        const r = await started(direct);
        expect(host.prompt(r.id, 'go', 'you')).toBe(true);
        fake(r.id).answer = false;
        const verdict = await host.checkAlive(r.id, 2_000);
        expect(verdict).toBe('unresponsive');
        t += 21 * MIN;
        expect(host.endStalled(r.id, verdict as 'unresponsive', 21 * MIN)).toBe(true);
        expect(statePill(host.probe(r.id), () => t, { turns: 1 }).word).toBe('Stalled · no events for 21 min');
    });
});

describe('behind the deferred driver, as genie-host runs every agent (Tynn #926)', () => {
    it('ping reaches the provider: an unresponsive one reads unresponsive, an answering one alive (never unknown)', async () => {
        const r = await started(deferred);
        await host.settled();
        fake(r.id).answer = false;
        expect(await host.checkAlive(r.id, 2_000)).toBe('unresponsive');
        fake(r.id).answer = true;
        expect(await host.checkAlive(r.id, 2_000)).toBe('alive');
    });

    it('lastFrameAt reaches the session: the provider\'s own last frame, when later than Genie\'s last event', async () => {
        const r = await started(deferred);
        fake(r.id).lastFrameAt = t + 90_000;
        expect(host.probe(r.id)!.lastEventAt).toBe(t + 90_000);
    });
});

describe('G-313 as 0.44 sends it: unsolicited + unsolicitedTurnId, a folded prompt by foldedInto (Tynn #926)', () => {
    it('the folded prompt settles without ending the turn; the unsolicited end closes it, once', async () => {
        const r = await started(direct);
        expect(host.prompt(r.id, 'first', 'you')).toBe(true);
        fake(r.id).events.onTurnEnd?.({ turnId: 'p1', stopReason: 'end_turn', isError: false, raw: null });
        const before = host.turnsFor(r.id);
        // A background task ended: Claude starts a turn of its own.
        fake(r.id).events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the job passed' } });
        expect(host.inTurn(r.id)).toBe(true);
        // The person writes mid-turn; the CLI folds it into its own turn.
        host.prompt(r.id, 'and the other one?', 'you');
        fake(r.id).events.onTurnEnd?.({ turnId: 'p2', foldedInto: 'u-1', stopReason: 'end_turn', isError: false, raw: null });
        expect(host.inTurn(r.id)).toBe(true);
        fake(r.id).events.onTurnEnd?.({ unsolicited: true, unsolicitedTurnId: 'u-1', stopReason: 'end_turn', isError: false, raw: null } as never);
        expect(host.inTurn(r.id)).toBe(false);
        expect(host.probe(r.id)!.turnState).not.toBe('working');
        expect(host.turnsFor(r.id)).toBe(before + 1);
        expect(host.queuedPromptIds(r.id)).toEqual([]);
    });
});
