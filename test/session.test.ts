import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { openAgentThread, openDurableStore, readHistory } from '../src/core/thread-store.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import {
    AgentSession,
    type DriverEvents,
    type SessionDriver,
    type SessionDriverFactory,
    type PermissionRequestLike,
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

/**
 * A process tree that OBSERVES and never touches the machine.
 *
 * `AgentSession` falls back to the REAL system tree when none is injected. On Windows that
 * shells out to PowerShell to enumerate descendants and then **kills** whatever appeared
 * between start and stop — so this suite was spawning a shell per session and calling
 * `killTree` on live pids, in a runner with parallel workers.
 *
 * It also made this file take **25.8 seconds for 21 tests that do no I/O**. That was the tell,
 * and it surfaced as a flake in a sibling suite rather than as a failure here.
 */
let reaped: readonly (readonly unknown[])[] = [];
const noProcessTree: ProcessTree = {
    snapshot: () => [],
    killTree: (pids) => { reaped = [...reaped, pids]; return { killed: pids.length, refused: false }; },
};

beforeEach(() => { reaped = []; });

/** A driver that records what it was asked to do and lets a test push updates. */
function fakeDriver() {
    const calls = { started: 0, prompts: [] as (string | readonly unknown[])[], kills: [] as (string | undefined)[] };
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
        exit: (code: number | null = 0, signal: NodeJS.Signals | null = null) =>
            events.onExit?.(code, signal),
        // Typed as the interface, not inferred from the default — inference narrows
        // `stopReason` to `'end_turn'` and `raw` to `null`, so a test could not pass a crash.
        endTurn: (outcome: TurnOutcomeLike = { stopReason: 'end_turn', isError: false, raw: null }) =>
            events.onTurnEnd?.(outcome),
        // Typed as the interface, not inferred from the default — inference narrows
        // `toolCall` to `{ title: string }`, so a test could not pass the empty call that
        // exercises the refusal path.
        protocolError: (problem: string) => events.onProtocolError?.(problem),
        stderr: (line: string) => events.onStderr?.(line),
        askPermission: (
            request: PermissionRequestLike = {
                toolCall: { title: 'php artisan migrate --force' },
                options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
            },
        ) => events.onRequestPermission?.(request),
    };
}

