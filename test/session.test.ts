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
    type TurnOutcomeLike,
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
        setRunning: (value: boolean) => { running = value; },
        emit: (u: Record<string, unknown>) => events.onUpdate?.(u),
        exit: () => events.onExit?.(0, null),
        // Typed as the interface, not inferred from the default — inference narrows
        // `stopReason` to `'end_turn'` and `raw` to `null`, so a test could not pass a crash.
        endTurn: (outcome: TurnOutcomeLike = { stopReason: 'end_turn', isError: false, raw: null }) =>
            events.onTurnEnd?.(outcome),
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

describe('a turn ending — the signal without which every agent reads Working forever', () => {
    it('returns to IDLE when the provider reports the turn finished', async () => {
        /**
         * `turnState` went to `working` on a prompt and only ever to `stopped` on exit. With
         * `--input-format stream-json` the CLI **stays alive across turns**, so the process
         * does not exit between them — and every agent anyone had ever prompted would read
         * `Working` on the Dashboard forever, with a duration counting up.
         *
         * `onTurnEnd` is a separate driver event from `onExit` for exactly this reason:
         * prism-acp's own comment says a server that conflated them would resolve every prompt
         * only when the agent shut down.
         */
        const dir = tempDir();
        const d = fakeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        });

        session.start();
        session.prompt('go');
        expect(session.turnState).toBe('working');

        d.endTurn();
        expect(session.turnState).toBe('idle');
    });

    it('records a turn that did not finish cleanly as BROKEN, not idle', () => {
        // `stopReason: null` is prism-acp refusing to name a reason for a crash — ACP's five
        // reasons all describe a turn that FINISHED. Reporting `idle` there would present a
        // crashed turn as a completed one.
        const dir = tempDir();
        const d = fakeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        });

        session.start();
        d.endTurn({ stopReason: null, isError: true, raw: 'api error' });

        expect(session.turnState).toBe('failed');
        expect(session.failure).toBe('api error');
    });

    it('counts turns, because the budget panel has to come from somewhere real', () => {
        const dir = tempDir();
        const d = fakeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        });

        session.start();
        expect(session.turns).toBe(0);

        d.endTurn();
        d.endTurn();
        expect(session.turns).toBe(2);

        // A turn that failed still happened, and still cost something.
        d.endTurn({ stopReason: null, isError: true, raw: 'api error' });
        expect(session.turns).toBe(3);
    });

    it('a CANCELLED turn is idle, not failed', () => {
        // Cancelling is something the human did. Painting it as a fault would blame the agent
        // for being stopped.
        const dir = tempDir();
        const d = fakeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        });

        session.start();
        d.endTurn({ stopReason: 'cancelled', isError: false, raw: 'cancelled' });

        expect(session.turnState).toBe('idle');
        expect(session.failure).toBeNull();
    });
});

describe('a driver that does not expose `running` — which CodexDriver does not', () => {
    /**
     * Measured in prism-acp 0.6.1: `ClaudeDriver` has a `running` getter and **`CodexDriver`
     * does not**, and the shared `AgentDriver` interface does not declare one either.
     *
     * `AgentSession.running` read `this.#driver?.running ?? false`, so for codex it answered
     * `undefined ?? false` — **false**. A working codex agent would have reported "not
     * running", which is `idle` on the Dashboard with no duration: an agent burning tokens
     * while the board says nothing is happening.
     *
     * Nothing would have caught it, because every existing test used a fake driver that HAS
     * the property. So the fake here deliberately omits it.
     */
    function codexLikeDriver() {
        let events: DriverEvents = {};
        let killed = false;
        const factory: SessionDriverFactory = (options) => {
            events = options.events;
            // No `running` getter. This is the real shape of CodexDriver.
            return {
                start: () => {},
                prompt: () => {},
                kill: () => { killed = true; },
                get cliSessionId() { return null; },
            };
        };
        return { factory, exit: () => events.onExit?.(0, null), wasKilled: () => killed };
    }

    it('reports RUNNING after start, from the session’s own bookkeeping', () => {
        const dir = tempDir();
        const d = codexLikeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        });

        expect(session.running).toBe(false);
        session.start();
        expect(session.running).toBe(true);
    });

    it('reports NOT running once the provider exits', () => {
        const dir = tempDir();
        const d = codexLikeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        });

        session.start();
        d.exit();
        expect(session.running).toBe(false);
    });

    it('reports NOT running after a stop', () => {
        const dir = tempDir();
        const d = codexLikeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        });

        session.start();
        session.stop();
        expect(session.running).toBe(false);
        expect(d.wasKilled()).toBe(true);
    });

    it('still prefers a driver that DOES report it — a more direct reading than our own', () => {
        // POSITIVE CONTROL, and the reason this is not simply "own the flag and ignore the
        // driver": a provider process can die without an exit event reaching us, and
        // `ClaudeDriver.running` is closer to the truth than our bookkeeping is.
        const d = fakeDriver();
        const dir = tempDir();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
        });

        session.start();
        expect(session.running).toBe(true);
        d.setRunning(false);
        expect(session.running).toBe(false);
    });
});
