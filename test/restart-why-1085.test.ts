import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { agentRunLine } from '../src/core/start-why.js';
import { restartAgent, SettingApplier, setModel, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * EVERY RUN OF AN AGENT SAYS WHY IT STARTED (Tynn #1085). Tracing why the owner's questions went stale, lifecycle.log showed
 * a restart of every agent at once (2026-11-26T20:41:54, exit and start in the same ms for each) and single restarts
 * (fancy 08:32:10, moic 08:43:12) with nothing saying what started them: settings applied, MCP recovery, the plan keepalive,
 * an account move, a person's Restart, a boot restore. Now each start carries its reason to ONE line in the log.
 */
const noTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const driverFor: DriverFor = () => (() => ({ start: () => {}, prompt: () => {}, kill: () => {}, cliSessionId: null, ready: Promise.resolve() })) as SessionDriverFactory;
const atlas = (): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'atlas' });

let dir: string;
let hosts: SessionHost[] = [];
const starts: string[] = [];
const lifecycle = {
    spawned: () => {}, ended: () => {}, straggler: () => {},
    starting: (agentId: string, run: number, why: string) => { starts.push(`${agentId}:${run}:${why}`); },
};
const make = (extra: object = {}) => {
    const host = new SessionHost({ userData: dir, driverFor, processTree: noTree, lifecycle, ...extra } as ConstructorParameters<typeof SessionHost>[0]);
    hosts.push(host);
    return host;
};

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-start-why-')); starts.length = 0; hosts = []; });
afterEach(async () => { for (const h of hosts) await h.stopAll(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

describe('the session host names why each run started', () => {
    it('a start that says why: one starting report, with that reason and the run', () => {
        const host = make();
        const r = atlas();
        host.start(r, dir, { why: 'mcp-recovery' });
        expect(starts).toHaveLength(1);
        expect(starts[0]).toMatch(new RegExp(`^${r.id}:\\d+:mcp-recovery$`));
    });

    it('a start that says nothing reads as a plain start', () => {
        const host = make();
        const r = atlas();
        host.start(r, dir);
        expect(starts).toEqual([expect.stringMatching(/:start$/)]);
    });

    it('control: a start of an agent already running starts no run and reports nothing', () => {
        const host = make();
        const r = atlas();
        host.start(r, dir, { why: 'settings' });
        host.start(r, dir, { why: 'restart' });
        expect(starts).toEqual([expect.stringMatching(/:settings$/)]);
    });
});

describe('the reason crosses the engine protocol', () => {
    it('a window\'s start with a reason reaches the host\'s start with it', async () => {
        const server = new SessionEngineServer({ token: 'a'.repeat(64), build: 'test', schedule: (_ms, fn) => { setTimeout(fn, 0); return () => {}; } });
        const host = make(server.hostOptions());
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient({});
        await client.connect(windowSide, 'a'.repeat(64));
        await client.start(atlas(), dir, { why: 'keepalive' });
        expect(starts).toEqual([expect.stringMatching(/:keepalive$/)]);
    });
});

function ports(calls: string[]): AgentOpsPorts {
    const current = { id: 'agent_a', workspaceId: 'tynn', provider: 'claude', name: 'atlas', instructions: null, threadId: 'sess-1', createdAt: 't', lastUsedAt: 't', mode: 'manual', accessScope: 'self' } as unknown as AgentRecord;
    let record = current;
    return {
        registry: {
            find: (id: string) => (id === record.id ? record : null),
            clearThread: async () => { record = { ...record, threadId: null }; return record; },
            setModel: async (_id: string, model: string | null) => { record = { ...record, ...(model === null ? {} : { model }) }; return record; },
        },
        host: {
            start: (_r: AgentRecord, _cwd: string, how?: { why?: string }) => { calls.push(`start:${how?.why ?? '(none)'}`); return { ok: true }; },
            stop: () => true,
            ended: async () => null,
            probe: () => ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null }),
            deliverOwed: async () => 0,
        },
        cwdFor: () => '/w/tynn',
        startRefusal: () => null,
    } as unknown as AgentOpsPorts;
}

describe('the one Restart passes its caller\'s reason to the start', () => {
    it('graceful and fresh both start with the reason they were given', async () => {
        const calls: string[] = [];
        await restartAgent(ports(calls), 'agent_a', 'graceful', 'mcp-recovery');
        await restartAgent(ports(calls), 'agent_a', 'fresh', 'restart');
        expect(calls).toEqual(['start:mcp-recovery', 'start:restart']);
    });

    it('a model change applied to a running agent restarts it for settings', async () => {
        const calls: string[] = [];
        const p = ports(calls);
        const applier = new SettingApplier(p, () => 0);
        p.applyOnStart = (id) => applier.requested(id);
        await setModel(p, 'agent_a', 'opus');
        await new Promise((r) => setTimeout(r, 0));
        expect(calls).toEqual(['start:settings']);
    });
});

describe('the lifecycle line', () => {
    it('names the agent, the run and the reason', () => {
        expect(agentRunLine('agent_x', 35, 'account-move')).toBe('agent run owner=agent_x run=35 why=account-move');
    });
});
