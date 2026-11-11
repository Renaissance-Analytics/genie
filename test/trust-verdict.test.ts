import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, COOLING_MS, type DriverEvents, type PermissionRequestLike, type SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { SessionHost, type DriverFor, type GenieInstructionFiles } from '../src/main/session-host.js';
import { NOW_TRUSTED, TRUSTED_AGAIN, UNTRUSTED_AT_NEXT_WORK, UNTRUSTED_AT_TURN_END, TrustVerdicts } from '../src/main/trust-verdict.js';
import { WorkspaceTrust } from '../src/main/workspace-trust-host.js';

/**
 * A WORKSPACE'S VERDICT CHANGES WHILE ITS AGENT RUNS. The shell-call answer is read at each call, the one part a running
 * session can change. Everything else was fixed at launch, so: gone trusted, one message into the session; gone untrusted,
 * a restart when the turn has ended, with a line in the chat. A person's work is never cut for it. Invented names.
 */

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const FILES: GenieInstructionFiles = { promptFile: '/genie/prompt.md', pluginDir: '/genie/plugin', promptText: 'genie words' };
const shellAsk: PermissionRequestLike = {
    toolCall: { title: 'git status', name: 'Bash', rawInput: { command: 'git status' } },
    options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
};

let dir: string;
let stopAll: () => Promise<void> = async () => {};
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trust-verdict-'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    await stopAll();
    stopAll = async () => {};
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/** Microtasks, the store's writes and short timers: what a launch and a check need to land. */
const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
        await vi.advanceTimersByTimeAsync(1);
        await new Promise((r) => setImmediate(r));
    }
};

/** A restart reads the thread from disk before it hands over what is owed: real time, which `flush` does not wait out. Bounded, and the row's own assertion says what did not come. */
const flushUntil = async (arrived: () => boolean): Promise<void> => {
    const end = performance.now() + 5000;
    while (!arrived() && performance.now() < end) await flush();
};

interface Fake { events: DriverEvents; prompts: string[] }

function rig(startUntrusted: boolean, options: { launchGate?: Promise<void>; restartAnswer?: { ok: false; reason: string } } = {}) {
    let untrusted = startUntrusted;
    const record: AgentRecord = agentRecord({ id: mintAgentId(), workspaceId: 'acme', provider: 'claude', name: 'atlas' });
    const launches: Array<GenieInstructionFiles | null> = [];
    const fakes: Fake[] = [];
    const driverFor: DriverFor = (_agent, _cwd, _resume, extras) => {
        launches.push(extras?.untrusted ?? null);
        const factory: SessionDriverFactory = (o) => {
            const fake: Fake = { events: o.events, prompts: [] };
            fakes.push(fake);
            return { start: () => {}, prompt: (content: unknown) => { fake.prompts.push(String(content)); }, kill: () => {}, cancel: () => {}, cliSessionId: null };
        };
        return factory;
    };
    const host = new SessionHost({
        userData: dir, driverFor, processTree: noProcessTree, stopGraceMs: 0,
        untrustedFilesFor: async () => { const answer = untrusted ? FILES : null; await options.launchGate; return answer; },
        untrustedNow: () => untrusted,
    });
    const notices: string[] = [];
    const held: string[] = [];
    const restarts: string[] = [];
    const verdicts = new TrustVerdicts({
        agentsOf: () => [record.id],
        untrustedNow: () => untrusted,
        launchedUntrusted: (id) => host.launchedUntrusted(id),
        quiet: (id) => host.quiet(id),
        inTurn: (id) => host.inTurn(id),
        workWaiting: (id) => host.workWaiting(id),
        releaseWork: (id) => host.releaseWork(id),
        runOf: (id) => host.runOf(id),
        hold: (id, text) => { const taken = host.holdForNextWork(id, text); if (taken) held.push(text); return taken; },
        withdraw: (id) => host.withdrawHeld(id),
        notice: (id, text) => { notices.push(text); host.notice(id, text); },
        restart: async (id) => {
            restarts.push(id);
            if (options.restartAnswer) return options.restartAnswer;
            host.stop(id);
            await host.ended(id);
            const started = host.start(record, dir);
            await host.deliverOwed(id);
            return started;
        },
    });
    const off = host.subscribe((id) => verdicts.check(id));
    stopAll = async () => { off(); host.stopAll(); await host.settled(); };
    return {
        host, record, launches, fakes, notices, held, restarts, verdicts,
        set: (value: boolean) => { untrusted = value; verdicts.changed('acme'); },
        last: () => fakes[fakes.length - 1]!,
        endTurn: () => fakes[fakes.length - 1]!.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }),
    };
}

