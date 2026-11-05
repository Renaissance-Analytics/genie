import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { capabilityOf, inMemoryPair, REMOTE_METHODS, type ControlMethod, type RemoteMethod, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { buildHostApi } from '../src/main/host-api.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

const ROOT = '<test-root>';
const HOST_ONLY_BACKSTOPS: Partial<Record<RemoteMethod, string>> = {
    addWorkspace: 'addWorkspace opens a folder picker on the host; do it there',
    takeOver: 'takeOver opens a window on the host; do it there',
    providerLogin: 'providerLogin opens the provider login in a window on the host; do it there',
    'features.setBrowserBounds': "features.setBrowserBounds places a view on the host's own window; nothing to do remotely",
};
const hostOnlyMethods = REMOTE_METHODS.filter((method) => capabilityOf(method) === 'host-only');
/** Explicit rows: adding a protocol method without its contract must fail, rather than silently testing nothing. */
const ROWS: Partial<Record<RemoteMethod, readonly unknown[]>> = {
    snapshot: [], agentDetail: ['missing'], openAgent: ['agent_a'], stopAgent: ['agent_a'],
    cancelTurn: ['agent_a'], resumeLimit: ['agent_a'], providerLogin: ['agent_a'],
    prompt: ['agent_a', 'hello'], resolvePrompt: ['agent_a', 'draft_1', 'send'],
    addAgent: ['work', { name: 'new', purpose: 'contract', provider: 'claude' }],
    answerApproval: ['agent_a', 'allow', 'note'], restartWithHandoff: ['agent_a', 'missing'],
    'agents.restart': ['agent_a', 'graceful'], 'agents.previewDelete': ['agent_a', 'unmount', []],
    'agents.delete': ['agent_a', 'unmount', [], false], 'agents.switchDriver': ['agent_a', 'codex'],
    'agents.setBudget': ['agent_a', null], 'agents.setMode': ['agent_a', 'manual'],
    'agents.setAccessScope': ['agent_a', 'self'], 'agents.setAutoApprove': ['agent_a', false],
    'agents.setManageTabs': ['agent_a', false], 'agents.setDrivePages': ['agent_a', false],
    activity: ['work'], 'agents.setIssueWatch': ['agent_a', null], 'agents.setPermissions': ['agent_a', 'ask'],
    'agents.setModel': ['agent_a', null], 'agents.models': ['agent_a', false], 'agents.diagnose': ['agent_a'],
    'workspaces.previewAdd': [ROOT], 'workspaces.confirmAdd': [ROOT],
    'workspaces.create': ['new', ROOT, null, ''], 'workspaces.previewAddFromGit': ['https://example.test/repo.git', ROOT],
    'workspaces.confirmAddFromGit': ['https://example.test/repo.git', ROOT], 'workspaces.readSource': [ROOT],
    'workspaces.stageFromGit': ['https://example.test/repo.git'], 'workspaces.registerExisting': [ROOT],
    'workspaces.buildEnvelope': [{ path: ROOT }, null], 'workspaces.discardStaged': [ROOT],
    'workspaces.githubRepos': [], 'workspaces.tynnProjects': [], 'workspaces.tynnOwnerOptions': [],
    'workspaces.createTynnProject': [{ name: 'contract' }], 'workspaces.importedAgents': ['work'],
    'workspaces.adoptAgent': ['work', 'atlas'], 'workspaces.previewAddFromTynn': ['project_1', ROOT],
    'workspaces.confirmAddFromTynn': [ROOT, 'project_1'], 'workspaces.hibernate': ['work'],
    'workspaces.wake': ['work'], 'workspaces.remove': ['work'], 'workspaces.listRepos': ['work'],
    'workspaces.tynnBoard': ['work', 'all'], 'workspaces.tynnBoardAction': ['work', { kind: 'refresh' }],
    'workspaces.addRepo': ['work', { name: 'repo', path: 'repos/repo' }], 'workspaces.removeRepo': ['work', 'repo'],
    'workspaces.removeRepoLock': ['work', 'repo'], 'workspaces.locateRepo': ['work', 'repo', ROOT],
    'workspaces.commitsSince': ['work', 0], 'workspaces.settings': ['work'],
    'workspaces.setSetting': ['work', 'theme', 'dark'], 'workspaces.resetSetting': ['work', 'theme'],
    'workspaces.setGoverns': ['work', []], 'workspaces.setDefaultAgent': ['work', null],
    'workspaces.setColor': ['work', 'blue'], addWorkspace: [], takeOver: ['agent_a'],
    'terminals.open': ['work', { cols: 80, rows: 24 }], 'terminals.write': ['term_1', 'hello'],
    'terminals.resize': ['term_1', 80, 24], 'terminals.close': ['term_1'],
    'terminals.attach': ['work', 'missing'], 'terminals.list': ['work'],
    'features.snapshot': [], 'features.act': [{ kind: 'contract' }], 'features.setBrowserBounds': [null],
    'updates.state': [], 'host.listDir': [ROOT], 'host.mkdir': [ROOT, 'invalid/name'],
    'updates.check': [], 'updates.download': [], 'updates.install': [], 'updates.notes': [],
    headroom: [], accountRetry: ['agent_a'],
    'inbox.sendFile': ['agent_a', 'hello', 'sample.txt', 'b2s='],
    'files.children': ['work', ''], 'files.open': ['work', 'missing.txt'],
    'files.readMedia': ['work', 'missing.png'], 'files.upload': ['work', '', null],
};

type Result = { ok: true; value: unknown } | { ok: false; reason: string };
type ResultFrame = Extract<WireMessage, { kind: 'result' }>;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function directResult(invoke: () => Promise<unknown>): Promise<Result> {
    try { return { ok: true, value: await invoke() }; }
    catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}

describe('P4 every-method contract: direct HostApi versus the received protocol result', () => {
    let dir: string;
    let devices: DeviceStore;
    let remote: ReturnType<typeof connectRemote>;
    let local: ReturnType<typeof connectRemote>;
    let api: ReturnType<typeof buildHostApi>;
    let wireInvocations: RemoteMethod[];
    let rpc: (method: RemoteMethod | ControlMethod, args: unknown[]) => Promise<Result>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-p4-contract-'));
        devices = await DeviceStore.open(dir, { now: () => 1, random: () => 'contract-token' });
        api = buildHostApi(protocolContractDeps(dir));
        wireInvocations = [];
        let accept: (connection: ServerConnection) => void = () => {};
        const host = new RemoteHost({
            api: { ...api, invoke: (method, args) => { wireInvocations.push(method); return api.invoke(method, args); } },
            devices, hostName: 'contract-host', baton: new Baton(),
            pins: new PairingPins({ now: () => 1, random: () => 0.482913 }), confirm: allowEveryPairing,
            transport: { onConnection: (listener) => { accept = listener; return () => {}; } },
        });
        const pair = inMemoryPair(), localPair = inMemoryPair();
        let nextId = 10_000;
        const pending = new Map<number, (frame: ResultFrame) => void>();
        for (const transport of [pair.client, localPair.client]) transport.onMessage((text) => {
            const frame = JSON.parse(text) as WireMessage;
            if (frame.kind === 'result') pending.get(frame.id)?.(frame);
        });
        rpc = (method, args) => new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`no result for ${method}`)); }, 2000);
            pending.set(id, (frame) => {
                clearTimeout(timer); pending.delete(id);
                resolve(frame.ok ? { ok: true, value: frame.value } : { ok: false, reason: frame.reason });
            });
            const transport = capabilityOf(method as RemoteMethod) === 'local' ? localPair.client : pair.client;
            transport.send(JSON.stringify({ kind: 'call', id, method, args }));
        });
        accept(pair.server);
        remote = connectRemote(pair.client, { kind: 'pin', code: host.issuePin().code }, 'contract-window');
        expect(await remote.ready).toEqual({ ok: true });
        expect(await remote.takeBaton()).toEqual({ ok: true });
        accept({ ...localPair.server, preAuth: { kind: 'local', label: 'contract local', isOwner: true, workspaceId: null, readonly: false } });
        local = connectRemote(localPair.client, { kind: 'local' }, 'contract-local');
        expect(await local.ready).toEqual({ ok: true });
        await devices.flushed();
    });

    afterEach(async () => {
        remote?.close();
        local?.close();
        await tick();
        await devices?.flushed();
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    it('has an explicit row for exactly every method in the protocol table', () => {
        expect(Object.keys(ROWS).sort()).toEqual([...REMOTE_METHODS].sort());
        expect(Object.keys(HOST_ONLY_BACKSTOPS).sort()).toEqual([...hostOnlyMethods].sort());
    });

    it.each(REMOTE_METHODS)('%s keeps the direct value, null, or refusal across the wire', async (method) => {
        const row = ROWS[method];
        expect(row, `missing contract row for ${method}`).toBeDefined();
        const args = row!.map((arg) => arg === ROOT ? dir : arg);
        const wireArgs = [...args];
        if (capabilityOf(method) === 'host-only') {
            const result = await rpc(method, wireArgs);
            expect(result.ok).toBe(false);
            if (result.ok) throw new Error(`host-only call ${method} was answered`);
            expect(result.reason).toContain('contract-host');
            expect(wireInvocations).not.toContain(method);
            return;
        }
        if (method === 'files.upload') {
            const begun = await rpc('upload.begin', [{ name: 'sample.txt', size: 2 }]);
            expect(begun.ok).toBe(true);
            if (!begun.ok) throw new Error(begun.reason);
            const id = (begun.value as { id: string }).id;
            expect((await rpc('upload.chunk', [id, 0, 'b2s='])).ok).toBe(true);
            args[2] = { name: 'sample.txt', bytes: Uint8Array.of(111, 107) };
            wireArgs[2] = { staged: id };
        }
        const expected = await directResult(() => api.invoke(method, args));
        expect(await rpc(method, wireArgs)).toEqual(expected);
    });

    it.each(hostOnlyMethods)('%s keeps its direct API backstop, separate from connection policy', async (method) => {
        const args = ROWS[method]!.map((arg) => arg === ROOT ? dir : arg);
        expect(await directResult(() => api.invoke(method, args))).toEqual({ ok: false, reason: HOST_ONLY_BACKSTOPS[method] });
    });

    it('CONTROL: explicit null and an API refusal stay different', async () => {
        expect(await rpc('agentDetail', ['missing'])).toEqual({ ok: true, value: null });
        expect(await rpc('answerApproval', ['agent_a', 'allow', 'note'])).toEqual({ ok: true, value: { ok: false, reason: 'the approval is no longer waiting' } });
    });
});

