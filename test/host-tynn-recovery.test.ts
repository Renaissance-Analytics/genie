import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { AgentStoresService } from '../src/main/agent-stores-host.js';
import { openAgentStores } from '../src/main/agent-stores-open.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { hostAgentKeys } from '../src/main/host-agent-keys.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { hostTynnRecovery, RECOVERY_STEPS_MS, wallClockJumps } from '../src/main/host-tynn-recovery.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { Store } from '../src/main/store.js';
import type { TynnSessionPort } from '../src/main/tynn-agent-token.js';
import { fakeKeychain } from './helpers/tynn-storage.js';
import { until } from './helpers/until.js';

/**
 * TYNN COMES BACK, AND NOBODY HAS TO OPEN A WINDOW (P3.4 cut c; the owner's "this should not happen at all"). The host owns the account and
 * prepares its agents, so it also brings an agent's Tynn tools back: when the account signs in or Tynn answers again, it restarts the agent
 * on its conversation, at its next idle, never through a running turn.
 *
 * AND A WORKSPACE A WINDOW HAS JUST ADDED IS NEVER REFUSED: the socket is in order but the server's calls run concurrently, so a start can
 * overtake the write that names its workspace. The start waits for the write.
 */

const PROJECT = 'project-42';
let dir: string;
let workspace: string;
let vaultFile: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'host-recovery-'));
    workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    mkdirSync(join(dir, 'agent-credentials'));
    vaultFile = join(dir, 'agent-credentials', 'agents.json');
    writeFileSync(join(workspace, 'project.json'), JSON.stringify({ tynn: { projectId: PROJECT } }));
});
const closers: Array<() => void> = [];
afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (over: Partial<Parameters<typeof agentRecord>[0]> = {}): AgentRecord =>
    agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'atlas', ...over });

function tynnFake() {
    const remote: Array<{ id: string; name: string; external_id: string | null; status: string; tokens: Array<{ public_id: string; active: boolean }> }> = [];
    const state = { signedIn: true, reachable: true, minted: 0, conflict: false };
    const answer = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
    const port: TynnSessionPort = {
        status: () => ({ signedIn: state.signedIn }),
        userId: () => (state.signedIn ? 'user-7' : null),
        savedUserId: () => 'user-7',
        request: async (path, init) => {
            if (!state.reachable) throw new Error('Tynn could not be reached.');
            if (path === `/api/v1/projects/${PROJECT}/agents` && init.method === 'GET') return answer(200, { project_id: PROJECT, agents: state.conflict ? [{ id: 'taken', name: 'atlas', external_id: 'someone-else', status: 'active', tokens: [] }] : remote });
            if (path === `/api/v1/projects/${PROJECT}/agents` && init.method === 'POST') {
                const body = init.body as { name: string; external_id: string };
                const row = { id: `remote-${remote.length + 1}`, name: body.name, external_id: body.external_id, status: 'active', tokens: [] };
                remote.push(row);
                return answer(201, { agent: row });
            }
            if (path === '/api/v1/projects/agent-token') {
                state.minted += 1;
                const row = remote.find((r) => r.name === (init.body as { agent_name: string }).agent_name)!;
                const publicId = String(state.minted).padStart(26, '0');
                row.tokens.push({ public_id: publicId, active: true });
                return answer(200, { token: `rpk_${publicId}.${'ab'.repeat(32)}`, agent: { id: row.id, name: row.name }, mcp_url: 'https://tynn.ai/mcp/tynn' });
            }
            return answer(404, {});
        },
    };
    return { port, state };
}
const bearer = (servers: readonly McpServer[]) => {
    const tynn = servers.find((s) => s.name === 'tynn') as { headers?: readonly { name: string; value: string }[] } | undefined;
    return tynn?.headers?.find((h) => h.name === 'Authorization')?.value ?? null;
};