describe('the answer to a shell call', () => {
    it('is the verdict at that call, in one session: allowed while trusted, asked once it is not', async () => {
        const t = rig(false);
        expect(t.host.start(t.record, dir)).toEqual({ ok: true });
        await flush();
        t.host.prompt(t.record.id, 'go', 'you');
        expect(await t.last().events.onRequestPermission!(shellAsk)).toEqual({ outcome: 'selected', optionId: 'allow_once' });

        // In a turn, so the restart below waits and this one session answers both.
        t.set(true);
        let answered = false;
        void t.last().events.onRequestPermission!(shellAsk).then(() => { answered = true; });
        await flush();
        expect(answered).toBe(false);
        expect(t.host.probe(t.record.id)?.running).toBe(true);
    });

    it('launched untrusted and trusted since: no longer asks', async () => {
        const t = rig(true);
        t.host.start(t.record, dir);
        await flush();
        t.set(false);
        await flush();
        expect(await t.last().events.onRequestPermission!(shellAsk)).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    });
});

describe('gone untrusted, in a turn: a restart when it has ended, and no work reaches the old session', () => {
    it('the chat says so once, the turn stands, and a message sent during it goes to the new run', async () => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.host.prompt(t.record.id, 'go', 'you');
        await flush();

        t.set(true);
        await flush();
        expect(t.restarts).toEqual([]);
        expect(t.notices).toEqual([UNTRUSTED_AT_TURN_END]);

        t.host.prompt(t.record.id, 'and this', 'you');
        await flush();
        expect(t.fakes[0]!.prompts).toEqual(['go']);

        t.endTurn();
        await flush();
        expect(t.restarts).toEqual([]);
        await vi.advanceTimersByTimeAsync(COOLING_MS - 100);
        await flush();
        expect(t.restarts).toEqual([]);
        await vi.advanceTimersByTimeAsync(100);
        await flush();
        expect(t.restarts).toEqual([t.record.id]);
        expect(t.launches).toEqual([null, FILES]);
        await flushUntil(() => t.fakes[1]!.prompts.length > 0);
        expect(t.fakes[0]!.prompts).toEqual(['go']);
        expect(t.fakes[1]!.prompts).toEqual(['and this']);
        expect(t.notices).toEqual([UNTRUSTED_AT_TURN_END]);
    });

    it('a turn the provider opens by itself in the quiet after one, for a prompt it already took: it waits for that one too', async () => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.host.prompt(t.record.id, 'go', 'you');
        t.host.prompt(t.record.id, 'taken mid-turn', 'you');
        t.set(true);
        await flush();
        t.endTurn();
        await flush();
        t.last().events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } });
        await vi.advanceTimersByTimeAsync(COOLING_MS * 2);
        await flush();
        expect(t.restarts).toEqual([]);
        t.endTurn();
        await vi.advanceTimersByTimeAsync(COOLING_MS);
        await flush();
        expect(t.restarts).toEqual([t.record.id]);
    });

    it('trusted again before the turn ended: no restart, the chat is told, and what waited goes to this session', async () => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.host.prompt(t.record.id, 'go', 'you');
        t.set(true);
        await flush();
        t.host.prompt(t.record.id, 'and this', 'you');
        await flush();
        t.set(false);
        await flush();
        t.endTurn();
        await vi.advanceTimersByTimeAsync(COOLING_MS * 2);
        await flush();
        expect(t.restarts).toEqual([]);
        expect(t.notices).toEqual([UNTRUSTED_AT_TURN_END, TRUSTED_AGAIN]);
        expect(t.fakes[0]!.prompts).toEqual(['go', 'and this']);
    });
});

