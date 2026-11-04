import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, COOLING_MS, type DriverEvents, type PermissionRequestLike, type SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { SessionHost, type DriverFor, type GenieInstructionFiles } from '../src/main/session-host.js';
import { NOW_TRUSTED, TRUSTED_AGAIN, UNTRUSTED_AT_TURN_END, UNTRUSTED_NOW, TrustVerdicts } from '../src/main/trust-verdict.js';
import { WorkspaceTrust } from '../src/main/workspace-trust-host.js';

/**
 * A WORKSPACE'S VERDICT CHANGES WHILE ITS AGENT RUNS. The shell-call answer is read at each call, the one part a running
 * session can change. Everything else was fixed at launch, so: gone trusted, one message into the session; gone untrusted,
 * a restart when the turn has ended, with a line in the chat. A person's work is never cut for it. Invented names.
 */

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const FILES: GenieInstructionFiles = { promptFile: '/genie/prompt.md', pluginDir: '/genie/plugin' };
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
    const told: Array<[string, string | null]> = [];
    const restarts: string[] = [];
    const verdicts = new TrustVerdicts({
        agentsOf: () => [record.id],
        untrustedNow: () => untrusted,
        launchedUntrusted: (id) => host.launchedUntrusted(id),
        quiet: (id) => host.quiet(id),
        runOf: (id) => host.runOf(id),
        tell: (id, text) => { const taken = host.handOff(id, text, 'genie') !== null; if (taken) told.push([text, 'genie']); return taken; },
        notice: (id, text) => { notices.push(text); host.notice(id, text); },
        restart: async (id) => {
            restarts.push(id);
            if (options.restartAnswer) return options.restartAnswer;
            host.stop(id);
            await host.ended(id);
            return host.start(record, dir);
        },
    });
    const off = host.subscribe((id) => verdicts.check(id));
    stopAll = async () => { off(); host.stopAll(); await host.settled(); };
    return {
        host, record, launches, fakes, notices, told, restarts, verdicts,
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
        expect(await t.last().events.onRequestPermission!(shellAsk)).toEqual({ outcome: 'selected', optionId: 'allow_once' });

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

describe('gone untrusted: a restart, when the turn has ended', () => {
    it('mid-turn: the chat says so once, the turn and the message sent during it stand, and the restart comes after the quiet', async () => {
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
        expect(t.restarts).toEqual([]);
        expect(t.fakes[0]!.prompts.join('\n')).toContain('and this');

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
        expect(t.notices).toEqual([UNTRUSTED_AT_TURN_END]);
    });

    it('a new turn in the quiet after a turn: it waits for that one too', async () => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.host.prompt(t.record.id, 'go', 'you');
        t.set(true);
        await flush();
        t.endTurn();
        await flush();
        t.host.prompt(t.record.id, 'next', 'you');
        await vi.advanceTimersByTimeAsync(COOLING_MS * 2);
        await flush();
        expect(t.restarts).toEqual([]);
        t.endTurn();
        await vi.advanceTimersByTimeAsync(COOLING_MS);
        await flush();
        expect(t.restarts).toEqual([t.record.id]);
    });

    it('already idle: restarts now, says so, and the new run is level with the verdict, so there is no second', async () => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.set(true);
        await flush();
        expect(t.restarts).toEqual([t.record.id]);
        expect(t.notices).toEqual([UNTRUSTED_NOW]);
        t.verdicts.changed('acme');
        await flush();
        expect(t.restarts).toEqual([t.record.id]);
        expect(t.launches).toEqual([null, FILES]);
    });

    it('trusted again before the turn ended: no restart, and the chat is told', async () => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.host.prompt(t.record.id, 'go', 'you');
        t.set(true);
        await flush();
        t.set(false);
        await flush();
        t.endTurn();
        await vi.advanceTimersByTimeAsync(COOLING_MS * 2);
        await flush();
        expect(t.restarts).toEqual([]);
        expect(t.notices).toEqual([UNTRUSTED_AT_TURN_END, TRUSTED_AGAIN]);
    });

    it('a restart that is refused says why', async () => {
        const t = rig(false, { restartAnswer: { ok: false, reason: 'its folder has gone' } });
        t.host.start(t.record, dir);
        await flush();
        t.set(true);
        await flush();
        expect(t.restarts).toEqual([t.record.id]);
        expect(t.notices.join('\n')).toContain('its folder has gone');
    });
});

describe('gone trusted: one message into the session', () => {
    it('one, from Genie, however often the verdict moves in this run; no restart', async () => {
        const t = rig(true);
        t.host.start(t.record, dir);
        await flush();
        expect(t.told).toEqual([]);
        t.set(false);
        await flush();
        expect(t.told).toEqual([[NOW_TRUSTED, 'genie']]);
        expect(t.last().prompts).toContain(NOW_TRUSTED);
        t.set(true);
        await flush();
        t.set(false);
        await flush();
        expect(t.told).toHaveLength(1);
        expect(t.restarts).toEqual([]);
    });

    it('the verdict moved while the launch was being prepared: the launch reads old, the message still comes', async () => {
        let open: () => void = () => {};
        const launchGate = new Promise<void>((r) => { open = r; });
        const t = rig(true, { launchGate });
        t.host.start(t.record, dir);
        await flush();
        t.set(false);
        await flush();
        expect(t.told).toEqual([]);
        open();
        await flush();
        expect(t.launches).toEqual([FILES]);
        expect(t.told).toEqual([[NOW_TRUSTED, 'genie']]);
    });

    it('CONTROL: launched trusted, nothing to say', async () => {
        const t = rig(false);
        t.host.start(t.record, dir);
        await flush();
        t.verdicts.changed('acme');
        await flush();
        expect(t.told).toEqual([]);
        expect(t.notices).toEqual([]);
    });
});

describe('an agent with no session', () => {
    it('nothing is sent and nothing restarted: its next launch reads the verdict', async () => {
        const t = rig(false);
        t.set(true);
        await flush();
        expect(t.restarts).toEqual([]);
        expect(t.notices).toEqual([]);
        expect(t.told).toEqual([]);
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
            approveSites: async () => {},
            verdictMoved: (id) => moved.push(id),
        });
        return { host, files, moved };
    }

    it('first read, trust and a change that asks again: each. A read that says the same: none', async () => {
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
        expect(t.moved).toEqual(['acme', 'acme', 'acme']);
    });
});

describe('the app is wired to it (reads the source: no window is opened here)', () => {
    const source = (name: string) => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8');

    it('main hands the session host the live read, and turns every change of the host or the verdict into a check', () => {
        const main = source('main.ts');
        expect(main).toMatch(/untrustedNow:/);
        expect(main).toMatch(/new TrustVerdicts\(/);
        expect(main).toMatch(/\.subscribe\(\(id\) => trustVerdicts/);
        expect(main).toMatch(/onTrustVerdict:/);
    });

    it('compose gives the same verdict to the sync read, and announces through what main passed', () => {
        const compose = source('compose.ts');
        expect(compose).toMatch(/untrustedNow\(record/);
        expect(compose).toMatch(/verdictMoved:/);
    });
});