const VOID_CALLS: Record<string, (bridge: ReturnType<typeof connectRemote>['bridge']) => void> = {
    openAgent: (b) => b.openAgent('agent_a'), stopAgent: (b) => b.stopAgent('agent_a'), addWorkspace: (b) => b.addWorkspace(),
    'terminals.write': (b) => b.terminals.write('term_1', 'hello'),
    'terminals.resize': (b) => b.terminals.resize('term_1', 80, 24), 'terminals.close': (b) => b.terminals.close('term_1'),
};

/** These extra rows isolate client result handling; the full table above runs through the real host. */
describe.each(Object.entries(VOID_CALLS))('P4 void client result: %s', (method, invoke) => {
    it.each([true, false])('keeps the void return and says a refused result (ok=%s)', async (ok) => {
        const pair = inMemoryPair();
        const methods: string[] = [];
        pair.server.onMessage((text) => {
            const frame = JSON.parse(text) as WireMessage;
            if (frame.kind === 'hello') pair.server.send(JSON.stringify({ kind: 'welcome', connectionId: 'contract-client', host: 'contract-host', isOwner: true, workspaceId: null }));
            if (frame.kind === 'call') {
                methods.push(frame.method);
                pair.server.send(JSON.stringify(ok
                    ? { kind: 'result', id: frame.id, ok: true, value: { ok: true } }
                    : { kind: 'result', id: frame.id, ok: false, reason: 'the host refused this call' }));
            }
        });
        const remote = connectRemote(pair.client, { kind: 'pin', code: '000000' }, 'contract-window');
        try {
            expect(await remote.ready).toEqual({ ok: true });
            expect(invoke(remote.bridge)).toBeUndefined();
            await tick();
            expect(methods).toEqual([method]);
            expect(remote.state().lastRefusal).toBe(ok ? null : 'the host refused this call');
        } finally { remote.close(); }
    });
});
