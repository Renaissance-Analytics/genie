import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { RESTRICTED_CALL_CONTEXT, REMOTE_METHODS, type RemoteMethod } from '../src/core/remote-protocol.js';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import type { HostApi } from '../src/main/remote-host.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * A PILOT'S AGENT OPERATIONS WITH EVERY WINDOW CLOSED (Tynn #553, host split P5d.5a). genie-host answers every `agents.*`
 * call itself, with the same operations the window runs (agent-ops-host.ts over one shared set of ports), so an agent can
 * be set up, switched or deleted from another machine while nothing is open here. With a window connected the window
 * answers, as it always has.
 */

let dir = '';
let workspace = '';
let registry: Registry;
let atlas: AgentRecord;
const calls: string[] = [];

interface Probe { running: boolean; inTurn: boolean; turnState: string; pendingApproval: null; failure: null }
const IDLE: Probe = { running: true, inTurn: false, turnState: 'idle', pendingApproval: null, failure: null };

function engine(state: { probe: Probe | null } = { probe: IDLE }) {
    const subscribers = new Set<(id: string) => void>();
    const fake = {
        probe: () => state.probe,
        start: (r: AgentRecord, cwd: string) => { calls.push(`start ${r.name} ${r.provider} ${cwd === workspace ? 'ws' : cwd}`); state.probe = IDLE; return { ok: true }; },
        stop: () => { calls.push('stop'); state.probe = null; return true; },
        ended: async () => ({ verified: true, survivors: [], reason: '' }),
        deliverOwed: async () => 0,
        cancel: () => ({ ok: true }),
        resumeLimit: () => {},
        prompt: async (_id: string, text: string, by: string | null) => { calls.push(`prompt ${text} by ${by}`); return true; },
        promptWith: async () => ({ ok: true }),
        resolvePrompt: async () => ({ ok: true }),
        answerApproval: () => ({ ok: true }),
        subscribe: (l: (id: string) => void) => { subscribers.add(l); return () => subscribers.delete(l); },
        needsNewDriver: () => false,
        notice: () => true,
        ledgerFor: () => [],
        turnsFor: () => 3,
        recentStderrFor: () => [],
        rowsFor: () => [],
        refusals: new Map(),
        modelState: () => null,
        switchModel: () => null,
        settleParked: (_id: string, decision: string) => { calls.push(`settleParked ${decision}`); return true; },
        historyRows: async () => ({ rows: [], truncated: false }),
        toolOutput: async (_id: string, callId: string) => { calls.push(`toolOutput ${callId}`); return { ok: true, output: 'the whole output' }; },
        emit: (id: string) => { for (const l of subscribers) l(id); },
    };
    return fake as unknown as HostAloneEngine & { emit(id: string): void };
}

function ports(e: HostAloneEngine, over: Record<string, unknown> = {}): HostAlonePorts {
    return {
        hostName: 'alphar',
        registry,
        engine: () => e,
        cwdFor: () => workspace,
        startRefusal: () => null,
        attention: {
            finished: () => [],
            markSeen: () => {},
            answer: async () => true as never,
            lists: { done: async () => true },
        },
        approvals: { resolve: () => true },
        inbox: { unread: () => [], receive: async () => [] as never, involving: () => [] },
        deliverToAgent: async () => true,
        files: {
            children: async () => null,
            open: async (_w: string, path: string) => ({ ok: false as const, path, error: 'n/a' }),
            readBytes: async (_w: string, path: string) => ({ ok: false as const, path, error: 'n/a' }),
            upload: async () => ({ ok: false as const, reason: 'n/a' }),
        },
        models: { get: async (provider: string, options?: { refresh?: boolean }) => { calls.push(`models ${provider} ${options?.refresh === true}`); return { models: [{ id: 'opus' }] }; } },
        providerInstalled: (provider: string) => provider === 'codex',
        ...over,
    } as unknown as HostAlonePorts;
}

/** The gate a Pilot's call comes through, with no window connected. */
function gate(alone: HostApi, window: Partial<{ connected: () => boolean; invoke: HostApi['invoke'] }> = {}): HostApi {
    return hostRemoteApi({
        hostName: 'alphar',
        own: {},
        window: { connected: () => false, invoke: async () => { throw new Error('the window was asked'); }, ...window },
        alone,
    });
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-host-alone-ops-'));
    workspace = join(dir, 'ws');
    await mkdir(join(workspace, '.agents', 'atlas'), { recursive: true });
    await writeFile(join(workspace, '.agents', 'atlas', 'AGENT.md'), '# atlas\n');
    calls.length = 0;
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: workspace });
    atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** Every `agents.*` call a Pilot can make, with arguments it would send. A new one fails the first test until it is added. */
