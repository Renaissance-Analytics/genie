import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctorHoldFile } from '../src/core/genie-running.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { DoctorRun } from '../src/main/doctor-run.js';
import { OS_WORKSPACE } from '../src/main/registry.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { Store } from '../src/main/store.js';

/**
 * DOCTOR BESIDE A RUNNING GENIE (the owner, 2026-10-14: "doctor should be able to profile an agent even while we have
 * genie open. It should be able to load any Active workspace that has no started agents").
 *
 * The danger it must not create: Genie's stores (agents, settings, inbox, attention…) live in memory and are written
 * whole, so two processes writing them silently undo each other. So beside a running Genie, doctor:
 * - starts an agent only in an AWAKE workspace where that Genie reports NO started agent (and never genie itself);
 * - works on its OWN COPIES of those stores — the running Genie's files are not written;
 * - shares only the agent's thread (nobody else is writing it), and HOLDS the workspace: the running Genie refuses to
 *   start an agent there until doctor lets go.
 */
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
let home: string;
let wsAwake: string;
let wsAsleep: string;
let runs: DoctorRun[] = [];
const kai = agentRecord({ id: mintAgentId(), workspaceId: 'ws_awake', provider: 'claude', name: 'kai' });
const ren = agentRecord({ id: mintAgentId(), workspaceId: 'ws_awake', provider: 'claude', name: 'ren' });
const sol = agentRecord({ id: mintAgentId(), workspaceId: 'ws_asleep', provider: 'claude', name: 'sol' });
const osa = agentRecord({ id: mintAgentId(), workspaceId: OS_WORKSPACE, provider: 'claude', name: 'genie' });

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie2-doctorbeside-'));
    wsAwake = join(home, 'projects', 'awake');
    wsAsleep = join(home, 'projects', 'asleep');
    await mkdir(wsAwake, { recursive: true });
    await mkdir(wsAsleep, { recursive: true });
    const store = new Store(home);
    await store.writeWorkspaces([{ id: 'ws_awake', path: wsAwake }, { id: 'ws_asleep', path: wsAsleep, asleep: true }]);
    await store.writeAgents([kai, ren, sol, osa]);
});
afterEach(async () => {
    for (const r of runs) await r.stop();
    runs = [];
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

function doctorBeside(agents: readonly string[] | null) {
    const started: string[] = [];
    const driverFor: DriverFor = (record) => ((options: { events: DriverEvents }) => {
        void options;
        started.push(record.name);
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    }) as unknown as SessionDriverFactory;
    const run = new DoctorRun({ genieHome: home, besideHome: join(home, 'doctor-beside'), genieRunning: () => ({ running: true, pid: 4242, agents }), prepareOsaHome: async () => {}, driverFor, processTree: tree });
    runs.push(run);
    const call = async (name: string, args: Record<string, unknown>) => {
        const tool = run.tools().find((t) => t.definition.name === name)!;
        const r = await tool.handler(args as never, { server: 'genie', tool: name, headers: {} });
        return { isError: r.isError, json: JSON.parse(r.text) as Record<string, any> };
    };
    return { run, call, started };
}

describe('doctor starts an agent beside a running Genie', () => {
    it('in an awake workspace where that Genie has nothing started: it starts', async () => {
        const d = doctorBeside([]);
        const r = await d.call('startAgent', { workspace: 'ws_awake', agent: 'kai' });
        expect(r.isError).toBe(false);
        expect(d.started).toEqual(['kai']);
        expect(r.json.started).toMatchObject({ name: 'kai', besideGenie: true });
    });

    it('REFUSED where that Genie has an agent started — naming it — and starts nothing', async () => {
        const d = doctorBeside([ren.id]);
        const r = await d.call('startAgent', { workspace: 'ws_awake', agent: 'kai' });
        expect(r.isError).toBe(true);
        expect(r.json.error).toMatch(/ren/);
        expect(d.started).toHaveLength(0);
    });

    it('REFUSED in a hibernated workspace, and for genie itself (the running Genie\'s own)', async () => {
        const d = doctorBeside([]);
        const asleep = await d.call('startAgent', { workspace: 'ws_asleep', agent: 'sol' });
        expect(asleep.isError).toBe(true);
        expect(asleep.json.error).toMatch(/hibernat/i);
        const own = await d.call('startAgent', { agent: 'genie' });
        expect(own.isError).toBe(true);
        expect(d.started).toHaveLength(0);
    });

    it('writes NOTHING of the running Genie\'s stores: its agents file is byte-equal after doctor records a thread', async () => {
        const agentsFile = join(home, 'runtime', 'agents.json');
        const before = await readFile(agentsFile);
        let events: DriverEvents | null = null;
        const driverFor: DriverFor = () => ((options: { events: DriverEvents }) => {
            events = options.events;
            return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return 'cli-thread-1'; } };
        }) as unknown as SessionDriverFactory;
        const run = new DoctorRun({ genieHome: home, besideHome: join(home, 'doctor-beside'), genieRunning: () => ({ running: true, pid: 4242, agents: [] }), prepareOsaHome: async () => {}, driverFor, processTree: tree });
        runs.push(run);
        const start = run.tools().find((t) => t.definition.name === 'startAgent')!;
        expect((await start.handler({ workspace: 'ws_awake', agent: 'kai' } as never, { server: 'genie', tool: 'startAgent', headers: {} })).isError).toBe(false);
        // The provider reports its own session id: in normal Genie that is written to the agent record.
        (events as DriverEvents | null)?.onUpdate?.({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'session started' }, _meta: { 'particle.academy/cli_session_id': 'cli-thread-1' } });
        await new Promise((r) => setTimeout(r, 50));
        expect(Buffer.compare(await readFile(agentsFile), before)).toBe(0);
    });

    it('HOLDS the workspace while its agent runs, and lets go when it stops', async () => {
        const d = doctorBeside([]);
        await d.call('startAgent', { workspace: 'ws_awake', agent: 'kai' });
        const hold = JSON.parse(readFileSync(doctorHoldFile(home), 'utf8')) as { pid: number; workspaceId: string; agentId: string };
        expect(hold).toMatchObject({ pid: process.pid, workspaceId: 'ws_awake', agentId: kai.id });
        await d.call('stopAgent', {});
        expect(() => readFileSync(doctorHoldFile(home), 'utf8')).toThrow();
    });
});

describe('the running Genie respects the hold', () => {
    it('a session host refuses to start an agent its heldElsewhere check names — and starts one it does not', () => {
        const driverFor: DriverFor = () => (() => ({ start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } })) as unknown as SessionDriverFactory;
        const host = new SessionHost({ userData: home, driverFor, processTree: tree, heldElsewhere: (record) => (record.workspaceId === 'ws_awake' ? 'doctor mode is running an agent in this workspace' : null) });
        const refused = host.start(kai, wsAwake);
        expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/doctor mode/) });
        expect(host.probe(kai.id)).toBeNull();
        // CONTROL: elsewhere it starts.
        expect(host.start(sol, wsAsleep)).toEqual({ ok: true });
        host.stopAll();
    });

    it('normal Genie wires the hold into its session host, and publishes which agents it runs', () => {
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
        expect(main.match(/heldElsewhere:/g) ?? []).toHaveLength(1);
        expect(main.match(/markGenieRunning\(genieHome\(\),\s*[a-zA-Z]/g) ?? []).not.toHaveLength(0);
    });
});

