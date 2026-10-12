import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { agentRowFor } from '../src/core/roster.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { SessionHost, driverEvents, providerBinary, type DriverFor } from '../src/main/session-host.js';

/**
 * THE RUNNING AGENTS.
 *
 * The driver is injected, so these exercise the real host without spawning a provider CLI.
 * The real drivers are proved by `npm run verify:live` against the actual binary — a fake
 * driver proves the plumbing and can never prove the protocol.
 */

let dir: string;
let host: SessionHost;
let events: DriverEvents = {};
let killed = 0;
let now = 1_760_000_000_000;
let reportedSessionId: string | null = null;

/** A driver shaped like `CodexDriver`: no `running` getter. The harder of the two shapes. */
const fakeDriverFor: DriverFor = (record) => {
    if (record.provider === 'claude' || record.provider === 'codex') {
        const factory: SessionDriverFactory = (options) => {
            events = options.events;
            return {
                start: () => {},
                prompt: () => {},
                kill: () => { killed += 1; },
                // Reported by the PROVIDER, after its init frame — so a test can only set it
                // through this, never by constructing a record with it already in place.
                get cliSessionId() { return reportedSessionId; },
            };
        };
        return factory;
    }
    return null;
};

/**
 * A process tree that OBSERVES and never touches the machine.
 *
 * Without this the suite used the real one: on Windows that shells out to PowerShell to
 * enumerate descendants and then kills whatever appeared between start and stop — in a test
 * runner with parallel workers, that is a live sibling process. It also made a test that does
 * no I/O take six and a half seconds, which is how the problem surfaced: as a flake.
 */
let reaped: readonly (readonly number[])[] = [];
const noProcessTree: ProcessTree = {
    descendantsOf: () => [],
    killTree: (pids) => { reaped = [...reaped, pids]; return { killed: pids.length, refused: false }; },
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-host-'));
    killed = 0;
    reaped = [];
    reportedSessionId = null;
    now = 1_760_000_000_000;
    host = new SessionHost({
        userData: dir, driverFor: fakeDriverFor, clock: () => now, processTree: noProcessTree,
    });
});

