import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore, HarnessError, type SessionStore } from '@particle-academy/prism-harness';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId, threadKeyFor } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';

/**
 * A ROW THE THREAD COULD NOT TAKE AT ONCE IS KEPT, NOT DROPPED (genie#1315).
 *
 * Every row an agent's session writes goes through the thread's lock (prism-harness `withLock`), which waits 5 s for a
 * holder and then throws `session_locked`. The session caught that, counted it in `unpersistedEvents` — which nothing
 * reads — and went on: the row was gone from the agent's history for good, and nobody was told. Measured on
 * genie-test-windows with the real store (2026-10-27): a thread lock held 10 s (a previous run's write cut off inside its
 * TTL) cost the first turn's marker, and the turn count read from the record afterwards was 1 short.
 *
 * A held lock clears — its holder finishes, or its TTL runs out and the next waiter reclaims it — and so do Windows'
 * transient EPERM/EBUSY/EACCES on a file another process has open. So such a write is tried again, a bounded number of
 * times, in order on the session's chain. What still cannot be saved is said in the agent's ledger, once — never only
 * counted.
 */
const dirs: string[] = [];
function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'genie2-kept-'));
    dirs.push(d);
    return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function session(store: SessionStore, dir: string, onEvent?: (e: StreamEvent) => void) {
    let events: DriverEvents = {};
    const factory = ((options: { events: DriverEvents }) => {
        events = options.events;
        let running = false;
        return { start: () => { running = true; }, prompt: () => {}, kill: () => { running = false; }, get running() { return running; }, get cliSessionId() { return null; } };
    }) as unknown as SessionDriverFactory;
    const agentId = mintAgentId();
    const s = new AgentSession({ agentId, cwd: dir, store, driverFactory: factory, processTree: noProcessTree, ...(onEvent ? { onEvent } : {}) });
    s.start();
    return { s, agentId, end: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }) };
}

describe('a thread write that meets a held lock', () => {
    it('is written once the lock is free — the turn marker is not lost', async () => {
        const dir = tempDir();
        const store = openDurableStore(dir);
        const { s, agentId } = session(store, dir);
        // Another writer holds this thread's lock for longer than one write waits (5 s): the real store, a second instance,
        // the real lock file.
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        let taken!: () => void;
        const isTaken = new Promise<void>((r) => { taken = r; });
        const holder = new FileSessionStore(dir).withLock(threadKeyFor(agentId), async () => { taken(); await held; }, 30, 1);
        await isTaken;
        setTimeout(release, 6000);

        s.prompt('hello', 'you');
        await s.settled();
        await holder;

        const { rows } = await readHistory(store, agentId);
        expect(rows.map((r) => r.event.kind)).toEqual(['turn', 'message']);
        expect(s.unpersistedEvents).toBe(0);
    }, 30_000);
});

describe('a thread write that cannot be saved', () => {
    it('is said in the ledger, once, however many rows it costs', async () => {
        const dir = tempDir();
        const failing: SessionStore = {
            ...openDurableStore(dir),
            durability: () => 'durable' as const,
            withLock: async () => { throw new Error('disk gone'); },
        };
        const said: StreamEvent[] = [];
        const { s, end } = session(failing, dir, (e) => said.push(e));
        s.prompt('hello', 'you');
        end();
        await s.settled();

        expect(s.unpersistedEvents).toBeGreaterThanOrEqual(3);
        const notices = said.filter((e) => e.kind === 'notice' && e.level === 'error' && /not being saved/.test(e.message));
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ message: expect.stringContaining('disk gone') });
    });

    it('stops trying after a bounded number of attempts when the lock never frees', async () => {
        const dir = tempDir();
        let attempts = 0;
        const locked: SessionStore = {
            ...openDurableStore(dir),
            durability: () => 'durable' as const,
            withLock: async () => { attempts += 1; throw new HarnessError('session_locked', 'held'); },
        };
        const said: StreamEvent[] = [];
        const { s } = session(locked, dir, (e) => said.push(e));
        s.prompt('hello', 'you');
        await s.settled();

        // Two rows (the turn and your message), each tried a bounded number of times — not forever, not once.
        expect(attempts).toBeGreaterThan(2);
        expect(attempts).toBeLessThanOrEqual(2 * 4);
        expect(s.unpersistedEvents).toBe(2);
        expect(said.filter((e) => e.kind === 'notice' && /not being saved/.test(e.message))).toHaveLength(1);
    }, 30_000);
});