describe('THE BUG: an agent started during an outage, with no window, gets its tools back once Tynn answers, and no window connects', () => {
    function world(t: ReturnType<typeof tynnFake>) {
        const starts: Array<{ id: string; thread: string | null; servers: readonly McpServer[] }> = [];
        const driverFor: DriverFor = (r, _cwd, thread, options) => {
            starts.push({ id: r.id, thread: thread ?? null, servers: (options as { mcpServers?: readonly McpServer[] }).mcpServers ?? [] });
            const factory: SessionDriverFactory = () => ({ start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } });
            return factory;
        };
        const keys = hostAgentKeys({ vaultFile, keychain: fakeKeychain(), tynn: () => t.port, workspaces: () => [{ id: 'ws', path: workspace }] });
        const server = new SessionEngineServer({
            token: 'a'.repeat(64), build: 'test', agentKeys: keys,
            mcp: { setView: () => {}, sessionServers: () => [{ type: 'http', name: 'genie', url: 'http://127.0.0.1:1/mcp', headers: [] }], status: () => null, runNative: async () => null } as never,
        });
        const host = new SessionHost({ userData: dir, driverFor, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        return { starts, keys, server, host };
    }

    it('restarted by the host, on its conversation, with its key', async () => {
        const t = tynnFake();
        t.state.reachable = false;
        const { starts, keys, server, host } = world(t);
        const agent: AgentRecord = { ...record(), threadId: 'thread-of-this-conversation' };
        const recovery = hostTynnRecovery({
            names: (asked) => keys.recovery(asked), waiting: () => keys.waiting(), recheck: async () => {},
            host: host as never, record: () => agent, threadOf: () => null, cwdFor: () => workspace,
        });
        expect(server.windowConnected()).toBe(false);
        expect(await host.start(agent, workspace)).toEqual({ ok: true });
        await until(() => starts.length === 1);
        expect(bearer(starts[0]!.servers)).toBeNull();

        t.state.reachable = true;
        await recovery.recover();
        await until(() => starts.length === 2);
        expect(starts).toHaveLength(2);
        expect(bearer(starts[1]!.servers)).toContain('rpk_');
        expect(starts[1]!.thread).toBe('thread-of-this-conversation');
        expect(server.windowConnected()).toBe(false);
        expect(JSON.stringify(host.rowsFor(agent.id as AgentId))).toContain('Tynn is available again');
        await host.stopAll();
    });

    it('/ME ANSWERS AND THE AGENT ENDPOINT FAILS: three steps, no restart, the running agent untouched; then it recovers', async () => {
        const t = tynnFake();
        t.state.reachable = false;
        const { starts, keys, host } = world(t);
        const agent = record();
        const due: Array<() => void> = [];
        const recovery = hostTynnRecovery({
            names: (asked) => keys.recovery(asked), waiting: () => keys.waiting(), recheck: async () => {},
            host: host as never, record: () => agent, threadOf: () => null, cwdFor: () => workspace,
            schedule: (_ms, fn) => { due.push(fn); return () => {}; },
        });
        await host.start(agent, workspace);
        await until(() => starts.length === 1);
        await until(() => keys.waiting());
        recovery.kick();
        // The account reads signed in the whole time, so a sign-in alone is no reason to touch this agent.
        expect(t.port.status().signedIn).toBe(true);
        for (let step = 0; step < 3; step += 1) {
            expect(due).toHaveLength(1);
            due.shift()!();
            // The next step is scheduled when this one's check ends, after real file work: wait for that, not 20 ms (batch CC, under the suite).
            await until(() => due.length === 1);
        }
        expect(starts, 'three steps, and the running agent was left alone').toHaveLength(1);
        expect(host.probe(agent.id as AgentId)?.running).toBe(true);
        expect(t.state.minted).toBe(0);
        // Tynn's agent endpoint answers again: the key is in hand BEFORE the agent is touched.
        t.state.reachable = true;
        due.shift()!();
        await until(() => starts.length === 2);
        expect(starts).toHaveLength(2);
        expect(t.state.minted).toBe(1);
        expect(bearer(starts[1]!.servers)).toContain('rpk_');
        await host.stopAll();
    });

    it('a key Tynn refuses to give stops the asking: it is not an outage, and the agent is left as it is', async () => {
        const t = tynnFake();
        t.state.reachable = false;
        const { starts, keys, host } = world(t);
        const agent = record();
        await host.start(agent, workspace);
        await until(() => starts.length === 1);
        await until(() => keys.waiting());
        t.state.reachable = true;
        t.state.conflict = true;
        expect(await keys.recovery()).toEqual([]);
        expect(keys.waiting()).toBe(false);
        expect(starts).toHaveLength(1);
        await host.stopAll();
    });

    it('CONTROL: with Tynn still out, nobody is restarted', async () => {
        const t = tynnFake();
        t.state.reachable = false;
        t.state.signedIn = false;
        const { starts, keys, host } = world(t);
        const agent = record();
        const recovery = hostTynnRecovery({ names: (asked) => keys.recovery(asked), waiting: () => keys.waiting(), recheck: async () => {}, host: host as never, record: () => agent, threadOf: () => null, cwdFor: () => workspace });
        await host.start(agent, workspace);
        await until(() => starts.length === 1);
        await recovery.recover();
        await new Promise((r) => setTimeout(r, 30));
        expect(starts).toHaveLength(1);
        await host.stopAll();
    });
});

/** The session host as this module sees it, with a turn you can hold open. */
function fakeHost() {
    const calls: string[] = [];
    const listeners = new Set<(id: AgentId) => void>();
    const state = { inTurn: false, running: true, startOk: true, survivors: false };
    const host = {
        probe: () => (state.running ? { running: true, inTurn: state.inTurn } : null),
        subscribe: (l: (id: AgentId) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        notice: (_id: AgentId, text: string) => { calls.push(`notice: ${text}`); return true; },
        stop: () => { calls.push('stop'); return true; },
        ended: async () => (state.survivors ? { verified: false, survivors: [1], reason: 'one left' } : { verified: true, survivors: [], reason: '' }),
        start: async (r: AgentRecord) => { calls.push(`start:${r.threadId ?? 'no-thread'}`); return state.startOk ? { ok: true } : { ok: false, reason: 'refused by name' }; },
        deliverOwed: async () => { calls.push('deliverOwed'); return 0; },
    };
    return { host, calls, state, fire: (id: string) => { for (const l of [...listeners]) l(id as AgentId); } };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('never through a running turn', () => {
    it('mid-turn it waits, then restarts at the next idle, once', async () => {
        const f = fakeHost();
        const agent = record();
        f.state.inTurn = true;
        const lines: string[] = [];
        const recovery = hostTynnRecovery({ names: async () => [agent.id], waiting: () => false, recheck: async () => {}, host: f.host as never, record: () => agent, threadOf: () => null, cwdFor: () => workspace, log: (l) => lines.push(l) });
        await recovery.recover();
        await settle();
        expect(f.calls).toEqual([]);
        f.fire(agent.id);
        await settle();
        expect(f.calls, 'a change while still in its turn does nothing').toEqual([]);
        // The wait is said, once: an agent parked on a question can wait a long time, and that must be readable in the log.
        expect(lines.filter((l) => l.includes('waits for its turn to end'))).toHaveLength(1);
        f.state.inTurn = false;
        f.fire(agent.id);
        f.fire(agent.id);
        await settle();
        expect(f.calls.filter((c) => c === 'stop')).toHaveLength(1);
        expect(f.calls.some((c) => c.startsWith('start:'))).toBe(true);
        expect(f.calls).toContain('deliverOwed');
    });

    it('stop, then the end, then start, and only then the notice, in the new run', async () => {
        const f = fakeHost();
        const agent = record();
        const recovery = hostTynnRecovery({ names: async () => [agent.id], waiting: () => false, recheck: async () => {}, host: f.host as never, record: () => agent, threadOf: () => null, cwdFor: () => workspace });
        await recovery.recover();
        await settle();
        expect(f.calls[0]).toBe('stop');
        expect(f.calls[1]).toMatch(/^start:/);
        expect(f.calls[2]).toMatch(/^notice: Tynn is available again/);
    });

    it('A STOPPED AGENT IS NOT STARTED: its next start prepares it anyway', async () => {
        const f = fakeHost();
        f.state.running = false;
        const agent = record();
        const recovery = hostTynnRecovery({ names: async () => [agent.id], waiting: () => false, recheck: async () => {}, host: f.host as never, record: () => agent, threadOf: () => null, cwdFor: () => workspace });
        await recovery.recover();
        await settle();
        expect(f.calls).toEqual([]);
    });

    it('an agent that stopped while it waited is not started either', async () => {
        const f = fakeHost();
        const agent = record();
        f.state.inTurn = true;
        const recovery = hostTynnRecovery({ names: async () => [agent.id], waiting: () => false, recheck: async () => {}, host: f.host as never, record: () => agent, threadOf: () => null, cwdFor: () => workspace });
        await recovery.recover();
        f.state.running = false;
        f.fire(agent.id);
        await settle();
        expect(f.calls).toEqual([]);
    });
});

describe('its conversation is kept', () => {
    it('A THREAD THE HOST HEARD WITH NO WINDOW IS THE ONE IT RESUMES: the registry cannot know it yet', async () => {
        const f = fakeHost();
        const agent = record();
        const recovery = hostTynnRecovery({ names: async () => [agent.id], waiting: () => false, recheck: async () => {}, host: f.host as never, record: () => agent, threadOf: () => 'heard-with-no-window', cwdFor: () => workspace });
        await recovery.recover();
        await settle();
        expect(f.calls).toContain('start:heard-with-no-window');
    });

    it('a restart that could not end the old run, or could not start, is said and starts nothing else', async () => {
        const f = fakeHost();
        f.state.survivors = true;
        const agent = record();
        const lines: string[] = [];
        const recovery = hostTynnRecovery({ names: async () => [agent.id], waiting: () => false, recheck: async () => {}, host: f.host as never, record: () => agent, threadOf: () => null, cwdFor: () => workspace, log: (l) => lines.push(l) });
        await recovery.recover();
        await settle();
        expect(f.calls.some((c) => c.startsWith('start:'))).toBe(false);
        expect(lines.join()).toContain('one left');
    });
});

describe('one at a time, and it keeps asking only while someone waits', () => {
    function timers() {
        const due: Array<{ ms: number; fn: () => void }> = [];
        return { due, schedule: (ms: number, fn: () => void) => { const t = { ms, fn }; due.push(t); return () => { due.splice(due.indexOf(t), 1); }; } };
    }

    it('two quick changes restart an agent once', async () => {
        const f = fakeHost();
        const agent = record();
        let named = [agent.id as string];
        const recovery = hostTynnRecovery({ names: async () => { const n = named; named = []; return n; }, waiting: () => false, recheck: async () => {}, host: f.host as never, record: () => agent, threadOf: () => null, cwdFor: () => workspace });
        await Promise.all([recovery.recover(), recovery.recover()]);
        await settle();
        expect(f.calls.filter((c) => c === 'stop')).toHaveLength(1);
    });

    it('with an agent waiting on Tynn it asks again on a backoff, and restarts when Tynn answers, with no event from anyone', async () => {
        const f = fakeHost();
        const agent = record();
        const t = timers();
        let waiting = true;
        let answers = false;
        let rechecks = 0;
        const recovery = hostTynnRecovery({
            names: async () => (answers ? [agent.id] : []), waiting: () => waiting, recheck: async () => { rechecks += 1; },
            host: f.host as never, record: () => agent, threadOf: () => null, cwdFor: () => workspace, schedule: t.schedule,
        });
        recovery.kick();
        expect(t.due.map((d) => d.ms)).toEqual([RECOVERY_STEPS_MS[0]]);
        t.due.shift()!.fn();
        await settle();
        expect(rechecks).toBe(1);
        expect(t.due.map((d) => d.ms)).toEqual([RECOVERY_STEPS_MS[1]]);
        answers = true;
        t.due.shift()!.fn();
        await settle();
        expect(f.calls).toContain('stop');
        waiting = false;
        t.due.shift()!.fn();
        await settle();
        expect(t.due, 'nobody is waiting: nothing is scheduled').toEqual([]);
    });

    it('the backoff stops growing at its last step and does not stop while someone waits', async () => {
        const f = fakeHost();
        const t = timers();
        const recovery = hostTynnRecovery({ names: async () => [], waiting: () => true, recheck: async () => {}, host: f.host as never, record: () => null, threadOf: () => null, cwdFor: () => workspace, schedule: t.schedule });
        recovery.kick();
        for (let i = 0; i < RECOVERY_STEPS_MS.length + 3; i += 1) { t.due.shift()!.fn(); await settle(); }
        expect(t.due.map((d) => d.ms)).toEqual([RECOVERY_STEPS_MS.at(-1)]);
    });

    it('it asks after 30 s, after 2 min, then every 5 min: a restart needs the key held, so asking often touches nobody', () => {
        expect(RECOVERY_STEPS_MS).toEqual([30_000, 120_000, 300_000]);
    });

    describe('asking at once, when something has changed', () => {
        function rig(options: { waiting?: () => boolean; names?: () => Promise<string[]>; recheck?: () => Promise<void>; inTurn?: boolean; watchWake?: (onWake: () => void) => () => void } = {}) {
            const f = fakeHost();
            const agent = record();
            const t = timers();
            let rechecks = 0;
            if (options.inTurn) f.state.inTurn = true;
            const recovery = hostTynnRecovery({
                names: options.names ?? (async () => []), waiting: options.waiting ?? (() => true),
                recheck: async () => { rechecks += 1; await options.recheck?.(); },
                host: f.host as never, record: () => agent, threadOf: () => null, cwdFor: () => workspace, schedule: t.schedule,
                ...(options.watchWake ? { watchWake: options.watchWake } : {}),
            });
            return { f, t, agent, recovery, rechecks: () => rechecks };
        }

        it('a nudge while someone waits asks now, and the timer it replaced does not also fire', async () => {
            const r = rig();
            r.recovery.kick();
            expect(r.t.due).toHaveLength(1);
            r.recovery.nudge();
            await settle();
            expect(r.rechecks()).toBe(1);
            expect(r.t.due, 'one timer, the next step').toHaveLength(1);
        });

        it('a nudge restarts an agent whose key is now held', async () => {
            const agentId = record().id as string;
            const r = rig({ names: async () => [agentId] });
            r.recovery.nudge();
            await settle();
            expect(r.f.calls).toContain('stop');
        });

        it('with nobody named, a nudge touches nobody', async () => {
            const r = rig();
            r.recovery.kick();
            r.recovery.nudge();
            await settle();
            expect(r.f.calls).toEqual([]);
        });

        it('wired: a window linking asks at once, and the host watches for its machine waking', () => {
            const host = readFileSync('src/main/genie-host.ts', 'utf8');
            expect(host).toMatch(/if \(n > windowsLinked\) tynnRecovery\?\.nudge\(\);/);
            expect(host).toMatch(/watchWake: wallClockJumps/);
        });

        it('a nudge with nobody waiting does nothing: no question to Tynn, and nothing scheduled', async () => {
            const r = rig({ waiting: () => false });
            r.recovery.nudge();
            await settle();
            expect(r.rechecks()).toBe(0);
            expect(r.t.due).toEqual([]);
        });

        it('a nudge during a check does not start a second one', async () => {
            let release: () => void = () => {};
            const r = rig({ recheck: () => new Promise<void>((done) => { release = done; }) });
            r.recovery.nudge();
            r.recovery.nudge();
            await settle();
            expect(r.rechecks()).toBe(1);
            release();
            await settle();
            expect(r.t.due).toHaveLength(1);
        });

        it('a nudge starts the asking if a kick never did', async () => {
            const r = rig();
            r.recovery.nudge();
            await settle();
            expect(r.rechecks()).toBe(1);
            expect(r.t.due).toHaveLength(1);
        });

        it('a nudge never restarts through a running turn', async () => {
            const agentId = record().id as string;
            const r = rig({ names: async () => [agentId], inTurn: true });
            r.recovery.nudge();
            await settle();
            expect(r.f.calls, 'the key is held and the turn is running: it waits').toEqual([]);
        });

        it('the wake watch runs only while someone waits, and its word is a nudge', async () => {
            let waiting = true;
            let wake: () => void = () => {};
            let started = 0;
            let stopped = 0;
            const r = rig({ waiting: () => waiting, watchWake: (onWake) => { started += 1; wake = onWake; return () => { stopped += 1; }; } });
            expect(started).toBe(0);
            r.recovery.kick();
            r.recovery.kick();
            expect(started).toBe(1);
            wake();
            await settle();
            expect(r.rechecks()).toBe(1);
            waiting = false;
            r.t.due.shift()!.fn();
            await settle();
            expect(stopped).toBe(1);
            expect(r.t.due).toEqual([]);
        });
    });

    describe('wallClockJumps: a host with no Electron hears that the machine slept', () => {
        function clock() {
            const c = { at: 1_000_000, due: [] as { ms: number; fn: () => void }[] };
            return { c, now: () => c.at, schedule: (ms: number, fn: () => void) => { const t = { ms, fn }; c.due.push(t); return () => { c.due.splice(c.due.indexOf(t), 1); }; } };
        }

        it('timers on time say nothing', () => {
            const { c, now, schedule } = clock();
            let woke = 0;
            wallClockJumps(() => { woke += 1; }, { everyMs: 30_000, toleranceMs: 60_000, now, schedule });
            for (let i = 0; i < 5; i += 1) { c.at += 30_000; c.due.shift()!.fn(); }
            expect(woke).toBe(0);
        });

        it('a timer far later than it asked says so, once per jump, and keeps watching', () => {
            const { c, now, schedule } = clock();
            let woke = 0;
            wallClockJumps(() => { woke += 1; }, { everyMs: 30_000, toleranceMs: 60_000, now, schedule });
            c.at += 3_600_000;
            c.due.shift()!.fn();
            expect(woke).toBe(1);
            c.at += 30_000;
            c.due.shift()!.fn();
            expect(woke).toBe(1);
            expect(c.due).toHaveLength(1);
        });

        it('stopping leaves nothing scheduled', () => {
            const { c, now, schedule } = clock();
            const stop = wallClockJumps(() => {}, { now, schedule });
            stop();
            expect(c.due).toEqual([]);
        });
    });

    it('a kick with nobody waiting schedules nothing, and a second kick does not start a second loop', () => {
        const f = fakeHost();
        const t = timers();
        let waiting = false;
        const recovery = hostTynnRecovery({ names: async () => [], waiting: () => waiting, recheck: async () => {}, host: f.host as never, record: () => null, threadOf: () => null, cwdFor: () => workspace, schedule: t.schedule });
        recovery.kick();
        expect(t.due).toEqual([]);
        waiting = true;
        recovery.kick();
        recovery.kick();
        expect(t.due).toHaveLength(1);
    });
});

describe('where it is wired', () => {
    const strip = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('the host recovers on an account change; a window with a host only passes on what it alone knows', () => {
        const host = strip(readFileSync('src/main/genie-host.ts', 'utf8'));
        expect(host).toMatch(/hostTynnRecovery\(/);
        expect(host).toMatch(/\.onChange\(\(\) => [^\n]*recover/);
        const main = strip(readFileSync('src/main/main.ts', 'utf8'));
        expect(main).toMatch(/!agentEngineLink \|\| !asked\.secretsMoved/);
    });
});

describe('A WORKSPACE A WINDOW HAS JUST ADDED IS NEVER REFUSED', () => {
    /** The registry's real store, with its write held open: what a slow disk does to a start sent right after it. */
    function heldStore() {
        const store = new Store(dir);
        let release = (): void => {};
        const gate = new Promise<void>((r) => { release = r; });
        const write = store.writeWorkspaces.bind(store);
        store.writeWorkspaces = async (workspaces) => { await gate; await write(workspaces); };
        return { store, release };
    }

    async function linked() {
        const { store, release } = heldStore();
        const model = new HostRegistry(store);
        const own = await openAgentStores(dir, () => new Date().toISOString());
        const stores = new AgentStoresService({ ...own, approvals: new ApprovalQueue(), registry: { store, model } });
        closers.push(() => own.knowledge.close());
        const handed: Array<readonly McpServer[]> = [];
        const t = tynnFake();
        const keys = hostAgentKeys({ vaultFile, keychain: fakeKeychain(), tynn: () => t.port, workspaces: () => model.listWorkspaces(), settled: () => stores.registrySettled() });
        const server = new SessionEngineServer({ token: 'a'.repeat(64), build: 'test', stores: stores as never, agentKeys: keys });
        const driverFor: DriverFor = (_r, _cwd, _thread, options) => {
            handed.push((options as { mcpServers?: readonly McpServer[] }).mcpServers ?? []);
            const factory: SessionDriverFactory = () => ({ start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } });
            return factory;
        };
        const host = new SessionHost({ userData: dir, driverFor, processTree: { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) }, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        await client.connect(windowSide, 'a'.repeat(64));
        return { client, host, handed, release, model };
    }

    it('the write has not landed when the start arrives: the start waits, and the agent has its key', async () => {
        const { client, host, handed, release, model } = await linked();
        const agent = record({ workspaceId: 'added' });
        const write = client.call('engine.stores', ['registry', 'writeWorkspaces', [[{ id: 'added', path: workspace }]]]);
        const started = client.start(agent, workspace);
        await new Promise((r) => setTimeout(r, 30));
        // CONTROL: the race is really on: the host does not know this workspace yet.
        expect(model.listWorkspaces().map((w) => w.id)).toEqual([]);
        expect(handed).toEqual([]);
        release();
        await write;
        expect(await started).toEqual({ ok: true });
        await until(() => handed.length === 1);
        expect(bearer(handed[0]!)).toContain('rpk_');
        expect(JSON.stringify(host.rowsFor(agent.id as AgentId))).not.toMatch(/workspace or Tynn project link is unavailable/);
        expect(host.refusals.has(agent.id as AgentId)).toBe(false);
        await host.stopAll();
    });

    it('a workspace nobody ever added is still refused, once nothing is in flight', async () => {
        const { host, handed, release } = await linked();
        release();
        const agent = record({ workspaceId: 'never-added' });
        await host.start(agent, workspace);
        await new Promise((r) => setTimeout(r, 40));
        expect(handed).toEqual([]);
        await host.stopAll();
    });
});