describe('AgentSession', () => {
    it('writes every mapped update into the agent thread', async () => {
        const dir = tempDir();
        const store = openDurableStore(dir);
        const id = mintAgentId();
        const d = fakeDriver();

        const session = new AgentSession({
            agentId: id, cwd: dir, store, driverFactory: d.factory, processTree: noProcessTree,
        });
        session.start();

        d.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } });
        d.emit({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Bash', title: 'npm test' });
        // Waited for by the session's own `settled()`, not polled: `vi.waitFor` gives up after 1 s, and a ledger write
        // (a lock file, a temp file, a rename) outlasted that on a loaded windows-latest runner (beta.41's release PR,
        // run 39903276660). The write's own promise has no budget of its own to lose; the test's timeout still ends one
        // that never comes.
        await session.settled();
        expect(await openAgentThread(store, id).count()).toBe(2);

        const rows = await openAgentThread(store, id).messages();
        expect(rows.map((r) => (r.message as { kind: string }).kind)).toEqual(['message', 'tool']);
    });

    it('does NOT write updates that are not ledger rows', async () => {
        const dir = tempDir();
        const store = openDurableStore(dir);
        const id = mintAgentId();
        const d = fakeDriver();

        const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: d.factory, processTree: noProcessTree });
        session.start();
        d.emit({ sessionUpdate: 'available_commands_update', availableCommands: [] });

        // POSITIVE CONTROL in the same test: a real row still lands, so "nothing was written"
        // cannot pass against a session whose persistence is simply broken.
        d.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });

        /*
         * The turn ends, and THAT is when the message reaches the thread.
         *
         * A reply is one row built from a stream of chunks, so it is written once, when it
         * closes — not once per chunk, which would put a row in the thread every few tokens
         * and leave the joining rule to be re-implemented on read.
         *
         * Asserted EXACTLY: a growing message must not leave a trail of prefixes behind it, which is what per-chunk
         * writes produced. The one message, then the turn's `finished` row (beta.33 item 10: a clean turn end is recorded).
         */
        d.endTurn();

        // Waited for by the session's own `settled()`, not polled: `vi.waitFor` gives up after 1 s, and a ledger write
        // (a lock file, a temp file, a rename) outlasted that on a loaded windows-latest runner (beta.41's release PR,
        // run 39903276660). The write's own promise has no budget of its own to lose; the test's timeout still ends one
        // that never comes.
        await session.settled();
        expect((await openAgentThread(store, id).messages()).map((r) => (r.message as { kind: string }).kind)).toEqual(['message', 'finished']);
    });

    it('does not write a message that is still being streamed', async () => {
        /**
         * The new contract, stated so it cannot be quietly reverted. A message in flight is not
         * in the thread yet; it lands when the turn ends, a different speaker starts, or
         * another kind of row arrives.
         *
         * The cost is bounded and named: a provider killed mid-sentence loses that sentence
         * from Genie's ledger. `onExit` closes the message for every ordinary ending, and the
         * provider keeps its own transcript — which is a better trade than a thread full of
         * fragments nobody can read.
         */
        const dir = tempDir();
        const store = openDurableStore(dir);
        const id = mintAgentId();
        const d = fakeDriver();

        const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: d.factory, processTree: noProcessTree });
        session.start();
        d.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still typ' } });

        // Long enough for a write to have happened if one were going to.
        await new Promise((r) => setTimeout(r, 150));
        expect(await openAgentThread(store, id).count()).toBe(0);

        // POSITIVE CONTROL: it is not that persistence is broken — closing it writes it (and the turn's `finished` row).
        d.endTurn();
        // Waited for by the session's own `settled()`, not polled: `vi.waitFor` gives up after 1 s, and a ledger write
        // (a lock file, a temp file, a rename) outlasted that on a loaded windows-latest runner (beta.41's release PR,
        // run 39903276660). The write's own promise has no budget of its own to lose; the test's timeout still ends one
        // that never comes.
        await session.settled();
        expect((await openAgentThread(store, id).messages()).map((r) => (r.message as { kind: string }).kind)).toEqual(['message', 'finished']);
    });

    it('starting twice REATTACHES — it never makes a second copy of the agent', () => {
        const dir = tempDir();
        const d = fakeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
            processTree: noProcessTree,
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
            driverFactory: d.factory, resumeSessionId: 'thread_abc', processTree: noProcessTree,
        }).start();

        expect(d.resumeSeen()).toBe('thread_abc');
    });

    it('omits the resume id entirely on a fresh start', () => {
        const dir = tempDir();
        const d = fakeDriver();

        new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir),
            driverFactory: d.factory, processTree: noProcessTree,
        }).start();

        expect(d.resumeSeen()).toBeUndefined();
    });

    it('stop kills the driver and the session stops reporting itself as running', () => {
        const dir = tempDir();
        const d = fakeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
            processTree: noProcessTree,
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
            processTree: noProcessTree,
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

        const session = new AgentSession({ agentId: id, cwd: dir, store: broken, driverFactory: d.factory, processTree: noProcessTree });
        session.start();
        d.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lost?' } });
        // The write is attempted when the message closes, so the turn has to end for the
        // storage fault to happen at all.
        d.endTurn();

        // A storage fault must not take the turn down — and must not vanish either. A surface
        // can say "this conversation is not being saved" rather than showing a partial one.
        // Both rows the turn wrote are counted: the message and the turn's `finished` row (beta.33 item 10).
        await vi.waitFor(() => expect(session.unpersistedEvents).toBe(2));
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
            processTree: noProcessTree,
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
            processTree: noProcessTree,
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
            processTree: noProcessTree,
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
            processTree: noProcessTree,
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
            processTree: noProcessTree,
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
            processTree: noProcessTree,
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
            processTree: noProcessTree,
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
            processTree: noProcessTree,
        });

        session.start();
        expect(session.running).toBe(true);
        d.setRunning(false);
        expect(session.running).toBe(false);
    });
});

