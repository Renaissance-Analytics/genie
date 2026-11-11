import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileLockIdentityStatus, warmLockIdentity } from '@particle-academy/prism-harness';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { ThreadStore, readWholeHistory, openDurableStore, setThreadStoreSlowLog } from '../src/core/thread-store.js';
import { sessionsDir } from '../src/main/paths.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/*
 * Tynn #550. On Windows `host.settled()` after 120 turns of an 8 KB reply took about 5 s, and one run in four never
 * ended (carry-over-over-the-link). Every row was its own `thread.record`: a lock file created and deleted, the log's
 * tail read, a write, a sync — some 600 times. On Windows a lock file just deleted stays delete-pending while another
 * handle (Defender, the indexer) has it open, and creating it again is refused (EPERM, read as "held") for up to the
 * lock's 5 s wait. Rows queued together go to the thread together, in order, as one record.
 */
let dir: string;
// As genie-host's boot does (genie-host.ts awaits warmLockIdentity before its session host takes work): the one-time read
// is paid here, and what it cost is said, so the settle below measures the thread and nothing else (#682).
beforeAll(async () => {
    await warmLockIdentity();
    console.log(`[#682] ${process.platform} lock identity read once: ${Math.round(fileLockIdentityStatus().sample_duration_ms)} ms`);
}, 30_000);
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-batched-')); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(hosts.splice(0).map((h) => h.settled())); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function rig() {
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => ((o: { events: DriverEvents }) => {
        events = o.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    }) as unknown as SessionDriverFactory;
    const host = new SessionHost({ userData: dir, driverFor, processTree: tree });
    hosts.push(host);
    return { host, events: () => events };
}

describe("a turn's rows reach the thread together", () => {
    // Six runs (#682): a miss one run in a few is seen with its figures, and so are the runs that do not miss.
    it.each([1, 2, 3, 4, 5, 6])('120 turns of an 8 KB reply settle in a few appends, in order, and within a bound (run %i)', async () => {
        // WHERE THE TIME GOES (#682): each lock's wait before its callback runs, the time it is held, and each append.
        // The WHOLE settle is accounted for: before the first lock is asked for, each lock from asked to given back (its
        // wait, its hold, and its RELEASE, which the first measurement left out), and after the last one is given back.
        const timing = { lockWaitMs: 0, worstLockWaitMs: 0, lockHeldMs: 0, lockReleaseMs: 0, worstLockReleaseMs: 0, appendMs: 0, worstAppendMs: 0, locks: 0 };
        const span = { firstAsked: null as number | null, lastBack: 0 };
        // Each store step past 200 ms, by name (open, write, sync, close, repair, rotate).
        const slowSteps: string[] = [];
        setThreadStoreSlowLog((line) => { slowSteps.push(line.replace(/ log=\S+/, '')); });
        const realLock = ThreadStore.prototype.withLock;
        vi.spyOn(ThreadStore.prototype, 'withLock').mockImplementation(function (this: ThreadStore, key, callback, ttl, wait) {
            const asked = performance.now();
            span.firstAsked ??= asked;
            let left = asked;
            return realLock.call(this, key, async () => {
                const got = performance.now();
                timing.locks += 1; timing.lockWaitMs += got - asked; timing.worstLockWaitMs = Math.max(timing.worstLockWaitMs, got - asked);
                try { return await callback(); } finally { left = performance.now(); timing.lockHeldMs += left - got; }
            }, ttl, wait).finally(() => {
                const back = performance.now();
                span.lastBack = back;
                timing.lockReleaseMs += back - left; timing.worstLockReleaseMs = Math.max(timing.worstLockReleaseMs, back - left);
            });
        } as typeof realLock);
        const realAppend = ThreadStore.prototype.appendLog;
        const appends = vi.spyOn(ThreadStore.prototype, 'appendLog').mockImplementation(async function (this: ThreadStore, key, entries) {
            const started = performance.now();
            try { return await realAppend.call(this, key, entries); } finally { const ms = performance.now() - started; timing.appendMs += ms; timing.worstAppendMs = Math.max(timing.worstAppendMs, ms); }
        } as typeof realAppend);
        // #682: the first lock in a process reads its identity (on Windows a PowerShell CIM query, 0.4-2 s+ on a busy runner).
        // genie-host reads it at boot, before its session host takes work (prism-harness-0103.test.ts); this settle must not
        // be charged for it either, or the bound measures PowerShell instead of the thread.
        expect(fileLockIdentityStatus().sampled, 'the lock identity is read before the timed settle, as genie-host reads it at boot').toBe(true);
        const r = rig();
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'w', provider: 'claude', name: 'atlas' });
        r.host.start(record, dir);
        for (let n = 1; n <= 120; n += 1) {
            r.host.prompt(record.id, `question ${n}`, 'you');
            r.events().onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer ${n} ${'x'.repeat(8000)}` } } as never);
            r.events().onTurnEnd?.({ stopReason: 'end_turn' } as never);
        }
        const started = performance.now();
        await r.host.settled();
        const ended = performance.now();
        const ms = ended - started;
        setThreadStoreSlowLog(null);
        const history = await readWholeHistory(openDurableStore(sessionsDir(dir)), record.id);
        const texts = history.rows.flatMap((row) => (row.event.kind === 'message' ? [String((row.event as { text: string }).text).split(' ').slice(0, 2).join(' ')] : []));
        // Every question and answer, in order.
        expect(texts).toEqual(Array.from({ length: 120 }, (_, i) => [`question ${i + 1}`, `answer ${i + 1}`]).flat());
        expect(history.rows.map((row) => row.position)).toEqual(Array.from({ length: history.rows.length }, (_, i) => i + 1));
        expect(history.rows.length).toBeGreaterThan(360);
        const measured = {
            identityReadMs: Math.round(fileLockIdentityStatus().sample_duration_ms), settleMs: Math.round(ms), appends: appends.mock.calls.length,
            ...Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, Math.round(v)])),
            beforeFirstLockMs: Math.round((span.firstAsked ?? ended) - started), afterLastLockMs: Math.round(ended - span.lastBack), slowSteps,
        };
        console.log(`[#682] ${process.platform} ${JSON.stringify(measured)}`);
        // The figure itself is in the failure, so a miss says where the time went.
        expect({ appends: appends.mock.calls.length <= 20, settledUnder2s: ms < 2000, measured }).toEqual({ appends: true, settledUnder2s: true, measured: expect.objectContaining({ settleMs: expect.any(Number), lockWaitMs: expect.any(Number) }) });
    }, 60_000);

    it('CONTROL: one row emitted alone is written alone, at once', async () => {
        const r = rig();
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'w', provider: 'claude', name: 'wren' });
        r.host.start(record, dir);
        await r.host.settled();
        const appends = vi.spyOn(ThreadStore.prototype, 'appendLog');
        r.host.prompt(record.id, 'just this', 'you');
        await r.host.settled();
        expect(appends.mock.calls.length).toBeGreaterThanOrEqual(1);
        const history = await readWholeHistory(openDurableStore(sessionsDir(dir)), record.id);
        expect(history.rows.some((row) => row.event.kind === 'message' && (row.event as { text: string }).text === 'just this')).toBe(true);
    });
});