const CALLS: Record<string, (id: string) => unknown[]> = {
    'agents.restart': (id) => [id, 'graceful'],
    'agents.previewDelete': (id) => [id, 'unmount', []],
    'agents.delete': (id) => [id, 'unmount', [], false],
    'agents.switchDriver': (id) => [id, 'codex'],
    'agents.setBudget': (id) => [id, 5],
    'agents.setMode': (id) => [id, 'manual'],
    'agents.setAccessScope': (id) => [id, 'all'],
    'agents.setAccessAgents': (id) => [id, null],
    'agents.setAutoApprove': (id) => [id, true],
    'agents.setManageTabs': (id) => [id, true],
    'agents.setDrivePages': (id) => [id, true],
    'agents.setIssueWatch': (id) => [id, { delivery: 'off', kinds: [] }],
    'agents.setPermissions': (id) => [id, 'edits'],
    'agents.setModel': (id) => [id, 'opus'],
    'agents.models': (id) => [id, false],
    'agents.diagnose': (id) => [id],
    'agents.toolOutput': (id) => [id, 'call_1'],
};

describe('every agents.* call is answered with no window', () => {
    const family = REMOTE_METHODS.filter((m) => m.startsWith('agents.'));

    it('the list here is the protocol\'s whole family', () => {
        expect(Object.keys(CALLS).sort()).toEqual([...family].sort());
        expect(family.length).toBeGreaterThan(10);
    });

    it.each(family)('%s reaches genie-host, not the "open a window" refusal', async (method) => {
        // Not running: a change here applies at the next start, so no restart outlives the test and its folder.
        const api = gate(hostAloneApi(ports(engine({ probe: null }))));
        await expect(api.invoke(method as RemoteMethod, CALLS[method]!(atlas.id))).resolves.toBeDefined();
    });
});

describe('they do what the window\'s do', () => {
    it('a setting is written to the registry\'s files', async () => {
        const api = gate(hostAloneApi(ports(engine())));
        // A new agent is manual: the write has to change something for this to prove anything.
        expect(registry.find(atlas.id)?.mode).toBe('manual');
        expect(await api.invoke('agents.setMode', [atlas.id, 'automated'])).toMatchObject({ ok: true, record: { mode: 'automated' } });
        const fresh = new Registry(new Store(dir));
        await fresh.load({ name: 'alphar', healthy: true });
        expect(fresh.find(atlas.id)?.mode).toBe('automated');
    });

    it('a setting that was changed tells the Pilot: the snapshot follows at once', async () => {
        const api = hostAloneApi(ports(engine(), { schedule: (_ms: number, fn: () => void) => { fn(); return () => {}; } }));
        const seen: string[] = [];
        const off = api.onEvent((channel) => { seen.push(channel); });
        await api.invoke('agents.setAutoApprove', [atlas.id, true]);
        off();
        expect(seen).toContain('snapshot');
    });

    it('a tool setting answers a shell command already waiting on the person, with no restart', async () => {
        const api = gate(hostAloneApi(ports(engine())));
        expect(await api.invoke('agents.setPermissions', [atlas.id, 'all'])).toMatchObject({ ok: true, apply: { when: 'live' } });
        expect(calls).toEqual(['settleParked allow']);
    });

    it('a provider switch stops the agent and starts it on the new provider', async () => {
        const api = gate(hostAloneApi(ports(engine())));
        expect(await api.invoke('agents.switchDriver', [atlas.id, 'codex'])).toMatchObject({ ok: true });
        expect(registry.find(atlas.id)?.provider).toBe('codex');
        expect(calls[0]).toBe('stop');
    });

    it('a provider this machine does not have is refused before anything stops (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports(engine(), { providerInstalled: () => false })));
        expect(await api.invoke('agents.switchDriver', [atlas.id, 'codex'])).toMatchObject({ ok: false, reason: expect.stringContaining('not installed') });
        expect(calls).toEqual([]);
        expect(registry.find(atlas.id)?.provider).toBe('claude');
    });

    it('a delete previews, then stops the agent, forgets it and removes its persona folder', async () => {
        const api = gate(hostAloneApi(ports(engine())));
        expect(await api.invoke('agents.previewDelete', [atlas.id, 'delete', []])).toMatchObject({ ok: true, plan: {} });
        expect(registry.find(atlas.id)).not.toBeNull();
        expect(await api.invoke('agents.delete', [atlas.id, 'delete', [], false])).toMatchObject({ ok: true });
        expect(calls).toEqual(['stop']);
        expect(registry.find(atlas.id)).toBeNull();
        await expect(stat(join(workspace, '.agents', 'atlas'))).rejects.toThrow();
    });

    it('an unmount forgets the agent and leaves its persona folder (CONTROL)', async () => {
        const api = gate(hostAloneApi(ports(engine())));
        expect(await api.invoke('agents.delete', [atlas.id, 'unmount', [], false])).toMatchObject({ ok: true });
        expect(registry.find(atlas.id)).toBeNull();
        expect(await readFile(join(workspace, '.agents', 'atlas', 'AGENT.md'), 'utf8')).toBe('# atlas\n');
    });

    it('the model list is asked of the provider; a tool row\'s output of the session host', async () => {
        const api = gate(hostAloneApi(ports(engine())));
        await api.invoke('agents.models', [atlas.id, true]);
        expect(calls).toEqual(['models claude true']);
        expect(await api.invoke('agents.toolOutput', [atlas.id, 'call_9'])).toMatchObject({ ok: true, output: 'the whole output' });
        expect(calls).toContain('toolOutput call_9');
    });

    it('Diagnose reads the agent from genie-host', async () => {
        const api = gate(hostAloneApi(ports(engine(), {})));
        expect(await api.invoke('agents.diagnose', [atlas.id])).toMatchObject({ ok: true, diagnosis: {} });
    });

    it('a model change on a busy agent waits for its turn to end, then restarts it, with no window', async () => {
        // A thread makes the restart graceful: a fresh one writes the registry after the start this test waits for.
        expect(await registry.recordThread(atlas.id, 'thread_1')).toEqual({ ok: true });
        const state: { probe: Probe | null } = { probe: { ...IDLE, inTurn: true, turnState: 'working' } };
        const e = engine(state);
        const api = gate(hostAloneApi(ports(e)));
        expect(await api.invoke('agents.setModel', [atlas.id, 'opus'])).toMatchObject({ ok: true, apply: { when: 'after-turn' } });
        expect(calls).toEqual([]);
        // CONTROL: still working, the session's change applies nothing.
        e.emit(atlas.id);
        expect(calls).toEqual([]);
        state.probe = IDLE;
        e.emit(atlas.id);
        await vi.waitFor(() => { expect(calls).toEqual(['stop', 'start atlas claude ws']); });
    });
});