describe('a parked approval', () => {
    const ask = {
        toolCall: { title: 'php artisan migrate --force' },
        options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
    };

    function openSession() {
        const dir = tempDir();
        const d = fakeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: d.factory,
            processTree: noProcessTree,
        });
        session.start();
        return { d, session };
    }

    it('is held until a human answers, and the DRIVER waits on that promise', async () => {
        /**
         * The whole mechanism. `onRequestPermission` returns a promise, and the provider is
         * blocked on it — so resolving it is literally how the agent is unblocked. If this were
         * resolved eagerly with a default, every tool call would be auto-approved and the
         * approval UI would be decoration over an agent that never actually waited.
         */
        const { d, session } = openSession();

        const pending = d.askPermission(ask);
        expect(session.pendingApproval).toMatchObject({ question: 'php artisan migrate --force' });

        let settled = false;
        void pending?.then(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 20));
        expect(settled, 'the driver must still be waiting').toBe(false);

        session.answerApproval('allow');
        expect(await pending).toEqual({ outcome: 'selected', optionId: 'allow' });
        expect(session.pendingApproval).toBeNull();
    });

    it('answers with the provider’s own option id, not a word of ours', async () => {
        const { d, session } = openSession();
        const pending = d.askPermission(ask);
        session.answerApproval('deny');
        expect(await pending).toEqual({ outcome: 'selected', optionId: 'deny' });
    });

    it('REFUSES an option id the request did not offer', async () => {
        /**
         * The renderer is not trusted to send back a valid id, and a provider receiving one it
         * never offered is a protocol error at best. The approval stays parked, which is
         * recoverable; "answered with something meaningless" is not.
         */
        const { d, session } = openSession();
        const pending = d.askPermission(ask);

        expect(session.answerApproval('rm -rf /')).toBe(false);
        expect(session.pendingApproval).not.toBeNull();

        // POSITIVE CONTROL: a real id still works, so the refusal is a reading.
        expect(session.answerApproval('allow')).toBe(true);
        expect(await pending).toEqual({ outcome: 'selected', optionId: 'allow' });
    });

    it('CANCELS the request when the session stops, rather than leaving the driver hanging', async () => {
        // A promise nobody will ever resolve is a provider process waiting forever. `stop`
        // means stop, and that has to include the things stop is waiting on.
        const { d, session } = openSession();
        const pending = d.askPermission(ask);

        session.stop();
        expect(await pending).toEqual({ outcome: 'cancelled' });
        expect(session.pendingApproval).toBeNull();
    });

    it('does not park a request it cannot render, and cancels it immediately', async () => {
        // A request with no readable options cannot be answered by anyone. Parking it would
        // show a question with no buttons and block the agent on a human who has no way to
        // reply; cancelling returns a decision the provider understands.
        const { d, session } = openSession();
        const pending = d.askPermission({ toolCall: {}, options: [] });

        expect(await pending).toEqual({ outcome: 'cancelled' });
        expect(session.pendingApproval).toBeNull();
    });
});

