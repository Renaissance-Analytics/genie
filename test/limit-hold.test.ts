import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { LimitReading } from '../src/core/rate-limit-gate.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, LIMIT_RESUME_PROMPT, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';

/**
 * A RATE LIMIT HOLDS THE AGENT, IT DOES NOT BREAK IT (Tynn #793, story #287). The owner, 2026-10-17: when a limit
 * hits "you cannot process anything else and everything dies". The provider says so in its own structured reading
 * (Claude's rate_limit_event status 'rejected', carried by prism-acp under _meta["particle.academy/rate_limit"]); the
 * turn that hit it ends in error. That turn is HELD — not failed, not Broken — and what the person sends while it is
 * held waits in Genie, never reaching a provider that would refuse it. Resumed (the gate's timer, or Resume now), the
 * held prompts go out in order; with none, the agent is told to continue.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { descendantsOf: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const T0 = Date.UTC(2026, 9, 17, 3, 0, 0);

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-hold-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const sent: unknown[] = [];
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: (t) => { sent.push(t); }, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    };
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const reported: Array<{ readings: LimitReading[]; message: string | null }> = [];
    const breaches: string[] = [];
    const session = new AgentSession({
        agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree,
        onRateLimit: (readings, message) => reported.push({ readings: [...readings], message }),
        onLimitBreach: (reason) => breaches.push(reason),
    });
    session.start();
    const limit = (status: string) => events.onUpdate?.({
        sessionUpdate: 'notice', notice: { level: 'info', message: status === 'allowed' ? 'rate limit ok' : 'You have hit your limit' },
        _meta: { 'particle.academy/rate_limit': { status, rateLimitType: 'five_hour', resetsAtMs: T0 + 3_600_000, windows: { five_hour: { utilization: 1, resetsAtMs: T0 + 3_600_000 } }, raw: {} } },
    });
    const endInError = () => events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution' });
    // prism-acp 0.18 (#791): the provider's own reason for a failed turn, verbatim, with its kind.
    const endFailing = (kind: string, reason: string) => events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution', failure: { kind, reason } });
    const rows = async () => (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; level?: string; message?: string; text?: string });
    return { session, sent, reported, breaches, limit, endInError, endFailing, rows };
}

/**
 * THE TURN ITSELF SAYS IT WAS THE LIMIT (Tynn #791, prism-acp 0.18.0 `TurnOutcome.failure`). A turn can end on the
 * provider's rate limit with no limit reading before it — Claude's assistant `error: 'rate_limit'`, codex's
 * usageLimitExceeded. It is HELD all the same, and the breach is reported so the login's gate can hold the others and
 * try again on its stated backoff (no reset is ever invented: the failure carries none of its own).
 */
describe('a turn that FAILED on the rate limit, with no reading before it', () => {
    it('is HELD, says so, and reports the breach ONCE with the provider’s own reason', async () => {
        const s = open();
        s.session.prompt('build it', 'you');
        s.endFailing('rate_limit', 'rate_limit');
        expect(s.session.held).toBe(true);
        expect(s.session.turnState).toBe('idle');
        expect(s.session.failure).toBeNull();
        expect(s.breaches).toEqual(['rate_limit']);
        await s.session.settled();
        expect((await s.rows()).filter((r) => r.kind === 'notice' && r.level === 'warning' && /rate limit/i.test(r.message ?? ''))).toHaveLength(1);
    });

    it('a reading earlier in the turn already told the gate: held, and NOT reported again as a breach', async () => {
        const s = open();
        s.session.prompt('build it', 'you');
        await s.limit('rejected');
        s.endFailing('rate_limit', 'rate_limit');
        expect(s.session.held).toBe(true);
        expect(s.reported).toHaveLength(1);
        expect(s.breaches).toEqual([]);
    });

    it('CONTROL: any other failure FAILS, named by the provider’s own reason rather than the CLI’s generic one', () => {
        const s = open();
        s.session.prompt('build it', 'you');
        // `overloaded`, not `auth`: a login refusal is SIGNED OUT since 2026-10-18 (provider-login.test.tsx).
        s.endFailing('overloaded', 'overloaded_error');
        expect(s.session.held).toBe(false);
        expect(s.session.turnState).toBe('failed');
        expect(s.session.failure).toBe('overloaded_error');
        expect(s.breaches).toEqual([]);
    });
});

