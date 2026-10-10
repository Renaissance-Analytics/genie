import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import {
    AgentSession,
    type DriverEvents,
    type SessionDriver,
    type SessionDriverFactory,
} from '../src/core/session.js';

/**
 * A RUNNING AGENT — driver, mapper, thread.
 *
 * The driver is injected, so these exercise the real wiring without spawning a provider CLI.
 * That is deliberate and it is not the whole story: a fake driver can prove the plumbing and
 * can never prove the protocol. The live check — a real Claude session, a real reply, and a
 * process scan after stop — is `test/live/` and runs against the real binary.
 *
 * Both exist because the build this replaces had a green suite and a broken product four
 * times running.
 */
const dirs: string[] = [];
function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'genie2-session-'));
    dirs.push(d);
    return d;
}
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A driver that records what it was asked to do and lets a test push updates. */
function fakeDriver() {
    const calls = { started: 0, prompts: [] as string[], kills: [] as (string | undefined)[] };
    let events: DriverEvents = {};
    let running = false;
    let cliSessionId: string | null = null;
    let seenResume: string | undefined;

    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        seenResume = options.resumeSessionId;
        const driver: SessionDriver = {
            start: () => { calls.started += 1; running = true; },
            prompt: (t) => { calls.prompts.push(t); },
            kill: (s) => { calls.kills.push(s); running = false; },
            get running() { return running; },
            get cliSessionId() { return cliSessionId; },
        };
        return driver;
    };

    return {
        factory,
        calls,
        resumeSeen: () => seenResume,
        setSessionId: (id: string) => { cliSessionId = id; },
        emit: (u: Record<string, unknown>) => events.onUpdate?.(u),
        exit: () => events.onExit?.(0, null),
    };
}

describe('AgentSession', () => {
    it('writes every mapped update into the agent thread', async () => {
        const dir = tempDir();
        const store = openDurableStore(dir);
        const id = mintAgentId();
        const d = fakeDriver();

        const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: d.factory });
        session.start();

        d.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } });
        d.emit({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Bash', title: 'npm test' });
        await vi.waitFor(async () => {
            expect(await openAgentThread(store, id).count()).toBe(2);
        });

        const rows = await openAgentThread(store, id).messages();
        expect(rows.map((r) => (r.message as { kind: string }).kind)).toEqual(['message', 'tool']);
    });

    it('does NOT write updates that are not ledger rows', async () => {
        const dir = tempDir();
        const store = openDurableStore(dir);
        const id = mintAgentId();
        const d = fakeDriver();

        new AgentSession({ agentId: id, cwd: dir, store, driverFactory: d.factory }).start();
        d.emit({ sessionUpdate: 'available_commands_update', availableCommands: [] });

        // POSITIVE CONTROL in the same test: a real row still lands, so "nothing was written"
        // cannot pass against a session whose persistence is simply broken.
        d.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });

        await vi.waitFor(async () => {
            expect(await openAgentThread(store, id).count()).toBe(1);
        });
    });

    it('starting twice REATTACHES — it never makes a second copy of the agent', () => {
        const dir = tempDir();
        const d = fakeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        });

        session.start();
        session.start();

        // The old build's `start` could create a second agent beside the first. One driver.
        expect(d.calls.started).toBe(1);
    });

    it('passes a resume id to the driver as a CONSTRUCTOR option', () => {
        // prism-acp has no `resume()` method — resume is `resumeSessionId` at construction,
        // surfaced over the wire as ACP `session/load`. Pinned so a refactor cannot quietly
        // start a fresh conversation while the UI says "resumed".
        const dir = tempDir();
        const d = fakeDriver();

        new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir),
            driverFactory: d.factory, resumeSessionId: 'thread_abc',
        }).start();

        expect(d.resumeSeen()).toBe('thread_abc');
    });

    it('omits the resume id entirely on a fresh start', () => {
        const dir = tempDir();
        const d = fakeDriver();

        new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        }).start();

        expect(d.resumeSeen()).toBeUndefined();
    });

    it('stop kills the driver and the session stops reporting itself as running', () => {
        const dir = tempDir();
        const d = fakeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        });

        session.start();
        expect(session.running).toBe(true);   // POSITIVE CONTROL: it was really up.

        session.stop();

        expect(d.calls.kills).toHaveLength(1);
        expect(session.running).toBe(false);
        expect(session.turnState).toBe('stopped');
    });

    it('surfaces the provider session id only once the provider reports one', () => {
        const dir = tempDir();
        const d = fakeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        });
        session.start();

        // `null` = not yet reported. Never a placeholder, because a resume keyed on a made-up
        // id starts a fresh conversation while claiming to continue one.
        expect(session.cliSessionId).toBeNull();

        d.setSessionId('sess_9f21');
        expect(session.cliSessionId).toBe('sess_9f21');
    });

    it('COUNTS rows it could not persist rather than losing them silently', async () => {
        const dir = tempDir();
        const id = mintAgentId();
        const d = fakeDriver();
        const broken = {
            ...openDurableStore(dir),
            get: async () => null,
            put: async () => { throw new Error('disk gone'); },
            forget: async () => {},
            withLock: async <T,>(_k: string, cb: () => T | Promise<T>) => cb(),
            durability: () => 'durable' as const,
        };

        const session = new AgentSession({ agentId: id, cwd: dir, store: broken, driverFactory: d.factory });
        session.start();
        d.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lost?' } });

        // A storage fault must not take the turn down — and must not vanish either. A surface
        // can say "this conversation is not being saved" rather than showing a partial one.
        await vi.waitFor(() => expect(session.unpersistedEvents).toBe(1));
    });
});