describe('a provider that fails to start must not fail SILENTLY', () => {
    /**
     * Found while trying to get a real approval on screen: the stub provider never completed
     * its handshake and **nothing anywhere said so**. The agent sat idle, the board showed no
     * fault, and the only way to learn anything was to instrument the app by hand.
     *
     * `prism-acp` reports both `onProtocolError` and `onStderr`, and genie2's wiring dropped
     * them on the floor. A provider that cannot start is exactly the case where an agent
     * looking idle is the most expensive possible rendering — it is indistinguishable from one
     * that is simply waiting for you.
     */
    function open() {
        const dir = tempDir();
        const d = fakeDriver();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir),
            driverFactory: d.factory, processTree: noProcessTree,
        });
        session.start();
        return { d, session };
    }

    it('records a protocol error as a FAILURE, with the provider’s own words', () => {
        const { d, session } = open();

        d.protocolError('thread/start response did not contain thread.id');

        expect(session.turnState).toBe('failed');
        expect(session.failure).toBe('thread/start response did not contain thread.id');
    });

    it('keeps the FIRST protocol error, not the last', () => {
        /**
         * A failing handshake usually produces a cascade, and the later ones are consequences.
         * Reporting the most recent would show the symptom and bury the cause — which is the
         * same reason a stack trace is read from the top.
         */
        const { d, session } = open();

        d.protocolError('thread/start response did not contain thread.id');
        d.protocolError('transport closed');

        expect(session.failure).toBe('thread/start response did not contain thread.id');
    });

    it('keeps recent stderr, which is where a provider usually explains itself', () => {
        const { d, session } = open();

        d.stderr('codex: command not found');
        expect(session.recentStderr).toContain('codex: command not found');
    });

    it('bounds the stderr it keeps, because a chatty provider must not grow without limit', () => {
        // A provider logging a line a second would otherwise be an unbounded buffer in a
        // process that stays up for days.
        const { d, session } = open();
        for (let i = 0; i < 500; i += 1) d.stderr(`line ${i}`);

        expect(session.recentStderr.length).toBeLessThanOrEqual(50);
        // And it keeps the LATEST, because the last thing a dying provider says is the useful
        // part.
        expect(session.recentStderr.at(-1)).toBe('line 499');
    });

    it('does not invent a failure when the provider is merely chatty', () => {
        // POSITIVE CONTROL: stderr alone is not a fault. Plenty of tools log to it normally,
        // and a build that painted every one of them red would teach people to ignore red.
        const { d, session } = open();

        d.stderr('note: using cached index');
        expect(session.turnState).not.toBe('failed');
        expect(session.failure).toBeNull();
    });
});

describe('the UI is TOLD when something it renders changes', () => {
    /**
     * The defect: an approval parked and **nothing notified anybody**.
     *
     * `onEvent` fires for ledger rows, and the host re-emits on that — so the renderer learns
     * about a message or a tool call. A parked approval is not a ledger row: it happens inside
     * the driver's `onRequestPermission`, changes state the Dashboard and the Deck both render,
     * and fired nothing at all.
     *
     * Measured in a real window: the session held
     * `pendingApproval: { question: 'php artisan migrate --force', ... }` while the screen
     * showed nothing. The agent was blocked on a human who was never told.
     *
     * It would have surfaced eventually — the next ledger row pushes a snapshot — which is the
     * worst version: it works in testing, where something else always happens next, and hangs
     * in the one case that matters, where the agent has stopped precisely BECAUSE it is
     * waiting.
     */
    function openWatched() {
        const dir = tempDir();
        const d = fakeDriver();
        const changes: string[] = [];
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir),
            driverFactory: d.factory, processTree: noProcessTree,
            onStateChange: () => changes.push('change'),
        });
        session.start();
        return { d, session, changes };
    }

    const ask = {
        toolCall: { title: 'php artisan migrate --force' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    };

    it('notifies when an approval PARKS', () => {
        const { d, changes } = openWatched();
        const before = changes.length;

        d.askPermission(ask);

        expect(changes.length).toBeGreaterThan(before);
    });

    it('notifies when it is ANSWERED', async () => {
        const { d, session, changes } = openWatched();
        const pending = d.askPermission(ask);
        const before = changes.length;

        session.answerApproval('allow');
        await pending;

        expect(changes.length).toBeGreaterThan(before);
    });

    it('notifies when a TURN ENDS, which changes the state pill and the row', () => {
        const { d, changes } = openWatched();
        const before = changes.length;

        d.endTurn();

        expect(changes.length).toBeGreaterThan(before);
    });

    it('notifies when the provider FAILS, which is the row going red', () => {
        const { d, changes } = openWatched();
        const before = changes.length;

        d.protocolError('thread/start response did not contain thread.id');

        expect(changes.length).toBeGreaterThan(before);
    });

    it('does NOT notify for something nobody renders', () => {
        /**
         * POSITIVE CONTROL, in the other direction. A session that notified on every internal
         * tick would push a snapshot per stderr line from a chatty provider, and the push
         * channel would become the thing that makes the app slow.
         *
         * stderr is kept and is not a fault; nothing on screen changes when a line arrives.
         */
        const { d, changes } = openWatched();
        const before = changes.length;

        d.stderr('note: using cached index');

        expect(changes.length).toBe(before);
    });
});