describe('a turn the rate limit ended', () => {
    it('is HELD — idle, no failure — says so in the stream, and the reading reaches whoever keeps the gate', async () => {
        const s = open();
        s.session.prompt('build it', 'you');
        await s.limit('rejected');
        s.endInError();
        expect(s.session.held).toBe(true);
        expect(s.session.turnState).toBe('idle');
        expect(s.session.failure).toBeNull();
        expect(s.reported).toHaveLength(1);
        expect(s.reported[0]!.readings).toEqual([{ window: 'five_hour', status: 'rejected', resetsAtMs: T0 + 3_600_000 }]);
        await s.session.settled();
        const notes = (await s.rows()).filter((r) => r.kind === 'notice' && r.level === 'warning' && /rate limit/i.test(r.message ?? ''));
        expect(notes).toHaveLength(1);
    });

    it('CONTROL: a turn that ends in error with NO limit reading still fails, as before', () => {
        const s = open();
        s.session.prompt('build it', 'you');
        s.endInError();
        expect(s.session.held).toBe(false);
        expect(s.session.turnState).toBe('failed');
    });

    it('CONTROL: an allowed reading in the turn does not hold a turn that then fails for another reason', async () => {
        const s = open();
        s.session.prompt('build it', 'you');
        await s.limit('allowed');
        s.endInError();
        expect(s.session.held).toBe(false);
        expect(s.session.turnState).toBe('failed');
    });

    it('a prompt sent while HELD waits in Genie — the provider is not given it — and is recorded as the person’s message', async () => {
        const s = open();
        s.session.prompt('build it', 'you');
        await s.limit('rejected');
        s.endInError();
        const before = s.sent.length;
        s.session.prompt('and add tests', 'you');
        expect(s.sent.length).toBe(before);
        expect(s.session.held).toBe(true);
        await s.session.settled();
        expect((await s.rows()).filter((r) => r.kind === 'message' && r.text === 'and add tests')).toHaveLength(1);
    });

    it('resumed: the held prompts go to the provider in order, each once; then the session is not held', async () => {
        const s = open();
        s.session.prompt('build it', 'you');
        await s.limit('rejected');
        s.endInError();
        s.session.prompt('first', 'you');
        s.session.prompt('second', 'kai');
        const before = s.sent.length;
        s.session.resumeAfterLimit();
        expect(s.sent.slice(before)).toEqual(['first', 'second']);
        expect(s.session.held).toBe(false);
        // the messages were recorded when sent; resuming does not record them again
        await s.session.settled();
        expect((await s.rows()).filter((r) => r.kind === 'message' && r.text === 'first')).toHaveLength(1);
    });

    it('resumed with nothing waiting: the agent is told to continue, once', () => {
        const s = open();
        s.session.prompt('build it', 'you');
        void s.limit('rejected');
        s.endInError();
        const before = s.sent.length;
        s.session.resumeAfterLimit();
        expect(s.sent.slice(before)).toEqual([LIMIT_RESUME_PROMPT]);
        s.session.resumeAfterLimit(); // not held any more: nothing
        expect(s.sent.length).toBe(before + 1);
    });

    it('hold() holds an agent that did not hit the limit itself (its login did): its next prompt waits too', () => {
        const s = open();
        s.session.hold();
        expect(s.session.held).toBe(true);
        s.session.prompt('hello', 'you');
        expect(s.sent).toEqual([]);
        s.session.resumeAfterLimit();
        expect(s.sent).toEqual(['hello']);
    });
});
