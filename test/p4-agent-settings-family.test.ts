import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import type { LocalFramePort } from '../src/core/local-frame.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { pageBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

// Frozen preload forwarding at 14605c80. The native input guards below are from that same head.
function oldAgents(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
    return {
        restart: (id: string, kind: string) => invoke('genie:agent-restart', id, kind),
        previewDelete: (id: string, outcome: string, also: readonly string[]) => invoke('genie:agent-preview-delete', id, outcome, [...also]),
        delete: (id: string, outcome: string, also: readonly string[], handoff?: boolean) => invoke('genie:agent-delete', id, outcome, [...also], handoff === true),
        switchDriver: (id: string, to: string) => invoke('genie:agent-switch-driver', id, to),
        setBudget: (id: string, usd: number | null) => invoke('genie:agent-set-budget', id, usd),
        setMode: (id: string, mode: string) => invoke('genie:agent-set-mode', id, mode),
        setAccessScope: (id: string, scope: string) => invoke('genie:agent-set-access-scope', id, scope),
        setAutoApprove: (id: string, on: boolean) => invoke('genie:agent-set-auto-approve', id, on),
        setManageTabs: (id: string, on: boolean) => invoke('genie:agent-set-manage-tabs', id, on),
        setDrivePages: (id: string, on: boolean) => invoke('genie:agent-set-drive-pages', id, on),
        setIssueWatch: (id: string, setting: unknown) => invoke('genie:agent-set-issue-watch', id, setting),
        setPermissions: (id: string, permissions: string) => invoke('genie:agent-set-permissions', id, permissions),
        setModel: (id: string, model: string | null) => invoke('genie:agent-set-model', id, model),
        models: (id: string, refresh?: boolean) => invoke('genie:agent-models', id, refresh === true),
        diagnose: (id: string) => invoke('genie:agent-diagnose', id),
    };
}
type AgentKey = keyof ReturnType<typeof oldAgents>;
type Row = { name: AgentKey; channel: string; args: unknown[]; result: unknown; wireArgs?: unknown[] };
const record = { id: 'agent_a', name: 'atlas', workspaceId: 'work', provider: 'claude', model: null };
const plan = { outcome: 'delete', removes: ['persona folder'], keeps: ['conversation archive'], external: [{ system: 'tynn', action: 'removed' }] };
const rows: Row[] = [
    { name: 'restart', channel: 'genie:agent-restart', args: ['agent_a', 'fresh'], result: { ok: true, kind: 'fresh', discarded: 'thread-1' } },
    { name: 'previewDelete', channel: 'genie:agent-preview-delete', args: ['agent_a', 'delete', ['tynn', 'github']], result: { ok: true, plan } },
    { name: 'delete', channel: 'genie:agent-delete', args: ['agent_a', 'delete', ['tynn'], true], result: { ok: true, plan, handoff: 'landed' } },
    { name: 'switchDriver', channel: 'genie:agent-switch-driver', args: ['agent_a', 'codex'], result: { ok: true, from: 'claude', to: 'codex', carried: { turns: 2, of: 2, plan: false }, left: 'thread-1', droppedModel: null } },
    { name: 'setBudget', channel: 'genie:agent-set-budget', args: ['agent_a', 12.5], result: { ok: true, record, decision: { kind: 'unenforceable', reason: 'provider reports no cost' } } },
    { name: 'setMode', channel: 'genie:agent-set-mode', args: ['agent_a', 'automated'], result: { ok: true, record: { ...record, mode: 'automated' } } },
    { name: 'setAccessScope', channel: 'genie:agent-set-access-scope', args: ['agent_a', 'none'], result: { ok: true, record: { ...record, accessScope: 'none' } } },
    { name: 'setAutoApprove', channel: 'genie:agent-set-auto-approve', args: ['agent_a', true], result: { ok: true, record: { ...record, autoApprove: true } } },
    { name: 'setManageTabs', channel: 'genie:agent-set-manage-tabs', args: ['agent_a', true], result: { ok: true, record: { ...record, manageTabs: true } } },
    { name: 'setDrivePages', channel: 'genie:agent-set-drive-pages', args: ['agent_a', true], result: { ok: true, record: { ...record, drivePages: true } } },
    { name: 'setIssueWatch', channel: 'genie:agent-set-issue-watch', args: ['agent_a', { delivery: 'inbox', kinds: ['issue.new', 'pr.new'] }], result: { ok: true, record: { ...record, issueWatch: { delivery: 'inbox', kinds: ['issue.new', 'pr.new'] } } } },
    { name: 'setPermissions', channel: 'genie:agent-set-permissions', args: ['agent_a', 'ask'], result: { ok: true, record, apply: { when: 'live' } } },
    { name: 'setModel', channel: 'genie:agent-set-model', args: ['agent_a', 'fixture-model'], result: { ok: true, record: { ...record, model: 'fixture-model' }, apply: { when: 'switched', timing: 'next-turn' } } },
    { name: 'models', channel: 'genie:agent-models', args: ['agent_a', true], result: { ok: true, provider: 'claude', models: [{ modelId: 'fixture-model', name: 'Fixture model', description: 'Fixture choice', isDefault: true }], current: null, source: 'session' } },
    { name: 'diagnose', channel: 'genie:agent-diagnose', args: ['agent_a'], result: { ok: true, diagnosis: { state: 'dormant', fault: false, cause: null, repair: null } } },
];
const call = (agents: object, row: Pick<Row, 'name' | 'args'>) => Reflect.apply((agents as Record<AgentKey, (...args: unknown[]) => Promise<unknown>>)[row.name], agents, row.args);
let dir: string;
let devices: DeviceStore;
const close: Array<() => void> = [];
const clients: RemoteClient[] = [];
function serve(deps: HostApiDeps) {
    const api = buildHostApi(deps), invoke = vi.spyOn(api, 'invoke');
    let accept!: (connection: ServerConnection) => void;
    const host = new RemoteHost({ api, hostName: 'agent-settings-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (listener) => { accept = listener; return () => {}; } } });
    const pair = inMemoryPair(); close.push(() => pair.client.close());
    const framePort = (): LocalFramePort => {
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        let handle = '';
        pair.client.onMessage((text) => { for (const listener of listeners) listener('frame', handle, text); });
        pair.client.onClose(() => { for (const listener of listeners) listener('closed', handle, ''); });
        return { onFrame: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, send: (action, id, text) => {
            if (action === 'open') { handle = id; accept({ ...pair.server, preAuth: { kind: 'local', label: 'settings-page', isOwner: true, workspaceId: null, readonly: false } }); }
            else if (action === 'frame') pair.client.send(text);
            else pair.client.close();
        } };
    };
    return { invoke, framePort, connect: async (remote = false) => {
        accept(remote ? pair.server : { ...pair.server, preAuth: { kind: 'local', label: 'settings-window', isOwner: true, workspaceId: null, readonly: false } });
        const client = connectRemote(pair.client, remote ? { kind: 'pin', code: host.issuePin().code } : { kind: 'local' }, 'settings-window'); clients.push(client);
        expect(await client.ready).toEqual({ ok: true });
        if (remote) expect(await client.takeBaton()).toEqual({ ok: true });
        return client;
    } };
}
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-p4-agent-settings-'));
    let seq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `settings-fixture-${++seq}` });
});
afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const stop of close.splice(0)) stop();
    vi.unstubAllGlobals(); await new Promise<void>((resolve) => setImmediate(resolve));
    await devices.flushed(); await rm(dir, { recursive: true, force: true });
});