describe('the EXIT that follows a failure must not erase the reason for it', () => {
    /**
     * THE DEFECT THIS SUITE EXISTS FOR, and it hid behind a suite that already tested both
     * halves separately.
     *
     * `onProtocolError` records the provider's own words and turns the state `failed` — proven
     * above. `onExit` sets `stopped`, because an exit code says nothing about what the provider
     * was doing. Both are right on their own. Together they are a bug, because **a provider
     * that fails ALWAYS exits afterwards**: the error arrives, the reason is stored, and the
     * exit a few milliseconds later overwrites `failed` with `stopped`.
     *
     * `SessionHost.probe()` then reports `failure: null`, because it asks
     * `turnState === 'failed'` — so the harder the failure, the more certainly its explanation
     * is thrown away. A provider that could not spawn at all is the worst case and the one
     * that renders as nothing whatsoever.
     *
     * Measured in a real window on CI: a codex agent whose working directory did not exist.
     * prism-acp reported `failed to spawn Codex (Error)` and then exited, and the screen showed
     * `{"running":false,"turnState":"stopped","failure":null}` — the app knew why and said
     * nothing. I then spent a commit blaming the wrong cause, which is what a swallowed reason
     * costs beyond the blank screen.
     *
     * An exit is not an eraser. It is the END of the story, not a replacement for it.
     */
    function openWatched() {
        const dir = tempDir();
        const d = fakeDriver();
        const changes: string[] = [];
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir),
            driverFactory: d.factory, processTree: noProcessTree,
            onStateChange: () => changes.push('change'),
        });
        session.start();
        return { d, session, changes };
    }

    it('still reads FAILED after the provider exits, and keeps the reason', () => {
        const { d, session } = openWatched();

        d.protocolError('failed to spawn Codex (Error)');
        d.exit(1, null);

        expect(session.turnState).toBe('failed');
        expect(session.failure).toBe('failed to spawn Codex (Error)');
    });

    it('reports STOPPED for a provider that ended with nothing wrong', () => {
        /**
         * POSITIVE CONTROL, and the whole reason the fix is not "always say failed".
         *
         * A session the user stopped, or one that finished and closed, is `stopped` and has no
         * failure. Without this the test above passes on a build that calls every exit a fault
         * — which would paint a red row every time somebody stops an agent on purpose, and
         * teach them to ignore red.
         */
        const { d, session } = openWatched();

        d.endTurn();
        d.exit(0, null);

        expect(session.turnState).toBe('stopped');
        expect(session.failure).toBeNull();
    });

    it('is not alive either way — the exit still means the provider is gone', () => {
        // The half that already worked, asserted so a fix to the state cannot quietly cost it.
        const { d, session } = openWatched();

        d.protocolError('transport closed');
        d.exit(1, null);

        expect(session.running).toBe(false);
    });

    it('notifies when the provider EXITS, because the row changes', () => {
        /**
         * `onExit` notified NOBODY. A provider dying mid-turn left the row reading `working`
         * until something unrelated pushed the next snapshot — and when a provider dies there
         * IS nothing next, which is precisely the case that matters. Same shape as the parked
         * approval that notified nobody, one handler along.
         */
        const { d, changes } = openWatched();
        const before = changes.length;

        d.exit(1, null);

        expect(changes.length).toBeGreaterThan(before);
    });
});

