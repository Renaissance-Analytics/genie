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
import { LocalStagingArea } from '../src/main/local-staging-area.js';
import type { LocalUploads } from '../src/main/local-uploads.js';
import { MARKETPLACE_METHODS } from '../src/core/marketplace.js';
import { GAPP_METHODS } from '../src/core/gapps.js';

const ROOT = '<test-root>';
const HOST_ONLY_BACKSTOPS: Partial<Record<RemoteMethod, string>> = {
    addWorkspace: 'addWorkspace opens a folder picker on the host; do it there',
    providerLogin: 'providerLogin opens the provider login in a window on the host; do it there',
    'features.setBrowserBounds': "features.setBrowserBounds places a view on the host's own window; nothing to do remotely",
};
const hostOnlyMethods = REMOTE_METHODS.filter((method) => capabilityOf(method) === 'host-only');
/** Connection-owned reviews cannot go through bare HostApi.invoke. This fixture has no Marketplace service. */
/** The GApp book's actions are a local window's too, and this fixture has no book. */
const GAPP_CONNECTION_REFUSALS: Partial<Record<RemoteMethod, string>> = Object.fromEntries(GAPP_METHODS.map((method) => [method, 'GApps are not available on this host.']));
const MARKETPLACE_CONNECTION_REFUSALS: Partial<Record<RemoteMethod, string>> = {
    'marketplace.search': 'Marketplace is not available on this host.',
    'marketplace.prepare': 'Marketplace is not available on this host.',
    'marketplace.install': 'This Marketplace review does not belong to this window.',
    'marketplace.discard': 'This Marketplace review does not belong to this window.',
};
/** Explicit rows: adding a protocol method without its contract must fail, rather than silently testing nothing. */
const ROWS: Partial<Record<RemoteMethod, readonly unknown[]>> = {
    // Positive native and connection-control contracts live in the 8B suites. This fixture checks missing-service refusals.
    'terminals.localOpen': ['work', { cols: 80, rows: 24 }], 'terminals.localWrite': ['quiet', 'x'],
    'terminals.localResize': ['quiet', 80, 24], 'terminals.localClose': ['quiet'], 'terminals.localList': ['work'], 'terminals.localAttach': [null, 'quiet'],
    'terminals.localBegin': [{ kind: 'write', id: 'quiet' }], 'terminals.localChunk': ['ticket', 'x'], 'terminals.localFinish': ['ticket'],
    'terminals.localWatch': ['view', null, 'quiet'], 'terminals.localReady': ['view'], 'terminals.localAck': ['view', 1], 'terminals.localUnwatch': ['view'],
    snapshot: [], agentDetail: ['missing'], openAgent: ['agent_a'], stopAgent: ['agent_a'],
    cancelTurn: ['agent_a'], resumeLimit: ['agent_a'], providerLogin: ['agent_a'],
    prompt: ['agent_a', 'hello'], resolvePrompt: ['agent_a', 'draft_1', 'send'],
    addAgent: ['work', { name: 'new', purpose: 'contract', provider: 'claude' }],
    answerApproval: ['agent_a', 'allow', 'note'], restartWithHandoff: ['agent_a', 'missing'],
    'agents.restart': ['agent_a', 'graceful'], 'agents.previewDelete': ['agent_a', 'unmount', []],
    'agents.delete': ['agent_a', 'unmount', [], false], 'agents.switchDriver': ['agent_a', 'codex'],
    'agents.setBudget': ['agent_a', null], 'agents.setMode': ['agent_a', 'manual'],
    'agents.setAccessScope': ['agent_a', 'self'], 'agents.setAccessAgents': ['agent_a', null], 'agents.setAutoApprove': ['agent_a', false],
    'agents.setManageTabs': ['agent_a', false], 'agents.setDrivePages': ['agent_a', false], 'agents.setMcpServer': ['agent_a', 'slack', false],
    activity: ['work'], 'agents.setIssueWatch': ['agent_a', null], 'agents.setPermissions': ['agent_a', 'ask'],
    'agents.setModel': ['agent_a', null], 'agents.models': ['agent_a', false], 'agents.diagnose': ['agent_a'], 'agents.toolOutput': ['agent_a', 'call_1'],
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
    'workspaces.tynnBoardChanges': ['work', {}, 'c1', []], 'workspaces.tynnIssueChanges': ['work', {}, 'c1', []],
    'workspaces.tynnPage': ['work', 'wip', { view: 'attention' }],
    'workspaces.tynnIssues': ['work', { status: 'open' }],
    'workspaces.tynnIssueAction': ['work', { action: 'issue.resolve', issueId: 'i1', body: { reason: 'Done' } }],
    'workspaces.tynnPageAction': ['work', { action: 'details.update', body: { vision: 'Ship it' } }],
    'workspaces.addRepo': ['work', { name: 'repo', path: 'repos/repo' }], 'workspaces.removeRepo': ['work', 'repo'],
    'workspaces.removeRepoLock': ['work', 'repo'], 'workspaces.locateRepo': ['work', 'repo', ROOT],
    'workspaces.commitsSince': ['work', 0], 'workspaces.settings': ['work'],
    'workspaces.setSetting': ['work', 'theme', 'dark'], 'workspaces.resetSetting': ['work', 'theme'],
    'workspaces.setGoverns': ['work', []], 'workspaces.setDefaultAgent': ['work', null], 'workspaces.setMcpServer': ['work', 'slack', false],
    'workspaces.setColor': ['work', 'blue'], addWorkspace: [], takeOver: ['agent_a'],
    'terminals.open': ['work', { cols: 80, rows: 24 }], 'terminals.write': ['term_1', 'hello'],
    'terminals.resize': ['term_1', 80, 24], 'terminals.close': ['term_1'],
    'terminals.attach': ['work', 'missing'], 'terminals.list': ['work'],
    'features.snapshot': [], 'features.soundData': ['sound_question'], 'features.picked': [['/picked.txt']], 'features.act': [{ kind: 'contract' }], 'features.setBrowserBounds': [null],
    'updates.state': [], 'host.listDir': [ROOT], 'host.mkdir': [ROOT, 'invalid/name'], 'host.home': [],
    'updates.check': [], 'updates.download': [], 'updates.install': [], 'updates.notes': [],
    headroom: [], accountRetry: ['agent_a'],
    'inbox.sendFile': ['agent_a', 'hello', 'sample.txt', 'b2s='],
    'files.children': ['work', ''], 'files.open': ['work', 'missing.txt'],
    'files.readMedia': ['work', 'missing.png'], 'files.upload': ['work', '', null],
    'files.tree': ['work'], 'files.localChildren': ['work', ''], 'files.localOpen': ['work', 'missing.txt'],
    'files.localReadMedia': ['work', 'missing.png'], 'files.lastCommitted': ['work', 'missing.txt'],
    'files.state': ['work'], 'files.gitStatus': ['work'], 'files.create': ['work', 'a', 'file'],
    'files.rename': ['work', 'a', 'b'], 'files.duplicate': ['work', 'a'], 'files.trash': ['work', 'a'],
    'files.readBytes': ['work', 'editor', 'missing.xlsx'], 'files.write': ['work', 'a.txt', 'hello', null],
    'files.writeBytes': ['work', 'editor', 'a.xlsx', 'b2s=', null], 'repo.call': ['status', 'work', ''],
    'chatDrafts.load': [], 'chatDrafts.save': ['agent_a', { v: 1, text: 'kept draft', pills: [], attachments: [] }],
    'chatDrafts.putFile': [Uint8Array.of(111, 107)], 'chatDrafts.readFile': ['00000000-0000-4000-8000-000000000001'],
    'chatDrafts.release': [['00000000-0000-4000-8000-000000000001']],
    'artboard.read': ['work'], 'artboard.review': ['work', 'p1', 'approved', 'review comment'],
    'marketplace.search': [''], 'marketplace.prepare': ['org.example.plugin', '1.0.0'],
    'marketplace.install': ['unknown-review', true], 'marketplace.discard': ['unknown-review'],
    'gapps.list': [], 'gapps.review': ['/nowhere'], 'gapps.install': ['/nowhere', { scope: 'workstation' }], 'gapps.setOn': ['com.example.app', false], 'gapps.uninstall': ['com.example.app'], 'gapps.open': ['com.example.app'], 'gapps.preview': ['com.example.app'], 'gapps.allowPreviewNetwork': ['com.example.app', true],
};

