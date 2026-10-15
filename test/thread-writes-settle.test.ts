import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionStore } from '@particle-academy/prism-harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';
import { sessionsDir } from '../src/main/paths.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A ROW IS SHOWN BEFORE IT IS WRITTEN — and until now nothing could wait for the write.
 *
 * `agent-history.test.ts` failed one full suite in three on genie-test (2026-10-15) and passed on its own; on the same
 * day `turn-end-notify.test.ts` failed at FILE level about as often. The diagnosis (the error text was not captured, so
 * this is the hypothesis the next genie-test run confirms — look for ENOTEMPTY): not the history logic, which is
 * deterministic, but the teardown. Both tests end the moment the LEDGER (or the state) shows what they wait for, while
 * the session's thread writes — a lock file, a temporary file, a rename, the store folder re-created by `mkdir` — are
 * still in flight. Their teardown removes the folder under those writes, and a recursive remove that finds an entry
 * created between its listing and its `rmdir` fails ENOTEMPTY: agent-history's afterEach (reported as the test failing),
 * turn-end-notify's afterAll (reported as an error outside tests). Under load the writes outlast the test's last 50 ms
 * poll, which is why only the full suite saw it.
 *
 * The race is made DETERMINISTIC here by holding the store's write open (`gate`), instead of hoping load produces it:
 *  1. the window exists — the ledger has the row, the thread does not (passes on the base: the condition, reproduced);
 *  2. a folder removed inside that window comes back when the write lands (passes on the base: the mechanism);
 *  3. `AgentSession.settled()` and `SessionHost.settled()` wait the window out — including a STOPPED agent's rows,
 *     which are written after `stop` returns (RED on the base: there was nothing to wait on).
 */
const gate = vi.hoisted(() => {
    let release: () => void = () => {};
    let held: Promise<void> | null = null;
    return {
        /** Writes entered and now held at the gate — so a test knows a write is IN FLIGHT, not merely queued. */
        waiting: 0,
        hold(): void { held = new Promise<void>((r) => { release = r; }); },
        open(): void { held = null; release(); },
        get held(): Promise<void> | null { return held; },
    };
});

vi.mock('../src/core/thread-store.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../src/core/thread-store.js')>();
    return {
        ...real,
        // The real file store, with its `put` held at the gate — INSIDE the lock, after the lock file exists, which is
        // exactly where a real write spends its time on a loaded disk.
        openDurableStore: (directory: string): SessionStore => {
            const store = real.openDurableStore(directory);
            return {
                durability: () => store.durability(),
                get: (key) => store.get(key),
                async put(key, payload, ttlSeconds) {
                    const held = gate.held;
                    if (held) { gate.waiting += 1; await held; gate.waiting -= 1; }
                    return store.put(key, payload, ttlSeconds);
                },
                forget: (key) => store.forget(key),
                withLock<T>(key: string, callback: () => T | Promise<T>, ttlSeconds?: number, waitSeconds?: number): Promise<T> {
                    return store.withLock(key, callback, ttlSeconds, waitSeconds);
                },
            };
        },
    };
});

const noProcessTree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
function fakeFactory(): SessionDriverFactory {
    return () => {
        const driver: SessionDriver = { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
        return driver;
    };
}
const kindsOnDisk = async (directory: string, agentId: ReturnType<typeof mintAgentId>) =>
    (await readHistory(openDurableStore(directory), agentId)).rows.map((r) => r.event.kind);
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
const writers: { settled(): Promise<void> }[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-settle-')); writers.length = 0; gate.waiting = 0; });
afterEach(async () => {
    gate.open();
    // This file's own teardown, done the way the fix says: wait for the writes, then remove. `settled` is looked up
    // rather than called blind so a run on the base reports the assertion that is red, not a teardown TypeError on top.
    await Promise.all(writers.map((w) => (typeof w.settled === 'function' ? w.settled() : Promise.resolve())));
    await vi.waitFor(() => expect(gate.waiting).toBe(0));
    await rm(dir, { recursive: true, force: true });
});

function startSession(store: string): { session: AgentSession; shown: StreamEvent[] } {
    const shown: StreamEvent[] = [];
    const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(store), driverFactory: fakeFactory(), processTree: noProcessTree, onEvent: (e) => shown.push(e) });
    writers.push(session);
    session.start();
    return { session, shown };
}