describe('a streamed reply is ONE message, not one row per chunk', () => {
    /**
     * Found by the live resume check, and only because its assertion used a random token.
     *
     * A reply arrives as a stream of `agent_message_chunk` frames. Each one was mapped to its
     * own `message` row and nothing joined them, so the recalled token came back as two rows —
     * `zephyr-bfd` and `ae2b6` — and the first turn's `OK` as `O` then `K`. On screen that is a
     * column of fragments, each with its own speaker label and timestamp, where §4.2 says a
     * message is one row of speaker, time and text.
     *
     * **Every existing test passed**, because they all assert that *a* message row exists and
     * renders. "A message reached the ledger" is half the behaviour, and a green assertion
     * naming half the behaviour is the defect shape this build keeps finding. A check asking
     * "does it remember" would have been satisfied by `zephyr-bfd` too; the token is what made
     * the fragmentation impossible to read as success.
     *
     * The rule: consecutive chunks from the SAME speaker are one message. Anything else
     * between them closes it, because a reply interrupted by a tool call is two things the
     * reader needs to see in order.
     */
    function open() {
        const dir = tempDir();
        const d = fakeDriver();
        const rows: StreamEvent[] = [];
        const replaced: boolean[] = [];
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir),
            driverFactory: d.factory, processTree: noProcessTree,
            onEvent: (event, meta) => { rows.push(event); replaced.push(meta?.replacesLast === true); },
        });
        session.start();
        return { d, session, rows, replaced };
    }

    const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

    it('joins consecutive chunks into one row, with the text intact', () => {
        const { d, rows } = open();

        d.emit(chunk('zephyr-bfd'));
        d.emit(chunk('ae2b6'));
        d.emit(chunk('!'));

        // Three frames arrived, so three emissions — a reader watches it type. But the LAST
        // emission carries the whole message and the two before it are superseded, which is
        // what `replacesLast` tells the host.
        const messages = rows.filter((r) => r.kind === 'message');
        expect(messages.at(-1)).toMatchObject({ speaker: 'agent', text: 'zephyr-bfdae2b6!' });
    });

    it('tells the host to REPLACE rather than append, after the first chunk', () => {
        const { d, replaced } = open();

        d.emit(chunk('a'));
        d.emit(chunk('b'));
        d.emit(chunk('c'));

        // The first is a new row; the rest update it. Without this the host would hold three
        // rows whose texts are each a prefix of the last.
        expect(replaced).toEqual([false, true, true]);
    });

    it('does NOT join two different speakers', () => {
        // POSITIVE CONTROL, and the thing a naive "join adjacent messages" would break: the
        // owner's own words merged into the agent's reply would misattribute both.
        const { d, rows } = open();

        d.emit(chunk('agent says'));
        d.emit({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'you say' } });

        const messages = rows.filter((r) => r.kind === 'message');
        expect(messages).toHaveLength(2);
        expect(messages.map((m) => m.kind === 'message' && m.text)).toEqual(['agent says', 'you say']);
    });

    it('does NOT join two different peers', () => {
        // Same rule one level down: `atlas → wren` and `kora → wren` are two messages, and
        // joining them would put one agent's words in another's mouth.
        const { d, rows } = open();

        d.emit({ sessionUpdate: 'session_message', from: 'atlas', content: { type: 'text', text: 'from atlas' } });
        d.emit({ sessionUpdate: 'session_message', from: 'kora', content: { type: 'text', text: 'from kora' } });

        expect(rows.filter((r) => r.kind === 'message')).toHaveLength(2);
    });

    it('closes the message when something else happens in between', () => {
        /**
         * A reply, a tool call, then more reply is three rows in that order — which is the
         * whole point of a ledger. Joining across the tool call would reorder the account of
         * what happened.
         */
        const { d, rows } = open();

        d.emit(chunk('looking'));
        d.emit({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'completed' });
        d.emit(chunk('found it'));

        expect(rows.map((r) => r.kind)).toEqual(['message', 'tool', 'message']);
        const messages = rows.filter((r) => r.kind === 'message');
        expect(messages.map((m) => m.kind === 'message' && m.text)).toEqual(['looking', 'found it']);
    });

    it('starts a new message on the next turn', () => {
        // Two turns are two replies even when nothing else came between them. Without this, a
        // whole conversation would accumulate into one unbounded row.
        const { d, rows } = open();

        d.emit(chunk('first answer'));
        d.endTurn();
        d.emit(chunk('second answer'));

        const messages = rows.filter((r) => r.kind === 'message');
        expect(messages.at(-1)).toMatchObject({ text: 'second answer' });
    });
});

