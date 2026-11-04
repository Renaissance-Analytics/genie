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
import { pageBridge, type GenieBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

// Frozen forwarding from the preload at b7512ebf. Keep it after retiring the native lines.
function oldWizard(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
    return {
        previewAdd: (path: string) => invoke('genie:workspace-preview-add', path),
        confirmAdd: (path: string) => invoke('genie:workspace-confirm-add', path),
        create: (name: string, parent: string, remote?: unknown, project?: string) => invoke('genie:workspace-create', name, parent, remote, project ?? ''),
        previewAddFromGit: (url: string, parent: string) => invoke('genie:workspace-preview-add-git', url, parent),
        confirmAddFromGit: (url: string, parent: string) => invoke('genie:workspace-confirm-add-git', url, parent),
        readSource: (path: string) => invoke('genie:workspace-read-source', path),
        stageFromGit: (url: string) => invoke('genie:workspace-stage-git', url),
        registerExisting: (path: string) => invoke('genie:workspace-register-existing', path),
        buildEnvelope: (plan: unknown, remote?: unknown) => invoke('genie:workspace-build-envelope', plan, remote),
        discardStaged: (path: string) => invoke('genie:workspace-discard-staged', path),
        githubRepos: () => invoke('genie:workspace-github-repos'),
        tynnProjects: () => invoke('genie:workspace-tynn-projects'),
        tynnOwnerOptions: () => invoke('genie:workspace-tynn-owner-options'),
        createTynnProject: (input: unknown) => invoke('genie:workspace-create-tynn-project', input),
        importedAgents: (id: string) => invoke('genie:workspace-imported-agents', id),
        adoptAgent: (id: string, name: string) => invoke('genie:workspace-adopt-agent', id, name),
        previewAddFromTynn: (project: string, parent: string) => invoke('genie:workspace-preview-add-tynn', project, parent),
        confirmAddFromTynn: (parent: string, project: string) => invoke('genie:workspace-confirm-add-tynn', parent, project),
    };
}
type WizardKey = keyof ReturnType<typeof oldWizard>;
type Row = { name: WizardKey; channel: string; args: unknown[]; result: unknown };
const plan = { name: 'Sample', parent: '/estate', source: '/source', staged: false, repos: [{ name: 'app', url: 'https://example.test/team/app.git', local: false }], knowledge: [], primary: null };
const project = { id: 'project-1', name: 'Sample', slug: 'sample', vision: null, isWorkspace: true, repositories: [], envelope: null };
const rows: Row[] = [
    { name: 'previewAdd', channel: 'genie:workspace-preview-add', args: ['/source'], result: { ok: true, path: '/source', kind: 'full-envelope', steps: [] } },
    { name: 'confirmAdd', channel: 'genie:workspace-confirm-add', args: ['/source'], result: { ok: true, id: 'sample', kind: 'full-envelope', stamped: null } },
    { name: 'create', channel: 'genie:workspace-create', args: ['Sample', '/estate', { kind: 'none' }, 'project-1'], result: { ok: true, id: 'sample', path: '/estate/sample.agi' } },
    { name: 'previewAddFromGit', channel: 'genie:workspace-preview-add-git', args: ['https://example.test/team/app.git', '/estate'], result: { ok: true, source: 'git', url: 'https://example.test/team/app.git', parent: '/estate', path: '/estate/app', kind: 'simple-repo', steps: [] } },
    { name: 'confirmAddFromGit', channel: 'genie:workspace-confirm-add-git', args: ['https://example.test/team/app.git', '/estate'], result: { ok: true, id: 'sample', kind: 'simple-repo', stamped: null } },
    { name: 'readSource', channel: 'genie:workspace-read-source', args: ['/source'], result: { ok: true, existing: true, path: '/source' } },
    { name: 'stageFromGit', channel: 'genie:workspace-stage-git', args: ['https://example.test/team/app.git'], result: { ok: true, existing: true, path: '/stage/import', staged: true, url: 'https://example.test/team/app.git' } },
    { name: 'registerExisting', channel: 'genie:workspace-register-existing', args: ['/source'], result: { ok: true, id: 'sample' } },
    { name: 'buildEnvelope', channel: 'genie:workspace-build-envelope', args: [plan, { kind: 'none' }], result: { ok: true, id: 'sample', path: '/estate/sample.agi' } },
    { name: 'discardStaged', channel: 'genie:workspace-discard-staged', args: ['/stage/import'], result: { ok: true } },
    { name: 'githubRepos', channel: 'genie:workspace-github-repos', args: [], result: { status: 'listed', repos: [], truncated: false } },
    { name: 'tynnProjects', channel: 'genie:workspace-tynn-projects', args: [], result: { ok: true, host: 'tynn.ai', projects: [project], added: {} } },
    { name: 'tynnOwnerOptions', channel: 'genie:workspace-tynn-owner-options', args: [], result: { ok: true, owners: [{ kind: 'user', id: 'owner-1', label: 'Fixture' }] } },
    { name: 'createTynnProject', channel: 'genie:workspace-create-tynn-project', args: [{ name: 'Sample', slug: 'sample', owner: null }], result: { ok: true, project } },
    { name: 'importedAgents', channel: 'genie:workspace-imported-agents', args: ['sample'], result: { ok: true, agents: [] } },
    { name: 'adoptAgent', channel: 'genie:workspace-adopt-agent', args: ['sample', 'helper'], result: { ok: true, id: 'agent-1', name: 'helper' } },
    { name: 'previewAddFromTynn', channel: 'genie:workspace-preview-add-tynn', args: ['project-1', '/estate'], result: { ok: true, source: 'tynn', project, host: 'tynn.ai', parent: '/estate', path: '/estate/sample.agi', kind: 'missing', steps: [] } },
    { name: 'confirmAddFromTynn', channel: 'genie:workspace-confirm-add-tynn', args: ['/estate', 'project-1'], result: { ok: true, id: 'sample', kind: 'full-envelope', stamped: null } },
];
const call = (ws: object, row: Row) => Reflect.apply((ws as Record<WizardKey, (...args: unknown[]) => Promise<unknown>>)[row.name], ws, row.args);
let dir: string;
let devices: DeviceStore;
const close: Array<() => void> = [];
const clients: RemoteClient[] = [];
function serve(deps: HostApiDeps) {
    const api = buildHostApi(deps), invoke = vi.spyOn(api, 'invoke');
    let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api, hostName: 'wizard-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (listener) => { accept = listener; return () => {}; } } });
    const pair = inMemoryPair();
    close.push(() => pair.client.close());
    const framePort = (): LocalFramePort => {
        const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>();
        let handle = '';
        pair.client.onMessage((text) => { for (const listener of listeners) listener('frame', handle, text); });
        pair.client.onClose(() => { for (const listener of listeners) listener('closed', handle, ''); });
        return { onFrame: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, send: (action, id, text) => {
            if (action === 'open') { handle = id; accept({ ...pair.server, preAuth: { kind: 'local', label: 'wizard-page', isOwner: true, workspaceId: null, readonly: false } }); }
            else if (action === 'frame') pair.client.send(text);
            else pair.client.close();
        } };
    };
    return { invoke, framePort, connect: async () => {
        accept({ ...pair.server, preAuth: { kind: 'local', label: 'wizard-window', isOwner: true, workspaceId: null, readonly: false } });
        const client = connectRemote(pair.client, { kind: 'local' }, 'wizard-window'); clients.push(client);
        expect(await client.ready).toEqual({ ok: true }); return client;
    } };
}
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-p4-wizard-'));
    let seq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `wizard-fixture-${++seq}` });
});
afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const stop of close.splice(0)) stop();
    vi.unstubAllGlobals(); await new Promise<void>((resolve) => setImmediate(resolve));
    await devices.flushed(); await rm(dir, { recursive: true, force: true });
});