afterEach(async () => {
    host.stopAll();

    /**
     * `maxRetries`, and it is not papering over a logic bug.
     *
     * The session persists each ledger row with a fire-and-forget append, which is correct:
     * a row must land even if the caller has moved on, and the session counts the ones that
     * fail so a storage fault is reportable rather than silent. `stop()` therefore does not
     * await writes that are already in flight — it stops the PROVIDER, which is what stop
     * means.
     *
     * On Windows that races the directory removal: `ENOTEMPTY` on `runtime/sessions`. The tell
     * that it was a race and not an assertion was the failing test NAMES moving between runs.
     */
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (over: Partial<Parameters<typeof agentRecord>[0]> = {}): AgentRecord =>
    agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas', ...over });

describe('starting', () => {
    it('REATTACHES rather than creating a second session', () => {
        /**
         * §6.2. The alternative is two provider processes answering as one agent, which is how
         * a user ends up with something they cannot stop — and the count never comes down.
         */
        const r = record();

        expect(host.start(r, dir)).toEqual({ ok: true });
        expect(host.count).toBe(1);

        expect(host.start(r, dir)).toEqual({ ok: true });
        expect(host.count).toBe(1);
    });

    it('counts SESSIONS, and the count is the map’s size', () => {
        // Never a process scan, never `ptys.length`. The previous build counted ptys, which is
        // why removing ptys from agents broke fifty-two tests.
        host.start(record({ name: 'a' }), dir);
        host.start(record({ name: 'b' }), dir);
        expect(host.count).toBe(2);
    });

    it('REFUSES a provider it cannot drive, and says so — it does not fall back to a terminal', () => {
        /**
         * `null` from the driver factory means **cannot run as an agent**, never "fall back to
         * a terminal". That fallback is the one rule this whole rebuild exists for, and the
         * refusal has to be visible: the agent stays registered and idle with a reason, which
         * is recoverable, where a silent no-op is not.
         */
        const result = host.start(record({ provider: 'kimi' as never }), dir);

        expect(result.ok).toBe(false);
        expect(host.count).toBe(0);
        expect([...host.refusals.values()][0]).toContain('cannot run');
    });

    it('clears a previous refusal when a later start succeeds', () => {
        const bad = record({ provider: 'kimi' as never });
        host.start(bad, dir);
        expect(host.refusals.size).toBe(1);

        const good = record();
        host.start(good, dir);
        expect(host.refusals.has(good.id)).toBe(false);
    });
});

describe('probing — what the Dashboard reads', () => {
    it('reports NULL for an agent with no session', () => {
        expect(host.probe(record().id)).toBeNull();
    });

    it('reports a started agent as RUNNING even though the driver has no `running` getter', () => {
        // The codex shape. `driver?.running ?? false` would have answered false here, and the
        // board would have shown a working agent as idle.
        const r = record({ provider: 'codex' });
        host.start(r, dir);

        expect(host.probe(r.id)).toMatchObject({ running: true, turnState: 'working' });
    });

    it('claims NO context, delivery, collaborators or ask until something reports them', () => {
        // COUNT over every nullable field. A `?? 0` in `probe` would lose the whole discipline
        // for every row on the Dashboard at once, and it is one character.
        const r = record();
        host.start(r, dir);
        const live = host.probe(r.id);

        const nullable = [
            live?.contextUsed, live?.contextSize, live?.lastDelivery,
            live?.collaborators, live?.commsAgeSeconds, live?.plan, live?.pendingApproval, live?.failure,
        ];
        expect(nullable.filter((v) => v !== null && v !== undefined)).toEqual([]);
    });

    it('passes a REPORTED context figure through, which is the positive control', () => {
        const r = record();
        host.start(r, dir);
        events.onUpdate?.({ sessionUpdate: 'usage_update', used: 182_000, size: 200_000 });

        expect(host.probe(r.id)).toMatchObject({ contextUsed: 182_000, contextSize: 200_000 });
    });

    it('takes the LATEST usage report, not the first', () => {
        const r = record();
        host.start(r, dir);
        events.onUpdate?.({ sessionUpdate: 'usage_update', used: 10_000, size: 200_000 });
        events.onUpdate?.({ sessionUpdate: 'usage_update', used: 46_000, size: 200_000 });

        expect(host.probe(r.id)?.contextUsed).toBe(46_000);
    });

    it('reports a plan from the agent’s own entries, and NOT a fabricated 0/0', () => {
        const r = record();
        host.start(r, dir);

        expect(host.probe(r.id)?.plan).toBeNull();

        events.onUpdate?.({
            sessionUpdate: 'plan_update',
            entries: [
                { content: 'Challenge table', status: 'completed' },
                { content: 'Enrolment endpoint', status: 'in_progress' },
            ],
        });
        expect(host.probe(r.id)?.plan).toEqual({ step: 1, of: 2, doing: 'Enrolment endpoint' });
    });

    it('surfaces a FAILED turn as a broken row with a route out', () => {
        const r = record();
        host.start(r, dir);
        events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'api error 529' });

        const live = host.probe(r.id);
        // A failed TURN with the provider still up: no exit yet.
        expect(live?.failure).toEqual({ reason: 'api error 529', fixes: ['Restart'], exit: null });

        // And it reaches the Dashboard as `broken`, which is the join that matters.
        expect(agentRowFor(r, live, () => now)).toMatchObject({ state: 'broken', reason: 'api error 529' });
    });

    it('reports a provider that DIED with the reason it gave on the way out', () => {
        /**
         * The join that was broken, at the layer the UI reads.
         *
         * `probe()` reports a failure only when `turnState === 'failed'`, and every failing
         * provider exits straight afterwards — so the exit overwrote `failed` with `stopped`
         * and this method returned `failure: null` for every real crash. The session had the
         * provider's own words the whole time.
         *
         * Measured on CI in a real window: a codex agent whose cwd did not exist produced
         * `{"running":false,"turnState":"stopped","failure":null}` on screen, while prism-acp
         * had said `failed to spawn Codex (Error)`.
         */
        const r = record();
        host.start(r, dir);

        events.onProtocolError?.('failed to spawn Codex (Error)');
        events.onExit?.(1, null);

        const live = host.probe(r.id);
        // And HOW it died, as node reported it — the Process ended block reads `exit 1` from this.
        expect(live?.failure).toEqual({ reason: 'failed to spawn Codex (Error)', fixes: ['Restart'], exit: { code: 1, signal: null } });
        expect(live?.running).toBe(false);

        // And the Dashboard reads it as broken, with the reason on the row — the whole point.
        expect(agentRowFor(r, live, () => now)).toMatchObject({
            state: 'broken',
            reason: 'failed to spawn Codex (Error)',
        });
    });

    it('does NOT call a clean exit broken', () => {
        /**
         * POSITIVE CONTROL, computed through the same two calls as the test above so it cannot
         * drift away from it. Without this, the fix "treat every exit as a failure" passes the
         * test above — and then stopping an agent on purpose paints a red row, which is how a
         * board teaches people to ignore red.
         */
        const r = record();
        host.start(r, dir);

        events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        events.onExit?.(0, null);

        const live = host.probe(r.id);
        expect(live?.failure).toBeNull();
        expect(live?.turnState).toBe('stopped');
        expect(agentRowFor(r, live, () => now)).not.toMatchObject({ state: 'broken' });
    });

    it('gives a failed turn a reason even when the provider gave none', () => {
        // `stopReason: null` with no `raw` is a crash the CLI did not explain. "Broken" with no
        // reason is an unactionable row; saying the provider gave no reason at least tells the
        // reader where the gap is.
        const r = record();
        host.start(r, dir);
        events.onTurnEnd?.({ stopReason: null, isError: true, raw: null });

        expect(host.probe(r.id)?.failure?.reason).toContain('gave no reason');
    });
});