describe('gone untrusted, idle: it stays as it is until work arrives, and that work goes to a new run', () => {
    it('no restart however long it waits, and nothing spent. The chat says so, once', async () => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.set(true);
        await flush();
        await vi.advanceTimersByTimeAsync(COOLING_MS * 4);
        await flush();
        expect(t.restarts).toEqual([]);
        expect(t.launches).toEqual([null]);
        expect(t.fakes[0]!.prompts).toEqual([]);
        expect(t.notices).toEqual([UNTRUSTED_AT_NEXT_WORK]);
    });

    it.each([
        ['prompt', (t: ReturnType<typeof rig>) => t.host.prompt(t.record.id, 'work', 'you')],
        ['deliver', (t: ReturnType<typeof rig>) => t.host.deliver(t.record.id, 'work', 'you')],
        ['handOff (the inbox)', (t: ReturnType<typeof rig>) => t.host.handOff(t.record.id, 'work', 'genie')],
        ['promptWith (the composer)', (t: ReturnType<typeof rig>) => t.host.promptWith(t.record.id, 'work', [], 'you')],
    ])('work by %s: not one word to the old session, one restart, and the new run has it', async (_name, send) => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.set(true);
        await flush();
        send(t);
        await flush();
        expect(t.restarts).toEqual([t.record.id]);
        await flushUntil(() => t.fakes[1]!.prompts.length > 0);
        expect(t.fakes[0]!.prompts).toEqual([]);
        expect(t.fakes[1]!.prompts).toEqual(['work']);
        expect(t.launches).toEqual([null, FILES]);
        t.verdicts.changed('acme');
        await flush();
        expect(t.restarts).toEqual([t.record.id]);
    });

    it('changed in the quiet just after a turn: that counts as idle', async () => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.host.prompt(t.record.id, 'go', 'you');
        t.endTurn();
        await flush();
        t.set(true);
        await vi.advanceTimersByTimeAsync(COOLING_MS * 2);
        await flush();
        expect(t.restarts).toEqual([]);
    });

    it('answered, trusted again: no restart, and later work goes to this session', async () => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.set(true);
        await flush();
        t.set(false);
        await flush();
        t.host.prompt(t.record.id, 'work', 'you');
        await flush();
        expect(t.restarts).toEqual([]);
        expect(t.fakes[0]!.prompts).toEqual(['work']);
        expect(t.notices).toEqual([UNTRUSTED_AT_NEXT_WORK, TRUSTED_AGAIN]);
    });

    it('a restart that is refused says why, and the work is not given to the old session', async () => {
        const t = rig(false, { restartAnswer: { ok: false, reason: 'its folder has gone' } });
        t.host.start(t.record, dir);
        await flush();
        t.set(true);
        await flush();
        t.host.prompt(t.record.id, 'work', 'you');
        await flush();
        expect(t.restarts).toEqual([t.record.id]);
        expect(t.notices.join('\n')).toContain('its folder has gone');
        expect(t.fakes[0]!.prompts).toEqual([]);
    });
});

