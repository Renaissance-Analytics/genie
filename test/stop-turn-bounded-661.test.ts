import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warmLockIdentity } from '@particle-academy/prism-harness';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { RATE_LIMIT_META } from '../src/core/headroom.js';
import { promptDeliveries } from '../src/core/prompt-delivery.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type TurnOutcomeLike } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore, readWholeHistory } from '../src/core/thread-store.js';

// Match the real host's startup; the test's time measures Stop, not cold Windows CIM discovery.
beforeAll(async () => { await warmLockIdentity(); }, 30_000);
let dir: string;
const sessions: AgentSession[] = [];
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-stop-661-'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
    for (const session of sessions.splice(0)) { await session.stop(); await session.settled(); }
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const CANCELLED: TurnOutcomeLike = { stopReason: 'cancelled', isError: false, raw: 'cancelled' };
type Cancel = 'silent' | 'receipt-only' | 'refused';
function rig(cancel: Cancel = 'silent', folds = false, machine?: { tree: ProcessTree; start: () => void }) {
    const id = mintAgentId();
    const store = openDurableStore(dir);
    const rows: StreamEvent[] = [];
    const calls = { cancels: 0, kills: 0, reaps: 0, restarts: 0 };
    const prompts: unknown[] = [];
    let events: DriverEvents = {};
    let busy = false;
    let alive = false;
    let rejectCancel: (reason: Error) => void = () => {};
    const session = new AgentSession({
        agentId: id, cwd: dir, store, onEvent: (row) => rows.push(row),
        processTree: machine?.tree ?? { snapshot: () => [], killTree: () => { calls.reaps += 1; return { killed: 0, refused: false }; } },
        onRestartForQueue: () => { calls.restarts += 1; },
        onRateLimit: (readings) => { if (readings.some((r) => r.status !== 'allowed')) session.hold(); },
        driverFactory: (options) => {
            events = options.events;
            return {
                start: () => { alive = true; machine?.start(); },
                prompt: (text) => { if (busy && !folds) throw new Error('turn already in flight'); busy = true; prompts.push(text); },
                cancel: () => {
                    calls.cancels += 1;
                    if (cancel === 'receipt-only') return Promise.resolve();
                    if (cancel === 'refused') return Promise.reject(new Error('provider refused cancel'));
                    return new Promise<void>((_resolve, reject) => { rejectCancel = reject; });
                },
                // Deliberately no onExit/onTurnEnd: the provider never answers, even to its kill.
                kill: () => { alive = false; calls.kills += 1; },
                get running() { return alive; }, cliSessionId: null,
            };
        },
    });
    sessions.push(session);
    session.start();
    const end = (outcome = CANCELLED) => { busy = false; events.onTurnEnd?.(outcome); };
    const limit = () => events.onUpdate?.({ sessionUpdate: 'notice', notice: { level: 'warning', message: 'Five-hour allowance exhausted.' },
        _meta: { [RATE_LIMIT_META]: { status: 'rejected', rateLimitType: 'five_hour', resetsAtMs: Date.now() + 3_600_000,
            windows: { five_hour: { utilization: 1, resetsAtMs: Date.now() + 3_600_000 } }, raw: {} } } });
    const deliveries = () => promptDeliveries(rows.map((event) => ({ event })));
    return { session, rows, calls, prompts, end, limit, deliveries, rejectCancel: () => rejectCancel(new Error('late cancel refusal')), store, id };
}