type Result = { ok: true; value: unknown } | { ok: false; reason: string };
// Family5 starts local; the owner-family suite supplies positive business ports for every bridge row.
Object.assign(ROWS, {
    'appInbox.state': ['work'], 'appInbox.createKey': ['work', 'fixture'], 'appInbox.revokeKey': ['work', 'key_fixture'],
    'appInbox.source': ['work', 'allow', 'site', 'site_fixture'],
    'deviceLink.hosts': [], 'deviceLink.forget': ['wss://example.test/genie'], 'deviceLink.adopt': ['wss://example.test/genie', 'synthetic-token'],
    'tynnNetwork.workstations': [], 'tynnNetwork.setRole': ['ws_fixture', 'pilot', 'synthetic-code'],
    'tynnNetwork.shares.list': [null], 'tynnNetwork.shares.mint': [{ workspaceId: null, capability: 'readonly', expiresInDays: 7 }], 'tynnNetwork.shares.revoke': ['share_fixture'],
});
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
    let uploads: LocalUploads[];
    let draftCalls: Array<{ method: string; args: unknown[] }>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-p4-contract-'));
        devices = await DeviceStore.open(dir, { now: () => 1, random: () => 'contract-token' });
        draftCalls = []; uploads = [];
        const recorded = <T>(method: string, args: unknown[], value: T): T => { draftCalls.push({ method, args }); return value; };
        api = buildHostApi({ ...protocolContractDeps(dir), chatDrafts: {
            all: () => recorded('chatDrafts.load', [], {}),
            save: async (id, raw) => recorded('chatDrafts.save', [id, raw], undefined),
            putFile: async bytes => recorded('chatDrafts.putFile', [bytes], '00000000-0000-4000-8000-000000000001'),
            readFile: async ref => recorded('chatDrafts.readFile', [ref], null),
            release: async refs => recorded('chatDrafts.release', [refs], undefined),
        }, artboard: {
            read: async id => recorded('artboard.read', [id], { posts: [] }),
            review: async (id, post, verdict, comment) => recorded('artboard.review', [id, post, verdict, comment], { ok: true, delivered: false }),
        } });
        const area = await LocalStagingArea.open(dir);
        wireInvocations = [];
        let accept: (connection: ServerConnection) => void = () => {};
        const host = new RemoteHost({
            api: { ...api, invoke: (method, args) => { wireInvocations.push(method); return api.invoke(method, args); } },
            devices, hostName: 'contract-host', baton: new Baton(),
            pins: new PairingPins({ now: () => 1, random: () => 0.482913 }), confirm: allowEveryPairing,
            transport: { onConnection: (listener) => { accept = listener; return () => {}; } },
            createLocalUploads: () => { const registry = area.createConnection(); uploads.push(registry); return registry; },
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
            const transport = capabilityOf(method as RemoteMethod) === 'local' || method.startsWith('localUpload.') ? localPair.client : pair.client;
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
        await Promise.all(uploads?.map(registry => registry.dispose()) ?? []);
        await tick();
        await devices?.flushed();
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    it('has an explicit row for exactly every method in the protocol table', () => {
        expect(Object.keys(ROWS).sort()).toEqual([...REMOTE_METHODS].sort());
        expect(Object.keys(HOST_ONLY_BACKSTOPS).sort()).toEqual([...hostOnlyMethods].sort());
        expect(Object.keys(MARKETPLACE_CONNECTION_REFUSALS).sort()).toEqual([...MARKETPLACE_METHODS].sort());
        expect(Object.keys(GAPP_CONNECTION_REFUSALS).sort()).toEqual([...GAPP_METHODS].sort());
    });

    it.each(REMOTE_METHODS)('%s keeps the direct value, null, or refusal across the wire', async (method) => {
        const row = ROWS[method];
        expect(row, `missing contract row for ${method}`).toBeDefined();
        const args = row!.map((arg) => arg === ROOT ? dir : arg);
        const wireArgs = [...args];
        const gappRefusal = GAPP_CONNECTION_REFUSALS[method];
        const connectionRefusal = MARKETPLACE_CONNECTION_REFUSALS[method] ?? gappRefusal;
        if (connectionRefusal) {
            expect(await directResult(() => api.invoke(method, args))).toEqual({ ok: false, reason: `${gappRefusal ? 'GApp' : 'Marketplace'} actions require their authenticated local window connection.` });
            expect(await rpc(method, wireArgs)).toEqual({ ok: false, reason: connectionRefusal });
            expect(wireInvocations).not.toContain(method);
            return;
        }
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
        if (method === 'chatDrafts.putFile') {
            const begun = await rpc('localUpload.begin', [{ purpose: 'draft-file', subtype: 'attachment', size: 2 }]);
            expect(begun.ok).toBe(true); if (!begun.ok) throw new Error(begun.reason);
            const id = (begun.value as { id: string }).id;
            expect((await rpc('localUpload.chunk', [id, 0, 'b2s='])).ok).toBe(true); wireArgs[0] = { staged: id };
        }
        const expected = await directResult(() => api.invoke(method, args));
        expect(await rpc(method, wireArgs)).toEqual(expected);
        if (method.startsWith('chatDrafts.')) expect(draftCalls).toEqual([{ method, args }, { method, args }]);
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