describe('a FAILED run leaves its reason in the ledger, where a restart cannot erase it', () => {
    /**
     * 2026-10-22: a Codex agent's graceful restart died nine seconds in with "a codex app-server error", and the words
     * were gone before anyone could read them — the failure and the provider's stderr lived in this session's MEMORY
     * only, and the owner's Restart fresh replaced the session. Finding the cause took another agent reading three other
     * logs. So a run that ends failed writes ONE `error` notice to the ledger: the reason, the exit, and the last stderr
     * lines (where a provider explains itself). A clean exit writes nothing — a red line for every stop teaches people
     * to stop reading red.
     */
    function openOnDisk() {
        const dir = tempDir();
        const d = fakeDriver();
        const store = openDurableStore(dir);
        const agentId = mintAgentId();
        const session = new AgentSession({ agentId, cwd: dir, store, driverFactory: d.factory, processTree: noProcessTree });
        session.start();
        const errors = async () => (await readHistory(store, agentId)).rows.map((r) => r.event).filter((e) => e.kind === 'notice' && e.level === 'error') as Array<{ message: string }>;
        return { d, session, errors };
    }

    it('the reason, the exit and the provider’s last stderr lines are one error notice on disk', async () => {
        const { d, session, errors } = openOnDisk();
        d.stderr('loading thread 01a16563');
        d.stderr('Invalid request: unknown variant `none`, expected one of `notLoaded`, `summary`, `full`');
        d.protocolError('Codex app-server startup failed (RPC code -32600)');
        d.exit(1, null);
        await session.settled();
        const found = await errors();
        expect(found).toHaveLength(1);
        expect(found[0]!.message).toContain('Codex app-server startup failed (RPC code -32600)');
        expect(found[0]!.message).toContain('unknown variant `none`');
        expect(found[0]!.message).toMatch(/exit code 1/);
    });

    it('CONTROL: a run that ends cleanly writes no error', async () => {
        const { d, session, errors } = openOnDisk();
        d.stderr('just chatty logging');
        d.endTurn();
        d.exit(0, null);
        await session.settled();
        expect(await errors()).toEqual([]);
    });

    it('only the last stderr lines, so a chatty provider cannot flood the ledger', async () => {
        const { d, session, errors } = openOnDisk();
        for (let i = 0; i < 200; i++) d.stderr(`line ${i}`);
        d.protocolError('it broke');
        d.exit(1, null);
        await session.settled();
        const message = (await errors())[0]!.message;
        expect(message).toContain('line 199');
        expect(message).not.toMatch(/\bline 0\b/);
        expect(message.length).toBeLessThan(4000);
    });
});