describe('a row on screen is not yet a row on disk', () => {
    it('the window exists: the ledger has the turn and the message while the thread has neither', async () => {
        gate.hold();
        const { session, shown } = startSession(dir);
        session.prompt('hello', 'you');
        // On screen at once — synchronously, by design.
        expect(shown.map((e) => e.kind)).toEqual(['turn', 'message']);
        // Held IN the write (positive control: the gate really is in the path, or "nothing on disk" proves nothing).
        await vi.waitFor(() => expect(gate.waiting).toBe(1));
        expect(await kindsOnDisk(dir, session.agentId)).toEqual([]);
        gate.open();
        await vi.waitFor(async () => expect(await kindsOnDisk(dir, session.agentId)).toEqual(['turn', 'message']));
    });

    it('a folder removed inside that window comes back when the write lands — what the teardowns raced', async () => {
        const store = join(dir, 'sessions');
        gate.hold();
        const { session } = startSession(store);
        session.prompt('hello', 'you');
        await vi.waitFor(() => expect(gate.waiting).toBe(1));
        await rm(store, { recursive: true, force: true });
        expect(existsSync(store)).toBe(false);
        gate.open();
        // The write re-creates the folder the teardown had just removed, with the thread in it. Interleaved with the
        // remove's own walk instead of after it, that new entry is the ENOTEMPTY. Looked at with readdir, NOT through a
        // store: opening a FileSessionStore creates its folder, which would make this pass on its own.
        await vi.waitFor(() => expect(readdirSync(store).filter((f) => f.endsWith('.json'))).toHaveLength(1));
        expect(await kindsOnDisk(store, session.agentId)).toEqual(['turn', 'message']);
    });
});

describe('settled(): what a teardown — or anything that treats the thread as finished — waits for', () => {
    it('a session’s settled() resolves only once every row it showed is in its thread', async () => {
        gate.hold();
        const { session } = startSession(dir);
        session.prompt('hello', 'you');
        await vi.waitFor(() => expect(gate.waiting).toBe(1));
        let done = false;
        const settling = session.settled().then(() => { done = true; });
        await tick(30);
        expect(done).toBe(false); // the write is held: settled cannot have resolved
        gate.open();
        await settling;
        // Read the moment it resolves — no polling: settled() is the claim that the rows are there.
        expect(await kindsOnDisk(dir, session.agentId)).toEqual(['turn', 'message']);
    });

    it('a host’s settled() waits for a STOPPED agent’s rows too — they are written after stop() returns', async () => {
        let events: DriverEvents = {};
        const driverFor: DriverFor = () => ((options: { events: DriverEvents }) => {
            events = options.events;
            return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
        }) as unknown as SessionDriverFactory;
        const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
        writers.push(host);
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'acme', provider: 'claude', name: 'wren' });
        expect(host.start(record, dir)).toEqual({ ok: true });
        gate.hold();
        host.prompt(record.id, 'hello', 'you');
        // A reply streaming when the agent is stopped: shown, and written only when the provider's exit closes it.
        void events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } });
        expect(host.stop(record.id)).toBe(true);
        events.onExit?.(0, null);
        await vi.waitFor(() => expect(gate.waiting).toBe(1));

        let done = false;
        const settling = host.settled().then(() => { done = true; });
        await tick(30);
        expect(done).toBe(false); // the stopped agent's writes are held: the host must not call itself settled
        gate.open();
        await settling;
        const said = (await readHistory(openDurableStore(sessionsDir(dir)), record.id)).rows.flatMap((r) => (r.event.kind === 'message' ? [r.event.text] : []));
        expect(said).toEqual(['hello', 'on it']);
    });
});
