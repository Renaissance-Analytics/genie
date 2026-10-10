import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { agentRowFor } from '../src/core/roster.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { SessionHost, providerBinary, type DriverFor } from '../src/main/session-host.js';

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

/** A driver shaped like `CodexDriver`: no `running` getter. The harder of the two shapes. */
const fakeDriverFor: DriverFor = (record) => {
    if (record.provider === 'claude' || record.provider === 'codex') {
        const factory: SessionDriverFactory = (options) => {
            events = options.events;
            return {
                start: () => {},
                prompt: () => {},
                kill: () => { killed += 1; },
                get cliSessionId() { return null; },
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
    killTree: (pids) => { reaped = [...reaped, pids]; },
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-host-'));
    killed = 0;
    reaped = [];
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
        expect(live?.failure).toEqual({ reason: 'api error 529', fixes: ['Restart'] });

        // And it reaches the Dashboard as `broken`, which is the join that matters.
        expect(agentRowFor(r, live, () => now)).toMatchObject({ state: 'broken', reason: 'api error 529' });
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
        for (let i = 0; i < 5; i += 1) {
            events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${i}` } });
        }

        const ids = host.rowsFor(r.id).map((row) => row.id);
        expect(new Set(ids).size).toBe(5);
        expect(ids.every((id) => id.startsWith(r.id))).toBe(true);
    });

    it('is EMPTY for an agent that has never run, which is not an error', () => {
        expect(host.rowsFor(record().id)).toEqual([]);
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
