import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionStore } from '@particle-academy/prism-harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';
import { sessionsDir } from '../src/main/paths.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A QUIT WAITS FOR THE ROWS THE STOP WROTE (beta.35 plan; measured first).
 *
 * The quit's shutdown pass ran `host.stopAll()` and returned, and Electron then exits WITHOUT running what is still
 * queued. Measured in Electron 44.7 on omarchy-test (2026-10-21), a thread write still in flight when before-quit
 * returned: 0 of 10 reached the file when it was queued in the shutdown pass (a cancelled approval, the reply a killed
 * provider's exit closes), 0 of 10 when it was queued just before the quit was asked (the running-set write's wait is
 * shorter than a thread append) — and every one of those 20 left the thread's `.lock` behind. The positive control
 * (preventDefault, await the write, then exit) kept it 10 of 10.
 *
 * `settled()` alone is not the wait: a stopped agent's reply is queued by its provider's EXIT, which arrives after the
 * stop returns — after a wait that began at once had already looked. `drained()` waits for those exits (bounded), then
 * for every queued write.
 */
const gate = vi.hoisted(() => {
    let release: () => void = () => {};
    let held: Promise<void> | null = null;
    return {
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
        // The real file store with its `put` held at the gate, inside the lock — where a real write spends its time.
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

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let host: SessionHost | null = null;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-quit-drain-')); gate.waiting = 0; host = null; });
afterEach(async () => {
    gate.open();
    await host?.drained(0);
    await vi.waitFor(() => expect(gate.waiting).toBe(0));
    await rm(dir, { recursive: true, force: true });
});

/** One agent whose driver is held here, so the test decides when its provider "exits". */
function hostWithAgent(): { host: SessionHost; record: ReturnType<typeof agentRecord>; events: () => DriverEvents } {
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => ((options: { events: DriverEvents }) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    }) as unknown as SessionDriverFactory;
    const h = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'acme', provider: 'claude', name: 'wren' });
    expect(h.start(record, dir)).toEqual({ ok: true });
    return { host: h, record, events: () => events };
}

const said = async (agentId: ReturnType<typeof mintAgentId>) =>
    (await readHistory(openDurableStore(sessionsDir(dir)), agentId)).rows.flatMap((r) => (r.event.kind === 'message' ? [r.event.text] : []));

describe('SessionHost.drained(): what a quit waits for after stopAll()', () => {
    it('waits for the reply a killed provider’s EXIT writes — an exit that arrives after the wait began', async () => {
        const made = hostWithAgent();
        host = made.host;
        made.host.prompt(made.record.id, 'hello', 'you');
        await made.host.settled();
        // A reply streaming at quit: shown, and written only when the provider's exit closes it.
        void made.events().onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } });
        made.host.stopAll();

        let done = false;
        const draining = made.host.drained(2_000).then(() => { done = true; });
        // The provider ends a moment later, as a killed process does.
        await tick(30);
        expect(done).toBe(false); // its exit has not come: the reply is not even queued yet
        made.events().onExit?.(null, 'SIGTERM');
        await draining;
        // Read the moment it resolves — no polling: drained() is the claim that the rows are there.
        expect(await said(made.record.id)).toEqual(['hello', 'on it']);
    });

    it('waits for a write already in flight, and only as long as it takes', async () => {
        const made = hostWithAgent();
        host = made.host;
        gate.hold();
        made.host.prompt(made.record.id, 'hello', 'you');
        await vi.waitFor(() => expect(gate.waiting).toBe(1)); // positive control: a write is IN the store, held
        made.host.stopAll();
        made.events().onExit?.(null, 'SIGTERM');

        let done = false;
        const draining = made.host.drained(2_000).then(() => { done = true; });
        await tick(30);
        expect(done).toBe(false); // held: drained cannot have resolved
        gate.open();
        await draining;
        expect(await said(made.record.id)).toEqual(['hello']);
    });

    it('is BOUNDED: a provider that never reports its exit does not hold the quit past the bound', async () => {
        const made = hostWithAgent();
        host = made.host;
        made.host.stopAll();
        const started = Date.now();
        await made.host.drained(50);
        expect(Date.now() - started).toBeLessThan(1_000);
    });
});

/**
 * main.ts is Electron-only, so its few load-bearing lines are checked from source. Line comments are stripped line by
 * line (CRLF-safe). Counted.
 */
const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
const count = (re: RegExp) => (main.match(re) ?? []).length;

describe('the quit’s shutdown pass (main.ts before-quit)', () => {
    it('holds the quit, drains the sessions’ writes (bounded), and only then quits again', () => {
        // The hold is taken in the shutdown pass, with the stop.
        expect(count(/if \(step === 'pass'\) return;\s*event\.preventDefault\(\);\s*host\?\.stopAll\(\);/g)).toBe(1);
        // The pass ends by starting the wait: the call is the handler's last statement.
        expect(count(/clearGenieRunning\(genieHome\(\)\);\s*void drainWritesThenQuit\(\);\s*\}\);/g)).toBe(1);
        expect(count(/void drainWritesThenQuit\(\);/g)).toBe(1);
        // The wait — host.drained — bounded, and app.quit() only once it is over (the re-entry is the 'pass' step).
        expect(count(/host\?\.drained\(QUIT_EXIT_WAIT_MS\)/g)).toBe(1);
        expect(count(/setTimeout\(r, QUIT_WRITES_MS\)/g)).toBe(1);
        expect(count(/\.finally\(\(\) => \{ clearTimeout\(bound\); app\.quit\(\); \}\)/g)).toBe(1);
    });
});