describe('Stop has its own bound even when the provider never answers (Tynn #661)', () => {
    it.each(['silent', 'receipt-only', 'refused'] as const)('%s: stops within three seconds and preserves queued input for Send now', async (mode) => {
        const w = rig(mode);
        w.session.prompt('work', 'you');
        const queued = w.session.deliver('next message', 'you');
        expect(queued).not.toBeNull();
        expect(w.session.cancel()).toEqual({ ok: true });
        expect(w.calls.kills).toBe(0); // a responsive provider still gets its chance
        await vi.advanceTimersByTimeAsync(3_000);
        expect(w.session.inTurn).toBe(false);
        expect(w.session.turnState).not.toBe('working');
        expect(w.session.needsNewDriver).toBe(true);
        expect(w.calls.kills).toBe(1);
        expect(w.calls.reaps).toBeGreaterThan(0);
        expect(w.calls.restarts).toBe(0); // Stop waits for the person; an interrupt is different
        expect(w.prompts).toEqual(['work']);
        expect(w.deliveries().get(queued!)).toBe('undelivered');
        expect(w.rows.filter((r) => r.kind === 'stopped')).toEqual([{ kind: 'stopped', n: 1, by: 'you' }]);
        await w.session.settled();
        const kept = await readWholeHistory(w.store, w.id);
        expect(kept.rows.some(({ event }) => event.kind === 'message' && event.text === 'next message' && event.pending?.id === queued)).toBe(true);
        w.end(); // late provider frames cannot stop/count a second turn
        expect(w.rows.filter((r) => r.kind === 'stopped')).toHaveLength(1);
    });

    it('a prompt the provider already accepted mid-turn is kept too when no cancellation events arrive', async () => {
        const w = rig('silent', true);
        w.session.prompt('work', 'you');
        w.session.prompt('accepted but not completed', 'you');
        w.session.cancel();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(w.session.inTurn).toBe(false);
        const draft = w.rows.find((r) => r.kind === 'message' && r.text === 'accepted but not completed' && r.pending);
        expect(draft?.kind === 'message' && draft.pending).toBeTruthy();
        if (draft?.kind === 'message' && draft.pending) expect(w.deliveries().get(draft.pending.id)).toBe('undelivered');
    });

    it.each([false, true])('known five-hour limit is stated after Stop (provider acknowledges: %s)', async (acknowledges) => {
        const w = rig();
        w.session.prompt('work', 'you');
        w.limit();
        expect(w.session.held).toBe(true);
        const queued = w.session.deliver('keep this for later', 'you');
        w.session.cancel();
        if (acknowledges) w.end();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(w.session.inTurn).toBe(false);
        expect(w.session.held).toBe(true);
        expect(w.prompts).toEqual(['work']);
        expect(w.rows.some((r) => r.kind === 'notice' && /rate limit/i.test(r.message))).toBe(true);
        expect(w.deliveries().get(queued!)).toMatch(/^(queued|undelivered)$/);
    });

    it('repeated Stop clicks cannot postpone the first deadline', async () => {
        const w = rig();
        w.session.prompt('work', 'you');
        w.session.cancel();
        await vi.advanceTimersByTimeAsync(1_500);
        w.session.cancel();
        await vi.advanceTimersByTimeAsync(1_500);
        expect(w.session.inTurn).toBe(false);
        expect(w.calls.kills).toBe(1);
    });

    it('interrupt-and-send preserves its queue for the existing restart path after the same bound', async () => {
        const w = rig();
        w.session.prompt('work', 'you');
        const queued = w.session.deliver('send this next', 'you');
        w.session.cancel('you', 'interrupt');
        await vi.advanceTimersByTimeAsync(3_000);
        expect(w.session.inTurn).toBe(false);
        expect(w.calls.kills).toBe(1);
        expect(w.calls.restarts).toBe(1);
        expect(w.deliveries().get(queued!)).toBe('carried');
    });

    it('CONTROL: a confirmed Stop leaves the provider alive and cannot kill the next turn', async () => {
        const w = rig('receipt-only');
        w.session.prompt('first', 'you');
        w.session.cancel();
        w.end();
        w.session.prompt('second', 'you');
        await vi.advanceTimersByTimeAsync(3_000);
        expect(w.session.inTurn).toBe(true);
        expect(w.calls.kills).toBe(0);
        expect(w.prompts).toEqual(['first', 'second']);
    });

    it('a late rejected cancel cannot overwrite a newer turn or its Stop', async () => {
        const w = rig();
        w.session.prompt('first', 'you'); w.session.cancel(); w.end();
        w.session.prompt('second', 'you');
        w.rejectCancel(); await Promise.resolve();
        expect(w.rows.some((r) => r.kind === 'notice' && /late cancel refusal/.test(r.message))).toBe(false);
        w.session.cancel();
        w.end();
        expect(w.rows.filter((r) => r.kind === 'stopped').at(-1)).toEqual({ kind: 'stopped', n: 2, by: 'you' });
    });

    it.each([false, true])('Genie itself ends the owned CLI and tool tree; a refused reap stays visible (refused: %s)', async (refuses) => {
        const cli = process.pid + 2_000_001, tool = cli + 1, sibling = cli + 10;
        let table: ProcessInfo[] = [
            { pid: process.pid, ppid: 1, started: 1, name: 'genie-fixture' },
            { pid: sibling, ppid: process.pid, started: 2, name: 'other-agent-fixture' },
        ];
        const targets: number[][] = [];
        const w = rig('silent', false, {
            start: () => { table.push({ pid: cli, ppid: process.pid, started: 3, name: 'provider-fixture' }); },
            tree: {
                snapshot: () => [...table],
                killTree: (owned) => {
                    targets.push(owned.map((p) => p.pid));
                    if (refuses) return { killed: 0, refused: true, reason: 'fixture refuses reap' };
                    const ids = new Set(owned.map((p) => p.pid));
                    table = table.filter((p) => !ids.has(p.pid));
                    return { killed: owned.length, refused: false };
                },
            },
        });
        w.session.prompt('work', 'you');
        table.push({ pid: tool, ppid: cli, started: 4, name: 'tool-fixture' });
        w.session.cancel();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(targets.some((ids) => ids.includes(cli) && ids.includes(tool))).toBe(true);
        expect(targets.every((ids) => !ids.includes(sibling))).toBe(true);
        expect(table.some((p) => p.pid === sibling)).toBe(true);
        if (refuses) {
            expect(w.session.stopVerdict).toMatchObject({ verified: false });
            expect(w.rows.some((r) => r.kind === 'notice' && /fixture refuses reap/.test(r.message))).toBe(true);
        } else {
            expect(table.map((p) => p.pid)).not.toContain(cli);
            expect(table.map((p) => p.pid)).not.toContain(tool);
            expect(w.session.stopVerdict).toMatchObject({ verified: true });
        }
    });
});