describe('a workspace folder that is not there', () => {
    /**
     * The failure that cost most to diagnose in this build, because it reported the wrong
     * layer.
     *
     * A seeded workspace pointed at a path that existed in the smoke container and not on a CI
     * runner. Genie handed the missing directory to prism-acp, which spawned, failed, and said
     * `failed to spawn Codex (Error)`. That sentence sent me to the provider — I measured the
     * wrong spawn, wrote a commit blaming a library that handles the case correctly, and put
     * the wrong reason in a CI workflow. The cause was a missing folder.
     *
     * Genie knows the path before it spawns anything. Checking it is the difference between a
     * row that names the fix and a row that names the wrong component.
     *
     * §6.2: diagnose "names a CAUSE and the repair that fits".
     */
    it('refuses to start, and names the FOLDER rather than the provider', () => {
        const r = record();
        const missing = join(dir, 'not-a-real-folder');

        const result = host.start(r, missing);

        expect(result).toMatchObject({ ok: false });
        expect(result.ok === false && result.reason).toContain(missing);
        // The provider is never blamed for a folder that is not there.
        expect(result.ok === false && result.reason.toLowerCase()).not.toContain('spawn');
    });

    it('consumes no capacity and leaves no half-started row', () => {
        // The same discipline as the synchronous-throw path: a session that never ran must not
        // hold a slot, and must not read as running with no process behind it.
        const r = record();

        host.start(r, join(dir, 'not-a-real-folder'));

        expect(host.count).toBe(0);
        expect(host.probe(r.id)).toBeNull();
        expect(host.refusals.get(r.id)).toContain('not-a-real-folder');
    });

    it('starts normally when the folder IS there', () => {
        /**
         * POSITIVE CONTROL. Without it, "refuses when the folder is missing" passes on a build
         * that refuses always — which would stop every agent on the machine and report it as a
         * missing directory.
         */
        const r = record();

        expect(host.start(r, dir)).toEqual({ ok: true });
        expect(host.count).toBe(1);
    });

    it('refuses a path that exists but is a FILE', () => {
        // A repo entry pointing at `project.json` instead of its folder is an ordinary typo,
        // and `existsSync` alone would wave it through to the same opaque spawn failure.
        const r = record();
        const file = join(dir, 'project.json');
        writeFileSync(file, '{}');

        const result = host.start(r, file);

        expect(result).toMatchObject({ ok: false });
        expect(result.ok === false && result.reason).toContain(file);
    });
});