describe('gone trusted: one message, ahead of the next real work', () => {
    const alongside = (work: string) => `${NOW_TRUSTED}\n\n${work}`;

    it('idle: nothing is sent, so no turn and no tokens. The next work carries it, once; the chat shows it was said', async () => {
        const t = rig(true);
        t.host.start(t.record, dir);
        await flush();
        t.set(false);
        await flush();
        expect(t.held).toEqual([NOW_TRUSTED]);
        expect(t.last().prompts).toEqual([]);
        expect(t.host.inTurn(t.record.id)).toBe(false);

        t.host.prompt(t.record.id, 'work', 'you');
        await flush();
        expect(t.last().prompts).toEqual([alongside('work')]);
        t.endTurn();
        await flush();
        t.host.prompt(t.record.id, 'more', 'you');
        await flush();
        expect(t.last().prompts).toEqual([alongside('work'), 'more']);
        expect(t.restarts).toEqual([]);
    });

    it('mid-turn: not folded into that turn, even with a message sent during it. The first work after it carries it', async () => {
        const t = rig(true);
        t.host.start(t.record, dir);
        await flush();
        t.host.prompt(t.record.id, 'go', 'you');
        t.set(false);
        await flush();
        t.host.prompt(t.record.id, 'also', 'you');
        await flush();
        expect(t.last().prompts).toEqual(['go', 'also']);
        t.endTurn();
        await flush();
        expect(t.last().prompts).toEqual(['go', 'also']);
        t.host.prompt(t.record.id, 'next', 'you');
        await flush();
        expect(t.last().prompts).toEqual(['go', 'also', alongside('next')]);
    });

    it('untrusted again before any work came: it is withdrawn, and a later trust holds it again, one', async () => {
        const t = rig(true);
        t.host.start(t.record, dir);
        await flush();
        t.set(false);
        await flush();
        t.set(true);
        await flush();
        t.host.prompt(t.record.id, 'work', 'you');
        await flush();
        expect(t.last().prompts).toEqual(['work']);
        t.endTurn();
        await flush();
        t.set(false);
        await flush();
        t.host.prompt(t.record.id, 'more', 'you');
        await flush();
        expect(t.last().prompts).toEqual(['work', alongside('more')]);
    });

    it('once said, not again in this run, however the verdict moves', async () => {
        const t = rig(true);
        t.host.start(t.record, dir);
        await flush();
        t.set(false);
        await flush();
        t.host.prompt(t.record.id, 'work', 'you');
        await flush();
        t.endTurn();
        await flush();
        t.set(true);
        await flush();
        t.set(false);
        await flush();
        t.host.prompt(t.record.id, 'more', 'you');
        await flush();
        expect(t.last().prompts).toEqual([alongside('work'), 'more']);
    });

    it('the verdict moved while the launch was being prepared: the launch reads old, and the next work still carries it', async () => {
        let open: () => void = () => {};
        const launchGate = new Promise<void>((r) => { open = r; });
        const t = rig(true, { launchGate });
        t.host.start(t.record, dir);
        await flush();
        t.set(false);
        await flush();
        expect(t.held).toEqual([]);
        open();
        await flush();
        expect(t.launches).toEqual([FILES]);
        t.host.prompt(t.record.id, 'work', 'you');
        await flush();
        expect(t.last().prompts).toEqual([alongside('work')]);
    });

    it('CONTROL: launched trusted, nothing is held and the work goes as written', async () => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.verdicts.changed('acme');
        await flush();
        t.host.prompt(t.record.id, 'work', 'you');
        await flush();
        expect(t.held).toEqual([]);
        expect(t.notices).toEqual([]);
        expect(t.last().prompts).toEqual(['work']);
    });
});