describe('the gate', () => {
    it('with a window connected the window answers, and genie-host is not asked (CONTROL)', async () => {
        const alone = hostAloneApi(ports(engine()));
        const invoke = vi.spyOn(alone, 'invoke');
        const api = gate(alone, { connected: () => true, invoke: async (method) => `window answered ${method}` });
        expect(await api.invoke('agents.setMode', [atlas.id, 'automated'])).toBe('window answered agents.setMode');
        expect(invoke).not.toHaveBeenCalled();
        expect(registry.find(atlas.id)?.mode).toBe('manual');
    });

    it('the caller\'s context travels with the call', async () => {
        const alone = hostAloneApi(ports(engine()));
        const invoke = vi.spyOn(alone, 'invoke');
        await gate(alone).invoke('agents.diagnose', [atlas.id], RESTRICTED_CALL_CONTEXT);
        expect(invoke).toHaveBeenCalledWith('agents.diagnose', [atlas.id], RESTRICTED_CALL_CONTEXT);
    });

    it('a family not moved yet still says to open a window (CONTROL: this is not an open door)', async () => {
        const api = gate(hostAloneApi(ports(engine())));
        await expect(api.invoke('addAgent', ['tynn', {}])).rejects.toThrow('open Genie on alphar');
    });
});

describe('the wiring', () => {
    const src = (path: string) => readFileSync(path, 'utf8');

    it('genie-host writes agent records the way a window does, so its own model and every window follow', () => {
        const host = src('src/main/genie-host.ts');
        expect(host).not.toContain('new Registry(registryStore)');
        expect(host).toMatch(/new Registry\(new HostRegistryStore\(\{ call: \(store, method, args\) => stores\.call\(store, method, args\)/);
    });

    it('the window and genie-host answer through one adapter over one set of ports', () => {
        for (const file of ['src/main/main.ts', 'src/main/host-alone-api.ts']) {
            expect(src(file)).toContain('agentOpsApi(');
            expect(src(file)).toContain('agentOpsPorts(');
        }
        expect(src('src/main/host-alone-api.ts')).not.toContain("windowOnly<HostApiDeps['agentOps']>");
    });

    it('every write in the adapter refreshes what clients see', () => {
        const whole = src('src/main/agent-ops-api.ts');
        const adapter = whole.slice(whole.indexOf('export function agentOpsApi'));
        for (const method of ['restart', 'delete', 'switchDriver', 'setBudget', 'setMode', 'setAccessScope', 'setAccessAgents', 'setAutoApprove', 'setManageTabs', 'setDrivePages', 'setIssueWatch', 'setPermissions', 'setModel']) {
            const line = adapter.split('\n').find((l) => l.trimStart().startsWith(`${method}:`));
            expect(line, method).toBeDefined();
            expect(line, method).toContain('.finally(touch)');
        }
    });
});