describe('the provider’s thread id — captured, guarded, and handed back', () => {
    /**
     * P1's done-when says the thread survives a restart. It did at the session layer, where a
     * `resumeSessionId` passed in is passed through — and **nothing in the app ever stored
     * one**, so restarting Genie began a fresh conversation every time while every test about
     * resume passed. The session was asked to resume an id the app never kept.
     *
     * The id arrives from the provider, which is what makes capturing it the same job as
     * guarding it: see `threadIdIsResumable`. It is written down once and then looks like
     * configuration, which is exactly what makes it dangerous — it ends up in argv.
     */
    it('reports the id the provider gave, so it can be persisted', () => {
        const r = record();
        const seen: Array<{ id: string; threadId: string }> = [];
        host = new SessionHost({
            userData: dir, driverFor: fakeDriverFor, clock: () => now, processTree: noProcessTree,
            onThreadId: (id, threadId) => seen.push({ id, threadId }),
        });

        host.start(r, dir);
        // Nothing yet: the provider has not said who it is.
        expect(seen).toEqual([]);

        reportedSessionId = '01a12564-30a8-7961-8aa9-6d145dd2e179';
        events.onUpdate?.({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'started' } });

        expect(seen).toEqual([{ id: r.id, threadId: '01a12564-30a8-7961-8aa9-6d145dd2e179' }]);
    });

    it('reports it ONCE, not on every frame after it', () => {
        // A provider emits hundreds of updates per turn. Reporting on each would rewrite
        // `agents.json` hundreds of times per turn — a disk write per token.
        const r = record();
        const seen: string[] = [];
        host = new SessionHost({
            userData: dir, driverFor: fakeDriverFor, clock: () => now, processTree: noProcessTree,
            onThreadId: (_id, threadId) => seen.push(threadId),
        });
        host.start(r, dir);
        reportedSessionId = 'sess-ABC.123';

        for (let i = 0; i < 20; i += 1) {
            events.onUpdate?.({ sessionUpdate: 'notice', notice: { level: 'debug', message: `f${i}` } });
        }

        expect(seen).toEqual(['sess-ABC.123']);
    });

    it('does NOT report an id it would not be willing to hand back', () => {
        /**
         * COUNTED, and at the EARLIEST point Genie controls. The value is untrusted when it
         * arrives, not when it is read back — so guarding only on read would protect against a
         * tampered file and not against the provider that chose the string.
         */
        const hostile = ['a&echo PWNED', 'a|b', 'a&&b', 'two words', 'a$(b)', 'a;b'];
        const accepted: string[] = [];

        for (const value of hostile) {
            const r = record();
            host = new SessionHost({
                userData: dir, driverFor: fakeDriverFor, clock: () => now, processTree: noProcessTree,
                onThreadId: (_id, threadId) => accepted.push(threadId),
            });
            host.start(r, dir);
            reportedSessionId = value;
            events.onUpdate?.({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'x' } });
        }

        expect(accepted).toEqual([]);
        // And it is not thrown away in silence: a provider that cannot be resumed is a real
        // degradation, and the reason names the value so it is diagnosable.
        expect(host.unusableThreadIds.size).toBe(1);
    });

    it('refuses to RESUME a stored id that is not well formed, and names it', () => {
        /**
         * The other end of the same guard, for a file edited by something that is not Genie.
         * §6.2: a graceful resume that cannot happen **refuses** rather than silently starting
         * a new chat — a fresh conversation presented as a resumed one is how a day's context
         * disappears without a message.
         */
        const r = { ...record(), threadId: 'a&echo PWNED' };

        const result = host.start(r, dir);

        expect(result).toMatchObject({ ok: false });
        expect(result.ok === false && result.reason).toContain('a&echo PWNED');
        expect(host.count).toBe(0);
    });

    it('resumes a well-formed one, which is the control that keeps the guard honest', () => {
        // POSITIVE CONTROL. Without it, "refuses a malformed id" passes on a build that
        // refuses every resume — which would quietly mean no agent ever resumes anything.
        const r = { ...record(), threadId: '01a12564-30a8-7961-8aa9-6d145dd2e179' };

        expect(host.start(r, dir)).toEqual({ ok: true });
        expect(host.count).toBe(1);
    });
});