describe('all fifteen agent settings calls use the one protocol', () => {
    it.each(rows)('$name preserves the old meaningful result and recorded API/dependency arguments', async (row) => {
        const deps = protocolContractDeps(dir), operation = vi.fn(async (..._args: unknown[]) => row.result);
        Object.assign(deps.agentOps, { [row.name]: operation });
        const source = serve(deps), client = await source.connect();
        const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => row.result);
        expect(await call(client.bridge.agents, row)).toEqual(await call(oldAgents(invoke), row));
        expect(invoke).toHaveBeenCalledExactlyOnceWith(row.channel, ...row.args);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(`agents.${row.name}`, row.args, expect.anything());
        expect(operation).toHaveBeenCalledExactlyOnceWith(...row.args);
    });
    it.each(rows)('pageBridge routes $name through the real local client without old preload fallback', async (row) => {
        const deps = protocolContractDeps(dir), operation = vi.fn(async (..._args: unknown[]) => row.result);
        Object.assign(deps.agentOps, { [row.name]: operation });
        const source = serve(deps); vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const oldInvoke = vi.fn(async (_channel: string, ..._args: unknown[]) => row.result);
        const snapshot = vi.fn(async () => ({ workspaces: null })), hibernate = vi.fn(async () => ({ ok: false, reason: 'agent still working' }));
        const preload = { snapshot, subscribeAgentWire: () => () => {}, workspaces: { tynnBoard: hibernate }, agents: oldAgents(oldInvoke) } as unknown as PreloadBridge;
        const bridge = pageBridge(preload); expect(pageBridge(preload)).toBe(bridge);
        expect(await call(bridge.agents, row)).toEqual(row.result);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(`agents.${row.name}`, row.args, expect.anything());
        expect(operation).toHaveBeenCalledExactlyOnceWith(...row.args); expect(oldInvoke).not.toHaveBeenCalled();
        expect(await bridge.snapshot()).toEqual({ workspaces: null });
        expect(await bridge.workspaces.tynnBoard!('work', undefined as never)).toEqual({ ok: false, reason: 'agent still working' });
        expect(snapshot).toHaveBeenCalledTimes(1); expect(hibernate).toHaveBeenCalledExactlyOnceWith('work', undefined);
    });
    it.each(rows)('$name retires its native handler, preload forwarding and inventory row', (row) => {
        const main = readFileSync('src/main/main.ts', 'utf8'), preload = readFileSync('src/main/preload.ts', 'utf8'), inventory = readFileSync('src/core/ipc-inventory.ts', 'utf8');
        expect(main).toContain("ipcMain.handle('genie:agent-detail'");
        expect(preload).toContain("ipcRenderer.invoke('genie:agent-detail'");
        expect(inventory).toContain("['genie:agent-detail', 'protocol:agentDetail']");
        expect(main.includes(`ipcMain.handle('${row.channel}'`)).toBe(false);
        expect(preload.includes(`ipcRenderer.invoke('${row.channel}'`)).toBe(false);
        expect(inventory.includes(`['${row.channel}',`)).toBe(false);
    });
    it.each(rows)('$name preserves a null dependency result', async (row) => {
        const deps = protocolContractDeps(dir), operation = vi.fn(async () => null);
        Object.assign(deps.agentOps, { [row.name]: operation });
        const source = serve(deps), client = await source.connect();
        expect(await call(client.bridge.agents, row)).toBeNull();
        expect(operation).toHaveBeenCalledExactlyOnceWith(...row.args);
    });
    it.each(rows)('$name shows a domain refusal unchanged on the actual page bridge', async (row) => {
        const deps = protocolContractDeps(dir), refusal = { ok: false, reason: 'the agent cannot change this setting while stopping' };
        Object.assign(deps.agentOps, { [row.name]: vi.fn(async () => refusal) });
        const source = serve(deps); vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const bridge = pageBridge({ subscribeAgentWire: () => () => {}, workspaces: {}, agents: oldAgents(vi.fn(async () => ({ ok: true }))) } as unknown as PreloadBridge);
        expect(await call(bridge.agents, row)).toEqual(refusal);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(`agents.${row.name}`, row.args, expect.anything());
    });
    it('all moved calls explain a missing local connection without falling back, while unmoved calls still work', async () => {
        vi.stubGlobal('window', {});
        const oldInvoke = vi.fn(async () => ({ ok: true })), snapshot = vi.fn(async () => ({ agents: [] }));
        const bridge = pageBridge({ snapshot, subscribeAgentWire: () => () => {}, workspaces: {}, agents: oldAgents(oldInvoke) } as unknown as PreloadBridge);
        for (const row of rows) expect(await call(bridge.agents, row)).toEqual({ ok: false, reason: 'This Genie window has no local protocol connection.' });
        expect(oldInvoke).not.toHaveBeenCalled(); expect(await bridge.snapshot()).toEqual({ agents: [] });
    });
    it('a thrown provider failure becomes a visible protocol refusal', async () => {
        const deps = protocolContractDeps(dir); deps.agentOps.models = async () => { throw new Error('provider model list unavailable'); };
        const source = serve(deps); vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const bridge = pageBridge({ subscribeAgentWire: () => () => {}, workspaces: {}, agents: oldAgents(vi.fn(async () => ({ ok: true }))) } as unknown as PreloadBridge);
        expect(await bridge.agents.models!('agent_a', true)).toEqual({ ok: false, reason: 'provider model list unavailable' });
    });
    it.each([false, true])('probe enabled=%s changes only genieTest presence, not calls/results or the one connection', async (enabled) => {
        const deps = protocolContractDeps(dir), result = { ok: true, record: { ...record, mode: 'manual' } };
        const operation = vi.fn(async () => result); deps.agentOps.setMode = operation;
        const source = serve(deps), port = source.framePort(), send = vi.fn(port.send);
        const snapshot = vi.fn(async () => ({ agents: [] }));
        const preload = { snapshot, subscribeAgentWire: () => () => {}, workspaces: {} } as unknown as PreloadBridge;
        const page: Record<string, unknown> = { genie: preload, genieLocalProtocol: { ...port, send } };
        Object.defineProperty(page, 'genieTestMode', { value: enabled, writable: false, configurable: false });
        vi.stubGlobal('window', page);
        const bridge = pageBridge(preload);
        expect(await bridge.agents.setMode('agent_a', 'manual')).toEqual(result);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith('agents.setMode', ['agent_a', 'manual'], expect.anything());
        expect(operation).toHaveBeenCalledExactlyOnceWith('agent_a', 'manual');
        expect(send.mock.calls.filter(([action]) => action === 'open')).toHaveLength(1);
        expect(await bridge.snapshot()).toEqual({ agents: [] }); expect(snapshot).toHaveBeenCalledTimes(1);
        expect(pageBridge(preload)).toBe(bridge); expect(page['genie']).toBe(preload);
        expect(page['genieTest']).toBe(enabled ? bridge : undefined);
    });
    it.each([
        { name: 'restart', args: ['agent_a', 'graceful'] },
        { name: 'previewDelete', args: ['agent_a', 'unmount', []] },
        { name: 'delete', args: ['agent_a', 'unmount', []], wireArgs: ['agent_a', 'unmount', [], false] },
        { name: 'setBudget', args: ['agent_a', null] }, { name: 'setBudget', args: ['agent_a', 0] },
        { name: 'setMode', args: ['agent_a', 'manual'] }, { name: 'setAccessScope', args: ['agent_a', 'self'] }, { name: 'setAccessScope', args: ['agent_a', 'all'] },
        { name: 'setAutoApprove', args: ['agent_a', false] }, { name: 'setManageTabs', args: ['agent_a', false] }, { name: 'setDrivePages', args: ['agent_a', false] },
        { name: 'setPermissions', args: ['agent_a', 'all'] }, { name: 'setPermissions', args: ['agent_a', 'edits'] },
        { name: 'setModel', args: ['agent_a', null] },
        // Empty is forwarded unchanged to setModel, whose existing validator refuses it; it is never a default selection.
        { name: 'setModel', args: ['agent_a', ''], result: { ok: false, reason: 'a model needs a name — choose the default to clear it' } },
        { name: 'models', args: ['agent_a'], wireArgs: ['agent_a', false] },
    ] satisfies Array<Partial<Row> & Pick<Row, 'name' | 'args'>>)('$name preserves explicit values/default forwarding for $args', async (edge) => {
        const row: Row = { ...rows.find((r) => r.name === edge.name)!, ...edge };
        const deps = protocolContractDeps(dir), operation = vi.fn(async (..._args: unknown[]) => row.result);
        Object.assign(deps.agentOps, { [row.name]: operation });
        const source = serve(deps), client = await source.connect();
        const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => row.result);
        expect(await call(client.bridge.agents, row)).toEqual(await call(oldAgents(invoke), row));
        const forwarded = row.wireArgs ?? row.args;
        expect(invoke).toHaveBeenCalledExactlyOnceWith(row.channel, ...forwarded);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(`agents.${row.name}`, forwarded, expect.anything());
        expect(operation).toHaveBeenCalledExactlyOnceWith(...forwarded);
    });
    it.each([
        { name: 'restart', args: [null, 'graceful'], reason: 'a restart names an agent and a kind: graceful or fresh' },
        { name: 'restart', args: ['agent_a', null], reason: 'a restart names an agent and a kind: graceful or fresh' },
        { name: 'previewDelete', args: [null, 'delete', []], reason: 'a delete names an agent and an outcome: unmount or delete' },
        { name: 'previewDelete', args: ['agent_a', 'other', []], reason: 'a delete names an agent and an outcome: unmount or delete' },
        { name: 'delete', args: [null, 'delete', [], false], reason: 'a delete names an agent and an outcome: unmount or delete' },
        { name: 'delete', args: ['agent_a', null, [], false], reason: 'a delete names an agent and an outcome: unmount or delete' },
        { name: 'switchDriver', args: [null, 'codex'], reason: 'a switch names an agent and a provider' },
        { name: 'switchDriver', args: ['agent_a', null], reason: 'a switch names an agent and a provider' },
        { name: 'setMode', args: [null, 'manual'], reason: 'mode is automated or manual' },
        { name: 'setMode', args: ['agent_a', 'other'], reason: 'mode is automated or manual' },
        { name: 'setPermissions', args: [null, 'ask'], reason: 'permissions are all, ask or edits' },
        { name: 'setPermissions', args: ['agent_a', null], reason: 'permissions are all, ask or edits' },
        { name: 'models', args: [null, false], reason: 'unknown agent' },
        { name: 'setModel', args: [null, 'fixture-model'], reason: 'a model is a name, or null for the provider default' },
        { name: 'setModel', args: ['agent_a', 17], reason: 'a model is a name, or null for the provider default' },
        { name: 'setAutoApprove', args: [null, true], reason: 'autonomy is on or off' },
        { name: 'setAutoApprove', args: ['agent_a', 'yes'], reason: 'autonomy is on or off' },
        { name: 'setManageTabs', args: [null, true], reason: 'managing tabs is on or off' },
        { name: 'setManageTabs', args: ['agent_a', null], reason: 'managing tabs is on or off' },
        { name: 'setDrivePages', args: [null, true], reason: 'driving pages is on or off' },
        { name: 'setDrivePages', args: ['agent_a', 0], reason: 'driving pages is on or off' },
        { name: 'setIssueWatch', args: [null, {}], reason: 'unknown agent' },
        { name: 'setAccessScope', args: [null, 'self'], reason: 'scope is none, self or all' },
        { name: 'setAccessScope', args: ['agent_a', null], reason: 'scope is none, self or all' },
        { name: 'setBudget', args: [null, 10], reason: 'a budget is a non-negative number of dollars, or null to clear it' },
        { name: 'setBudget', args: ['agent_a', '10'], reason: 'a budget is a non-negative number of dollars, or null to clear it' },
        { name: 'setBudget', args: ['agent_a', -1], reason: 'a budget is a non-negative number of dollars, or null to clear it' },
        { name: 'diagnose', args: [null], reason: 'diagnose names an agent' },
    ] satisfies Array<{ name: AgentKey; args: unknown[]; reason: string }>)('$name preserves its old native early refusal for $args without calling the operation', async (invalid) => {
        const deps = protocolContractDeps(dir), operation = vi.fn(async () => ({ ok: true, called: true }));
        Object.assign(deps.agentOps, { [invalid.name]: operation });
        const source = serve(deps), client = await source.connect();
        expect(await call(client.bridge.agents, invalid)).toEqual({ ok: false, reason: invalid.reason });
        expect(operation).not.toHaveBeenCalled();
    });
    describe.each([false, true])('non-JSON input on a remote=%s client', (remote) => {
        it.each([
            { name: 'setModel', args: ['agent_a', undefined], reason: 'a model is a name, or null for the provider default' },
            { name: 'setBudget', args: ['agent_a', undefined], reason: 'a budget is a finite non-negative number of dollars, or null to clear it' },
            { name: 'setBudget', args: ['agent_a', NaN], reason: 'a budget is a finite non-negative number of dollars, or null to clear it' },
            { name: 'setBudget', args: ['agent_a', Infinity], reason: 'a budget is a finite non-negative number of dollars, or null to clear it' },
            { name: 'setBudget', args: ['agent_a', -Infinity], reason: 'a budget is a finite non-negative number of dollars, or null to clear it' },
        ] satisfies Array<{ name: AgentKey; args: unknown[]; reason: string }>)('$name refuses $args before serializing it into a valid clear', async (invalid) => {
            const deps = protocolContractDeps(dir), operation = vi.fn(async () => ({ ok: true, called: true }));
            Object.assign(deps.agentOps, { [invalid.name]: operation });
            const source = serve(deps), client = await source.connect(remote); source.invoke.mockClear();
            expect(await call(client.bridge.agents, invalid)).toEqual({ ok: false, reason: invalid.reason });
            expect(source.invoke).not.toHaveBeenCalled(); expect(operation).not.toHaveBeenCalled();
        });
    });
    it.each(['setModel', 'setBudget'] satisfies AgentKey[])('a remote caller can still send null to %s as an explicit clear', async (name) => {
        const result = { ok: true, record }, deps = protocolContractDeps(dir), operation = vi.fn(async () => result);
        Object.assign(deps.agentOps, { [name]: operation });
        const source = serve(deps), client = await source.connect(true); source.invoke.mockClear();
        expect(await call(client.bridge.agents, { name, args: ['agent_a', null] })).toEqual(result);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(`agents.${name}`, ['agent_a', null], expect.anything());
        expect(operation).toHaveBeenCalledExactlyOnceWith('agent_a', null);
    });
    // The retired mutations all touched the registry on completion, including refusal/throw.
    // Check the composition root retains that hook on the existing protocol adapters.
    it.each(['restart', 'delete', 'switchDriver', 'setBudget', 'setMode', 'setAccessScope', 'setAutoApprove', 'setManageTabs', 'setDrivePages', 'setIssueWatch', 'setPermissions', 'setModel'])('%s retains the native completion refresh in the shared adapter', (method) => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        const adapters = main.slice(main.indexOf('            agentOps: {'), main.indexOf('            features: {', main.indexOf('            agentOps: {')));
        const line = adapters.split('\n').find((line) => line.trimStart().startsWith(`${method}:`));
        expect(line !== undefined).toBe(true);
        expect(line?.includes('.finally(() => registry?.touch())')).toBe(true);
    });
});
