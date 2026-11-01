import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { headerActions, statePill, turnStopOffered } from '../src/core/agent-view.js';
import { chatContext } from '../src/core/chat-view.js';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { agentRowFor } from '../src/core/roster.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { SettingApplier, setModel, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { agentPrompter, type AgentSessionsPort } from '../src/main/flow-runner.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A SESSION WITH NO TURN IN FLIGHT IS NOT WORKING (the owner, 2026-11-01, on beta.55: "an agent should not show as
 * working when I haven't started it yet and all I did was change its config options like model or permissions").
 *
 * pa-ops was opened (opening an agent starts or reattaches it, main.ts `genie:open-agent`) and its settings edited. It
 * had never been prompted — no ledger row at all — yet its header read `● Turn 0 · running 0:24` with `Stop this turn`,
 * and the rail said `Working`. `AgentSession.start()` set `turnState = 'working'` with no turn running, so every reader
 * of `turnState` — the pill, the turn Stop, the rail, the chat line, the setting applier, a flow's prompt — saw a turn
 * that did not exist. A setting change on that agent then waited "until it finishes this turn", a turn that never came.
 *
 * Every POSITIVE control here prompts the same session and reads the same gauges as working, so an assertion that
 * "nothing is working" can be told apart from a gauge that can never say working.
 */

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

interface Fake { events: DriverEvents; prompts: string[]; becomeReady: () => Promise<void> }
const fakes = new Map<string, Fake>();

/** prism-acp's drivers, as far as this needs: Claude declares no `ready`, Codex does. Both can cancel a turn. */
const driverFor: DriverFor = (record) => {
    if (record.provider !== 'claude' && record.provider !== 'codex') return null;
    const factory: SessionDriverFactory = (options) => {
        let resolve: () => void = () => {};
        const ready = new Promise<void>((r) => { resolve = r; });
        const fake: Fake = { events: options.events, prompts: [], becomeReady: async () => { resolve(); await ready; await Promise.resolve(); } };
        fakes.set(record.id, fake);
        return {
            start: () => {},
            prompt: (content: unknown) => { fake.prompts.push(String(content)); },
            kill: () => {},
            cancel: () => {},
            cliSessionId: null,
            ...(record.provider === 'codex' ? { ready } : {}),
        };
    };
    return factory;
};

let dir: string;
let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-fresh-session-'));
    fakes.clear();
    host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree });
});
afterEach(async () => {
    host.stopAll();
    await host.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (over: Partial<Parameters<typeof agentRecord>[0]> = {}): AgentRecord =>
    agentRecord({ id: mintAgentId(), workspaceId: 'pa', provider: 'claude', name: 'pa-ops', ...over });
const now = () => 1_760_000_024_000;
const endTurn = (id: AgentId) => fakes.get(id)!.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
const chatLine = (r: AgentRecord) => chatContext({ agent: { id: r.id, name: r.name, provider: r.provider, fidelity: 'declared' }, session: host.probe(r.id), rows: [] }).text;

describe('an agent opened and never prompted', () => {
    it('the session itself reads idle: no turn in flight, ready for one (a driver with no `ready`, as Claude)', () => {
        const d = dir;
        const factory: SessionDriverFactory = () => ({ start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } });
        const session = new AgentSession({ agentId: mintAgentId(), cwd: d, store: openDurableStore(d), driverFactory: factory, processTree: noProcessTree });
        session.start();
        expect(session.turnState).toBe('idle');
        expect(session.inTurn).toBe(false);
        expect(session.promptable).toBe(true);
        // POSITIVE CONTROL: the same session, prompted, reads working.
        session.prompt('go', 'you');
        expect(session.turnState).toBe('working');
        void session.stop();
    });

    it('header, turn Stop, rail and chat line: no turn, no timer, no Stop, not Working — then a real turn reads as one', () => {
        const r = record();
        expect(host.start(r, dir)).toEqual({ ok: true });
        const probe = host.probe(r.id);
        expect(probe?.running).toBe(true);
        // The gauge is live: the driver CAN end a turn, so `Stop this turn` is withheld for want of a turn, not a cancel.
        expect(probe?.cancelTurn).toBe(true);

        const pill = statePill(probe, now, { turns: 0 });
        expect(pill.word).toBe('No turns yet');
        expect(pill.word).not.toMatch(/running/);
        expect(pill.elapsed).toBeNull();
        expect(turnStopOffered(probe)).toBe(false);
        expect(headerActions(probe, 'declared')).toMatchObject({ stop: false, restart: true, start: false });
        expect(agentRowFor(r, probe, now).state).toBe('idle');
        expect(chatLine(r)).toBe('Idle');

        // POSITIVE CONTROL: prompted, every one of those gauges says a turn is running.
        expect(host.prompt(r.id, 'check the queue', 'you')).toBe(true);
        const busy = host.probe(r.id);
        expect(statePill(busy, now, { turns: 1 }).word).toBe('Turn 1 · running');
        expect(turnStopOffered(busy)).toBe(true);
        expect(headerActions(busy, 'declared').stop).toBe(true);
        expect(agentRowFor(r, busy, now).state).toBe('working');
        expect(chatLine(r)).toBe('Working');

        // And the turn ending puts it back.
        endTurn(r.id);
        expect(agentRowFor(r, host.probe(r.id), now).state).toBe('idle');
    });

    it('still STARTING (a driver that declares `ready`, as Codex): not working either; a prompt sent meanwhile opens its turn at ready, and that is announced', async () => {
        const r = record({ provider: 'codex' });
        host.start(r, dir);
        expect(host.probe(r.id)?.turnState).toBe('idle');
        expect(agentRowFor(r, host.probe(r.id), now).state).toBe('idle');

        expect(host.prompt(r.id, 'hello', 'you')).toBe(true);
        // Queued for `ready`: nothing is running yet, so nothing says so.
        expect(fakes.get(r.id)!.prompts).toEqual([]);
        expect(host.probe(r.id)?.turnState).toBe('idle');

        const seen: string[] = [];
        const off = host.subscribe((id) => { if (id === r.id) seen.push(host.probe(r.id)?.turnState ?? 'none'); });
        await fakes.get(r.id)!.becomeReady();
        off();
        expect(fakes.get(r.id)!.prompts).toEqual(['hello']);
        expect(host.probe(r.id)?.turnState).toBe('working');
        // ANNOUNCED: a listener (the board, the inbox push, a flow) learns the turn began, not only that it later ended.
        expect(seen).toContain('working');
    });

    it('activity before any turn (a provider talking on its own at start) is shown as working, with no turn marker invented', () => {
        const r = record();
        host.start(r, dir);
        fakes.get(r.id)!.events.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'in_progress' });
        expect(host.probe(r.id)?.turnState).toBe('working');
        expect(host.rowsFor(r.id).map((row) => row.event.kind)).toEqual(['tool']);
    });
});