describe('the ledger', () => {
    it('timestamps rows AS THEY ARRIVE, because the wire carries no time', () => {
        const r = record();
        host.start(r, dir);

        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } });
        now += 4_200;
        events.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Bash', title: 'npm test' });

        const rows = host.rowsFor(r.id);
        expect(rows.map((row) => row.at)).toEqual([1_760_000_000_000, 1_760_000_004_200]);
    });

    it('gives every row a UNIQUE id, prefixed by the agent it belongs to', () => {
        const r = record();
        host.start(r, dir);

        /*
         * Five DISTINCT rows, which is why this is not five message chunks.
         *
         * It was, and the fixture stopped producing five rows the moment consecutive chunks
         * began coalescing into one message — correctly. The rule under test is unrelated to
         * coalescing: every row the UI holds needs its own id, prefixed by its agent. So the
         * fixture changed and the assertion did not.
         */
        for (let i = 0; i < 5; i += 1) {
            events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${i}` } });
            events.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: `t${i}`, name: 'Bash', title: `step ${i}` });
        }

        const ids = host.rowsFor(r.id).map((row) => row.id);
        expect(ids).toHaveLength(10);
        expect(new Set(ids).size).toBe(10);
        expect(ids.every((id) => id.startsWith(r.id))).toBe(true);
    });

    it('is EMPTY for an agent that has never run, which is not an error', () => {
        expect(host.rowsFor(record().id)).toEqual([]);
    });
});

describe('a streamed reply is ONE row in the ledger the UI reads', () => {
    /**
     * THE HALF I MISSED, and the way I missed it is the lesson.
     *
     * The session coalesces chunks into one message and persists it once. I tested that, and I
     * tested that it tells the host to REPLACE rather than append — **the flag**. I never
     * tested that the host acts on it. It did not: `onEvent` pushed every emission, so three
     * chunks became three rows whose texts were each a longer prefix of the last.
     *
     * The live resume check showed it: `zephyr-3704e zephyr-3704e9a6`. On screen that is the
     * reply repeated with a growing prefix, which is worse than the fragments it replaced.
     *
     * Asserting the flag is asserting that a message was SENT. This asserts what a reader
     * actually gets, which is a COUNT — and a count is the only form of this assertion that
     * could have failed.
     */
    it('holds one row for a reply that arrived in three chunks', () => {
        const r = record();
        host.start(r, dir);

        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'zephyr-' } });
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '3704' } });
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'e9a6' } });

        const messages = host.rowsFor(r.id).filter((row) => row.event.kind === 'message');
        expect(messages).toHaveLength(1);
        expect(messages[0]?.event).toMatchObject({ speaker: 'agent', text: 'zephyr-3704e9a6' });
    });

    it('keeps the row’s identity while it grows, so the UI updates rather than re-adds', () => {
        // A row whose id changed on every chunk would remount on every frame — losing a
        // selection, a scroll position and the Inspector's subject mid-reply.
        const r = record();
        host.start(r, dir);

        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } });
        const firstId = host.rowsFor(r.id)[0]?.id;
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } });

        expect(host.rowsFor(r.id)[0]?.id).toBe(firstId);
    });

    it('keeps its ARRIVAL time, not the time of the last chunk', () => {
        // The ledger's times are arrival times. A row that re-stamped itself per chunk would
        // report a message as having happened when it FINISHED, which moves it in the timeline
        // and drags Lanes with it.
        const r = record();
        host.start(r, dir);

        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } });
        const at = host.rowsFor(r.id)[0]?.at;
        now += 5_000;
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } });

        expect(host.rowsFor(r.id)[0]?.at).toBe(at);
    });

    it('still appends when the row is a DIFFERENT thing', () => {
        /**
         * POSITIVE CONTROL. Without it, "one row for three chunks" passes on a host that
         * replaces the last row every time — which would collapse an entire turn into a single
         * row and lose every tool call in it.
         */
        const r = record();
        host.start(r, dir);

        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'looking' } });
        events.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Bash', title: 'npm test' });
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'found it' } });

        expect(host.rowsFor(r.id).map((row) => row.event.kind)).toEqual(['message', 'tool', 'message']);
    });
});

describe('stopping', () => {
    it('frees the slot, so the count is honest', () => {
        /**
         * The previous build returned `ok: true` while leaving the provider alive: the owner
         * had agents they could not stop AND a capacity figure that never came back down.
         */
        const r = record();
        host.start(r, dir);
        expect(host.count).toBe(1);

        expect(host.stop(r.id)).toBe(true);
        expect(host.count).toBe(0);
        expect(killed).toBe(1);
        expect(host.probe(r.id)).toBeNull();
    });

    it('reports false for stopping something that is not running, rather than pretending', () => {
        expect(host.stop(record().id)).toBe(false);
    });

    it('stops EVERY session on stopAll — an upgrade ends them all and revives none', () => {
        host.start(record({ name: 'a' }), dir);
        host.start(record({ name: 'b' }), dir);
        host.start(record({ name: 'c' }), dir);

        host.stopAll();
        expect(host.count).toBe(0);
        expect(killed).toBe(3);
    });
});

describe('push', () => {
    it('notifies on start, on every ledger row, and on stop', () => {
        const seen = vi.fn();
        const off = host.subscribe(seen);
        const r = record();

        host.start(r, dir);
        expect(seen).toHaveBeenCalledTimes(1);

        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
        expect(seen).toHaveBeenCalledTimes(2);

        host.stop(r.id);
        expect(seen).toHaveBeenCalledTimes(3);

        off();
        host.start(r, dir);
        expect(seen).toHaveBeenCalledTimes(3);
    });

    it('notifies on a REFUSAL too — a refusal nobody is told about is a silent no-op', () => {
        const seen = vi.fn();
        host.subscribe(seen);
        host.start(record({ provider: 'kimi' as never }), dir);
        expect(seen).toHaveBeenCalledTimes(1);
    });
});

describe('the process tree the host uses', () => {
    it('is the one it was GIVEN — the host never reaches for the system one itself', () => {
        /**
         * Found by a flake, which is the point.
         *
         * `AgentSession` falls back to the real system process tree when none is injected. On
         * Windows that shells out to PowerShell to enumerate descendants and then **kills**
         * whatever appeared between start and stop — so every unit test that started a session
         * was spawning a shell and calling `killTree` on live pids, in a runner with parallel
         * workers.
         *
         * The symptom was one failing run of a test that does no I/O, at 6.5 seconds. The
         * duration was the tell; the assertion below is what stops it coming back.
         */
        const r = record();
        host.start(r, dir);
        host.stop(r.id);

        // The reap went through the injected tree — exactly once, for this session.
        expect(reaped).toHaveLength(1);
    });

    it('reaps only what it owns, and the injected tree reports none', () => {
        // `descendantsOf` returns nothing here, so the owned set is empty and the reap is a
        // no-op. That is the correct shape for a test: assert the call, not the carnage.
        const r = record();
        host.start(r, dir);
        host.stop(r.id);
        expect(reaped[0]).toEqual([]);
    });
});

describe('which provider binary to run', () => {
    /**
     * Real configuration, not a test hook — and the distinction is the one the previous build
     * got wrong. Its `GENIE_E2E` env var CHANGED BEHAVIOUR: it short-circuited the
     * single-instance lock, so the suite exercised an application that behaved differently
     * from the shipped one, and the measured result was two instances opening windows on the
     * owner's desktop while real agents were mid-turn.
     *
     * A binary path changes nothing about how Genie behaves. It is the same need a user with
     * an nvm install, a pinned version or a non-standard path has, and the toolchain manager
     * exists to answer it.
     */
    it('uses the provider default when nothing is configured', () => {
        expect(providerBinary('claude', {})).toBeUndefined();
        expect(providerBinary('codex', {})).toBeUndefined();
    });

    it('honours a configured path, per provider', () => {
        const env = { GENIE2_CLAUDE_BINARY: '/opt/claude/bin/claude', GENIE2_CODEX_BINARY: '/opt/codex' };

        expect(providerBinary('claude', env)).toBe('/opt/claude/bin/claude');
        expect(providerBinary('codex', env)).toBe('/opt/codex');
    });

    it('does NOT let one provider’s path be used for another', () => {
        // The failure this prevents is subtle and would be baffling: Genie launching claude
        // and getting codex, because one variable was read for both.
        const env = { GENIE2_CLAUDE_BINARY: '/opt/claude' };

        expect(providerBinary('claude', env)).toBe('/opt/claude');
        expect(providerBinary('codex', env)).toBeUndefined();
    });

    it('treats an EMPTY value as unset rather than as an empty path', () => {
        // `GENIE2_CLAUDE_BINARY=` in a shell profile sets it to the empty string. Passing that
        // through would spawn `""` and fail with something that names neither the variable nor
        // the cause.
        expect(providerBinary('claude', { GENIE2_CLAUDE_BINARY: '' })).toBeUndefined();
        expect(providerBinary('claude', { GENIE2_CLAUDE_BINARY: '   ' })).toBeUndefined();
    });

    it('reads the ambient environment when none is passed', () => {
        /**
         * The production call site passes nothing, so the default has to actually work.
         *
         * `vi.stubEnv` is scoped and restored by the runner — this is not the forbidden thing
         * of mutating the machine's environment to make a test pass, it is a fixture that
         * exists only inside this assertion.
         *
         * An earlier version asserted `providerBinary.length === 2`, which is false:
         * `Function.length` counts parameters BEFORE the first default, so it is 1. The
         * assertion was about the signature when the claim was about the behaviour.
         */
        expect(providerBinary('claude')).toBeUndefined();

        vi.stubEnv('GENIE2_CLAUDE_BINARY', '/opt/claude/bin/claude');
        expect(providerBinary('claude')).toBe('/opt/claude/bin/claude');
        vi.unstubAllEnvs();

        // And it is gone again, so the stub did not leak into the rest of the suite.
        expect(providerBinary('claude')).toBeUndefined();
    });
});

describe('every driver event the session offers is FORWARDED', () => {
    /**
     * The bug this exists for: `onRequestPermission` was never passed to the driver.
     *
     * The approval feature was built, unit-tested at every layer — the narrowing, the session's
     * promise handling, the host, the bridge, the UI, the one-place-only rule — and it was
     * **unreachable in the running application**, because the one line that hands the handler
     * to the provider did not exist.
     *
     * Every test passed because every test drove `AgentSession` directly with a fake driver
     * that called `events.onRequestPermission` itself. Nothing exercised the real wiring.
     *
     * That is §0.4 exactly: a finished feature behind a missing connection, with a green suite.
     * So this asserts the WIRING rather than the feature, and it counts rather than spot-checks
     * — a forwarder that handles five of six events passes any test that only looks at one.
     */
    it('forwards all of them, counted against what the session provides', () => {
        const seen: string[] = [];

        // Every event `DriverEvents` declares. Written out, because the point is to notice when
        // the interface grows and the forwarder does not.
        const events = {
            onUpdate: () => seen.push('onUpdate'),
            onRequestPermission: async () => { seen.push('onRequestPermission'); return { outcome: 'cancelled' as const }; },
            onTurnEnd: () => seen.push('onTurnEnd'),
            onProtocolError: () => seen.push('onProtocolError'),
            onStderr: () => seen.push('onStderr'),
            onExit: () => seen.push('onExit'),
        };

        const forwarded = driverEvents(events);

        // Fire each one through the forwarder and record what arrived.
        forwarded.onUpdate?.({ sessionUpdate: 'x' } as never);
        void forwarded.onRequestPermission?.({ toolCall: {}, options: [] } as never);
        forwarded.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null } as never);
        forwarded.onProtocolError?.('x');
        forwarded.onStderr?.('x');
        forwarded.onExit?.(0, null);

        expect(seen.sort()).toEqual(
            ['onExit', 'onProtocolError', 'onRequestPermission', 'onStderr', 'onTurnEnd', 'onUpdate'].sort(),
        );
    });

    it('forwards nothing the session did not provide — no invented handlers', () => {
        // POSITIVE CONTROL in the other direction: with an empty session, calling a forwarded
        // handler must be a safe no-op rather than a crash, because `DriverEvents` members are
        // all optional and a session may genuinely not want one.
        const forwarded = driverEvents({});

        expect(() => forwarded.onUpdate?.({ sessionUpdate: 'x' } as never)).not.toThrow();
        expect(() => forwarded.onStderr?.('x')).not.toThrow();
        expect(() => forwarded.onExit?.(0, null)).not.toThrow();
    });
});

describe('a provider that THROWS on spawn', () => {
    /**
     * Measured on the owner's Windows machine, with the real binary:
     *
     *     spawn('C:\...\npm\codex.cmd', ['app-server', ...])  ->  EINVAL, thrown SYNCHRONOUSLY
     *
     * npm installs CLIs on Windows as `.cmd` shims, and Node refuses to spawn one without
     * `shell: true` (the CVE-2024-27980 fix). `claude` happens to be a `.exe` there so it is
     * fine; `codex` is a `.cmd` and is not.
     *
     * The throw is SYNCHRONOUS, so it never reaches `onExit` or `onProtocolError` — it
     * propagates straight out of `start()`. And the renderer calls `openAgent` through
     * `void ipcRenderer.invoke(...)`, which swallows a rejection.
     *
     * So clicking a codex agent on Windows did **nothing at all, silently**. No row went red,
     * no message, no console error. The same silent-failure class as the dropped
     * `onProtocolError`, arriving by a different door.
     */
    function throwingDriverFor(code: string): DriverFor {
        return () => () => {
            const error = new Error(`spawn ${code}`) as NodeJS.ErrnoException;
            error.code = code;
            throw error;
        };
    }

    it('reports the failure instead of letting it escape', () => {
        const host = new SessionHost({
            userData: dir, driverFor: throwingDriverFor('EINVAL'), processTree: noProcessTree,
        });
        const r = record();

        const result = host.start(r, dir);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toContain('EINVAL');
    });

    it('leaves NO half-started session behind', () => {
        // A session in the map that never started is capacity consumed by nothing, and a row
        // that reads as running when no process exists.
        const host = new SessionHost({
            userData: dir, driverFor: throwingDriverFor('EINVAL'), processTree: noProcessTree,
        });
        const r = record();

        host.start(r, dir);

        expect(host.count).toBe(0);
        expect(host.probe(r.id)).toBeNull();
    });

    it('records it as a REFUSAL, so the surface can show it', () => {
        // The refusal is what reaches the UI. Without it the agent is simply idle, which is
        // indistinguishable from one nobody has started.
        const host = new SessionHost({
            userData: dir, driverFor: throwingDriverFor('EINVAL'), processTree: noProcessTree,
        });
        const r = record();

        host.start(r, dir);

        expect(host.refusals.get(r.id)).toContain('EINVAL');
    });

    it('names the BINARY in the reason when one is configured', () => {
        // "spawn EINVAL" alone sends somebody to the wrong place. The path is the whole
        // diagnosis on Windows, where the `.cmd` extension IS the cause.
        vi.stubEnv('GENIE2_CLAUDE_BINARY', 'C:/npm/claude.cmd');
        const host = new SessionHost({
            userData: dir, driverFor: throwingDriverFor('EINVAL'), processTree: noProcessTree,
        });
        const r = record();

        host.start(r, dir);

        expect(host.refusals.get(r.id)).toContain('claude.cmd');
        vi.unstubAllEnvs();
    });

    it('still starts normally when the driver does NOT throw', () => {
        // POSITIVE CONTROL: the catch does not swallow a good start.
        const host = new SessionHost({
            userData: dir, driverFor: fakeDriverFor, processTree: noProcessTree,
        });

        expect(host.start(record(), dir)).toEqual({ ok: true });
        expect(host.count).toBe(1);
    });
});