describe("Genie's words, once in a thread", () => {
    function launch(start: Partial<AgentRecord>, verdict: { untrusted: boolean } = { untrusted: true }) {
        let record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'acme', provider: 'claude', name: 'atlas' }), ...start };
        const fakes: Fake[] = [];
        const driverFor: DriverFor = () => (o) => {
            const fake: Fake = { events: o.events, prompts: [] };
            fakes.push(fake);
            return { start: () => {}, prompt: (content: unknown) => { fake.prompts.push(String(content)); }, kill: () => {}, cancel: () => {}, cliSessionId: null };
        };
        const marks: string[] = [];
        const host = new SessionHost({
            userData: dir, driverFor, processTree: noProcessTree, stopGraceMs: 0,
            untrustedFilesFor: async () => (verdict.untrusted ? FILES : null),
            untrustedNow: () => verdict.untrusted,
            currentRecord: () => record,
            markGenieWords: (id) => { marks.push(id); record = { ...record, genieWordsInThread: true }; },
        });
        stopAll = async () => { host.stopAll(); await host.settled(); };
        return { host, record: () => record, fakes, marks };
    }
    const work = async (t: ReturnType<typeof launch>, text: string) => { t.host.prompt(t.record().id, text, 'you'); await flush(); };

    it('a thread that began trusted, resumed into untrusted: the file does not reach it, so they go ahead of the next work, once', async () => {
        const t = launch({ threadId: 'thread-1' });
        t.host.start(t.record(), dir);
        await flush();
        expect(t.fakes[0]!.prompts).toEqual([]);
        expect(t.marks).toEqual([]);
        await work(t, 'work');
        expect(t.fakes[0]!.prompts).toEqual([`genie words\n\nwork`]);
        expect(t.marks).toEqual([t.record().id]);
        t.fakes[0]!.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        await flush();
        await work(t, 'more');
        expect(t.fakes[0]!.prompts[1]).toBe('more');
    });

    // Tynn #615 (the owner, beta.61): the whole "Genie 2 — This file is written by Genie 2…" text showed in his chat as a
    // message "genie → <agent>", after the upgrade's restart and again after a session restarted.
    it('the instructions are never drawn in the chat as a message: one short line says they were sent, and the agent gets all of them', async () => {
        const t = launch({ threadId: 'thread-1' });
        t.host.start(t.record(), dir);
        await flush();
        await work(t, 'work');
        const rows = t.host.rowsFor(t.record().id).map((r) => r.event);
        const messages = rows.filter((e) => e.kind === 'message').map((e) => (e as { text: string }).text);
        expect(messages).toEqual(['work']);
        expect(JSON.stringify(rows)).not.toContain('genie words');
        expect(rows.filter((e) => e.kind === 'notice').map((e) => (e as { message: string }).message)).toContain('Genie sent this agent its instructions.');
        // The agent still receives every word.
        expect(t.fakes[0]!.prompts).toEqual([`genie words\n\nwork`]);
    });

    it('a short word of Genie\'s own ahead of the work is still shown as Genie\'s message (CONTROL)', async () => {
        const t = launch({ threadId: 'thread-1' }, { untrusted: false });
        t.host.start(t.record(), dir);
        await flush();
        expect(t.host.holdForNextWork(t.record().id, NOW_TRUSTED)).toBe(true);
        await work(t, 'work');
        const messages = t.host.rowsFor(t.record().id).map((r) => r.event).filter((e) => e.kind === 'message').map((e) => (e as { text: string }).text);
        expect(messages).toEqual([NOW_TRUSTED, 'work']);
    });

    it('Codex has no file route: its first work carries them, even on a new thread, once', async () => {
        const t = launch({ threadId: null, provider: 'codex' } as Partial<AgentRecord>);
        t.host.start(t.record(), dir);
        await flush();
        expect(t.marks).toEqual([]);
        await work(t, 'work');
        expect(t.fakes[0]!.prompts).toEqual(['genie words\n\nwork']);
        expect(t.marks).toEqual([t.record().id]);
    });

    it('that thread on its next launch: not twice', async () => {
        const t = launch({ threadId: 'thread-1', genieWordsInThread: true });
        t.host.start(t.record(), dir);
        await flush();
        await work(t, 'work');
        expect(t.fakes[0]!.prompts).toEqual(['work']);
    });

    it('a thread that began untrusted has them by file: none by message, and it is marked', async () => {
        const t = launch({ threadId: null });
        t.host.start(t.record(), dir);
        await flush();
        expect(t.marks).toEqual([t.record().id]);
        await work(t, 'work');
        expect(t.fakes[0]!.prompts).toEqual(['work']);
    });

    it('held and the run ended before any work: not marked, so the next launch holds them again', async () => {
        const t = launch({ threadId: 'thread-1' });
        t.host.start(t.record(), dir);
        await flush();
        t.host.stop(t.record().id, { graceful: false });
        await t.host.ended(t.record().id);
        expect(t.marks).toEqual([]);
    });

    it('CONTROL: trusted, none, and nothing is marked', async () => {
        const t = launch({ threadId: 'thread-1' }, { untrusted: false });
        t.host.start(t.record(), dir);
        await flush();
        await work(t, 'work');
        expect(t.fakes[0]!.prompts).toEqual(['work']);
        expect(t.marks).toEqual([]);
    });
});

describe('an agent with no session', () => {
    it('nothing is sent and nothing restarted: its next launch reads the verdict', async () => {
        const t = rig(false);
        t.set(true);
        await flush();
        expect(t.restarts).toEqual([]);
        expect(t.notices).toEqual([]);
        expect(t.held).toEqual([]);
    });
});