describe('a setting changed on that agent', () => {
    function ports(r: AgentRecord) {
        let current = r;
        const calls: string[] = [];
        const p = {
            registry: {
                find: (id: string) => (id === current.id ? current : null),
                clearThread: async () => { current = { ...current, threadId: null }; return current; },
                setModel: async (_id: string, model: string | null) => { current = { ...current, ...(model === null ? {} : { model }) }; return current; },
            },
            host: {
                start: (rec: AgentRecord) => { calls.push('start'); return host.start(rec, dir); },
                stop: (id: AgentId) => { calls.push('stop'); return host.stop(id); },
                ended: (id: AgentId) => host.ended(id),
                probe: (id: AgentId) => host.probe(id),
                deliverOwed: async () => 0,
            },
            cwdFor: () => dir,
            startRefusal: () => null,
        } as unknown as AgentOpsPorts;
        const applier = new SettingApplier(p, () => 0);
        p.applyOnStart = (id) => applier.requested(id);
        return { p, calls, applier };
    }

    it('never started: nothing is started on its behalf — it applies at the next start', async () => {
        const r = record();
        const { p, calls } = ports(r);
        expect(await setModel(p, r.id, 'opus')).toMatchObject({ ok: true, apply: { when: 'next-start' } });
        await new Promise((done) => setTimeout(done, 0));
        expect(calls).toEqual([]);
        expect(host.probe(r.id)).toBeNull();
    });

    it('opened, never prompted: it does NOT wait for a turn that does not exist — applied now, once', async () => {
        const r = record();
        host.start(r, dir);
        const { p, calls, applier } = ports(r);
        expect(await setModel(p, r.id, 'opus')).toMatchObject({ ok: true, apply: { when: 'now' } });
        // COUNTED: one stop, one start (the restart waits for the old run to end before starting the new one).
        await vi.waitFor(() => expect(calls).toEqual(['stop', 'start']));
        expect(host.probe(r.id)?.running).toBe(true);
        expect(applier.pending(r.id)).toBe(false);
        // Back up with no turn: still not working.
        expect(agentRowFor(r, host.probe(r.id), now).state).toBe('idle');
    });
});

describe('a flow prompting an agent whose prompt waits for `ready`', () => {
    it('waits for THAT prompt’s turn to run and end, and answers with what it said — never with an empty reply at once', async () => {
        let state = { running: true, turnState: 'idle', pendingApproval: null as unknown };
        const rows: Array<{ event: unknown }> = [];
        const listeners = new Set<(id: string) => void>();
        const tell = () => { for (const l of listeners) l('agent_atlas'); };
        const sessions: AgentSessionsPort = {
            session: () => state,
            rows: () => rows,
            // Taken, but queued: the session is still starting, so it stays idle until ready.
            prompt: () => true,
            subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        };
        const prompt = agentPrompter({ sessions, resolve: () => ({ kind: 'one', id: 'agent_atlas' as never }), agent: () => ({ name: 'atlas', workspaceId: 'pa' }), asleep: () => false, by: 'flow "nightly"' });
        let answer: string | null = null;
        const replied = prompt('claude:atlas', 'check the queue').then((a) => { answer = a; return a; });
        await new Promise((done) => setTimeout(done, 0));
        expect(answer).toBeNull();

        // Ready: the queued prompt's turn opens, the agent answers, the turn ends.
        rows.push({ event: { kind: 'turn', n: 1, by: 'flow "nightly"' } });
        state = { ...state, turnState: 'working' };
        tell();
        rows.push({ event: { kind: 'message', speaker: 'agent', peerName: null, text: 'queue is empty' } });
        state = { ...state, turnState: 'idle' };
        tell();
        expect(await replied).toBe('queue is empty');
    });
});