describe('all eighteen add-workspace wizard calls use the one protocol', () => {
    it.each(rows)('$name preserves the old result and recorded API/dependency arguments', async (row) => {
        const deps = protocolContractDeps(dir), operation = vi.fn(async (..._args: unknown[]) => row.result);
        Object.assign(deps.workspaceOps, { [row.name]: operation });
        const source = serve(deps), client = await source.connect();
        const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => row.result);
        expect(await call(client.bridge.workspaces, row)).toEqual(await call(oldWizard(invoke), row));
        expect(invoke).toHaveBeenCalledExactlyOnceWith(row.channel, ...row.args);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(`workspaces.${row.name}`, row.args);
        expect(operation).toHaveBeenCalledExactlyOnceWith(...row.args);
    });
    it.each(rows)('pageBridge routes $name through the real local client without calling the old preload', async (row) => {
        const deps = protocolContractDeps(dir), operation = vi.fn(async (..._args: unknown[]) => row.result);
        Object.assign(deps.workspaceOps, { [row.name]: operation });
        const source = serve(deps); vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const oldInvoke = vi.fn(async (_channel: string, ..._args: unknown[]) => row.result);
        const snapshot = vi.fn(async () => ({ workspaces: null }));
        const hibernate = vi.fn(async () => ({ ok: false, reason: 'agent still working' }));
        const preload = { snapshot, subscribeAgentWire: () => () => {}, workspaces: { ...oldWizard(oldInvoke), hibernate } } as unknown as PreloadBridge;
        const bridge = pageBridge(preload);
        expect(pageBridge(preload)).toBe(bridge);
        expect(await call(bridge.workspaces, row)).toEqual(row.result);
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(`workspaces.${row.name}`, row.args);
        expect(operation).toHaveBeenCalledExactlyOnceWith(...row.args);
        expect(oldInvoke).not.toHaveBeenCalled();
        expect(await bridge.snapshot()).toEqual({ workspaces: null });
        expect(await bridge.workspaces.hibernate('sample')).toEqual({ ok: false, reason: 'agent still working' });
        expect(snapshot).toHaveBeenCalledTimes(1); expect(hibernate).toHaveBeenCalledExactlyOnceWith('sample');
    });
    it.each(rows)('$name retires its matching native handler, preload forwarding and inventory row', (row) => {
        const main = readFileSync('src/main/main.ts', 'utf8'), preload = readFileSync('src/main/preload.ts', 'utf8'), inventory = readFileSync('src/core/ipc-inventory.ts', 'utf8');
        expect(main).toContain("ipcMain.handle('genie:workspace-hibernate'");
        expect(preload).toContain("ipcRenderer.invoke('genie:workspace-hibernate'");
        expect(inventory).toContain("['genie:workspace-hibernate', 'protocol:workspaces.hibernate']");
        expect(main).not.toContain(`ipcMain.handle('${row.channel}'`);
        expect(preload).not.toContain(`ipcRenderer.invoke('${row.channel}'`);
        expect(inventory).not.toContain(`['${row.channel}',`);
    });
    it.each(rows)('$name preserves a null API result', async (row) => {
        const deps = protocolContractDeps(dir); Object.assign(deps.workspaceOps, { [row.name]: vi.fn(async () => null) });
        const source = serve(deps), client = await source.connect();
        expect(await call(client.bridge.workspaces, row)).toBeNull();
        expect(source.invoke).toHaveBeenCalledExactlyOnceWith(`workspaces.${row.name}`, row.args);
    });
    it('the page shows a domain refusal from the wizard unchanged', async () => {
        const deps = protocolContractDeps(dir), refusal = { ok: false, reason: 'the source already is a workspace' };
        deps.workspaceOps.registerExisting = vi.fn(async () => refusal);
        const source = serve(deps); vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const bridge = pageBridge({ subscribeAgentWire: () => () => {}, workspaces: oldWizard(vi.fn(async () => ({ ok: true }))) } as unknown as PreloadBridge);
        expect(await bridge.workspaces.registerExisting!('/source')).toEqual(refusal);
    });
    it('the GitHub repository picker keeps its failed/message shape on a protocol refusal', async () => {
        const deps = protocolContractDeps(dir); deps.workspaceOps.githubRepos = async () => { throw new Error('repository listing unavailable'); };
        const source = serve(deps); vi.stubGlobal('window', { genieLocalProtocol: source.framePort() });
        const bridge = pageBridge({ subscribeAgentWire: () => () => {}, workspaces: oldWizard(vi.fn(async () => ({ status: 'listed', repos: [], truncated: false }))) } as unknown as PreloadBridge);
        expect(await bridge.workspaces.githubRepos!()).toEqual({ status: 'failed', message: 'repository listing unavailable' });
    });
    it('a disconnected local wizard says why, including the repository picker shape', async () => {
        vi.stubGlobal('window', {});
        const oldInvoke = vi.fn(async () => ({ ok: true }));
        const bridge = pageBridge({ subscribeAgentWire: () => () => {}, workspaces: oldWizard(oldInvoke) } as unknown as PreloadBridge);
        expect(await bridge.workspaces.readSource!('/source')).toEqual({ ok: false, reason: 'This Genie window has no local protocol connection.' });
        expect(await bridge.workspaces.githubRepos!()).toEqual({ status: 'failed', message: 'This Genie window has no local protocol connection.' });
        expect(oldInvoke).not.toHaveBeenCalled();
    });
    // These early returns are frozen from the native handlers at b7512ebf. No operation
    // was called there: migration must not turn malformed/null input into a disk action.
    it.each([
        { name: 'previewAdd', args: [''], result: { ok: false, reason: 'no folder picked' } },
        { name: 'previewAdd', args: [null], result: { ok: false, reason: 'no folder picked' } },
        { name: 'confirmAdd', args: [null], result: { ok: false, reason: 'confirmAdd names a folder' } },
        { name: 'create', args: [null, '/estate', { kind: 'none' }, 'project-1'], result: { ok: false, reason: 'give the workspace a name and a folder' } },
        { name: 'previewAddFromGit', args: ['https://example.test/app.git', ''], result: { ok: false, reason: 'give a git URL and a parent folder' } },
        { name: 'confirmAddFromGit', args: [null, '/estate'], result: { ok: false, reason: 'give a git URL and a parent folder' } },
        { name: 'readSource', args: [''], result: { ok: false, reason: 'no folder picked' } },
        { name: 'readSource', args: [null], result: { ok: false, reason: 'no folder picked' } },
        { name: 'stageFromGit', args: ['   '], result: { ok: false, reason: 'give a git URL' } },
        { name: 'registerExisting', args: [''], result: { ok: false, reason: 'no folder picked' } },
        { name: 'discardStaged', args: [null], result: { ok: true } },
        { name: 'importedAgents', args: [null], result: { ok: false, reason: 'name a workspace' } },
        { name: 'adoptAgent', args: ['sample', ''], result: { ok: false, reason: 'name a workspace and an agent' } },
        { name: 'previewAddFromTynn', args: ['', '/estate'], result: { ok: false, reason: 'choose a Tynn project and a parent folder' } },
        { name: 'confirmAddFromTynn', args: [null, 'project-1'], result: { ok: false, reason: 'give a parent folder and a Tynn project' } },
    ] satisfies Array<{ name: WizardKey; args: unknown[]; result: unknown }>)('$name preserves the old native guard for $args', async (invalid) => {
        const deps = protocolContractDeps(dir), operation = vi.fn(async () => ({ ok: true, called: true }));
        Object.assign(deps.workspaceOps, { [invalid.name]: operation });
        const source = serve(deps), client = await source.connect();
        const row = { ...rows.find((r) => r.name === invalid.name)!, args: invalid.args };
        expect(await call(client.bridge.workspaces, row)).toEqual(invalid.result);
        expect(operation).not.toHaveBeenCalled();
    });
});