describe('quiet: a restart would cut nothing', () => {
    function session() {
        const sessionDir = join(dir, 'session');
        let events: DriverEvents = {};
        const factory: SessionDriverFactory = (o) => {
            events = o.events;
            return { start: () => {}, prompt: () => {}, kill: () => {}, cancel: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
        };
        const s = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(sessionDir), driverFactory: factory, processTree: noProcessTree, permissionDecision: () => 'ask' });
        s.start();
        stopAll = async () => { s.stop('SIGTERM', { graceMs: 0 }); await s.settled(); };
        return { s, events: () => events };
    }

    it('idle: yes. In a turn, or in the quiet after one: no. Past the quiet: yes', async () => {
        const { s, events } = session();
        expect(s.quiet).toBe(true);
        s.deliver('go', 'you');
        expect(s.quiet).toBe(false);
        events().onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        expect(s.promptable).toBe(true);
        expect(s.quiet).toBe(false);
        vi.advanceTimersByTime(COOLING_MS);
        expect(s.quiet).toBe(true);
    });

    it('a message waiting: no, though the session could take a turn', () => {
        const { s } = session();
        s.hold();
        s.deliver('held for the limit', 'you');
        expect(s.quiet).toBe(false);
    });

    it('a person being asked: no', async () => {
        const { s, events } = session();
        void events().onRequestPermission!(shellAsk);
        await flush();
        expect(s.promptable).toBe(false);
        expect(s.quiet).toBe(false);
    });
});

describe('the verdict is announced when it moves', () => {
    const W = join('/ws', 'acme');
    const SETTINGS = join(W, '.claude', 'settings.json');
    function trust() {
        const files = new Map([[SETTINGS, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'one' }] }] } })]]);
        const record = { carried: [] as string[], workspaces: {} as Record<string, string> };
        const moved: string[] = [];
        const host = new WorkspaceTrust({
            readText: async (p) => files.get(p) ?? null,
            gitConfig: async () => [],
            isTracked: async () => true,
            workspaces: () => [{ id: 'acme', path: W }],
            record: () => record,
            recordWorkspace: async (id, hash) => { record.workspaces[id] = hash; },
            forgetWorkspace: async (id) => { delete record.workspaces[id]; },
            approveSites: async () => {},
            verdictMoved: (id) => moved.push(id),
        });
        return { host, files, moved };
    }

    it('first read, trust and the person\'s Untrust: each. A read that says the same, or a change to the files: none (Tynn #618)', async () => {
        const t = trust();
        await t.host.refresh('acme');
        expect(t.moved).toEqual(['acme']);
        await t.host.refresh('acme');
        expect(t.moved).toEqual(['acme']);
        await t.host.trust('acme');
        expect(t.moved).toEqual(['acme', 'acme']);
        await t.host.refresh('acme');
        expect(t.moved).toEqual(['acme', 'acme']);
        t.files.set(SETTINGS, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'two' }] }] } }));
        await t.host.refresh('acme');
        expect(t.moved).toEqual(['acme', 'acme']);
        await t.host.untrust('acme');
        expect(t.moved).toEqual(['acme', 'acme', 'acme']);
    });
});

describe('the app is wired to it (reads the source: no window is opened here)', () => {
    const source = (name: string) => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8');

    it('genie-host hands its session host the live read, and turns every change of the host or the verdict into a check', () => {
        const host = source('genie-host.ts');
        expect(host).toMatch(/untrustedNow:/);
        expect(host).toMatch(/new TrustVerdicts\(/);
        expect(host).toMatch(/\.subscribe\(\(id\) => hostVerdicts/);
        expect(host).toMatch(/onTrustVerdict:/);
        expect(source('main.ts')).not.toMatch(/new TrustVerdicts\(/);
    });

    it('compose gives the same verdict to the sync read, and announces through what main passed', () => {
        const compose = source('compose.ts');
        expect(compose).toMatch(/untrustedNow\(record/);
        // The verdicts are the host's now (genie#1519 in the host split): compose hears them from the hosting replica and
        // announces through what main passed; the host's own stack announces through ownTrust's verdictMoved.
        expect(compose).toMatch(/hosting\.trust\.onVerdict\(\(id\) => input\.onTrustVerdict\?\.\(id\)\)/);
        expect(source('hosting-compose.ts')).toMatch(/verdictMoved: input\.onTrustVerdict,/);
        expect(source('genie-host.ts')).toMatch(/onTrustVerdict: \(workspaceId\) => hostVerdicts\?\.changed\(workspaceId\)/);
    });
});
