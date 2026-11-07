import { expect, it, vi } from 'vitest';
import { HostingReplica, HostingService, type HostingDump } from '../src/main/hosting-host.js';
import { wakeWorkspace, type WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';

function fixture(verify: () => Promise<void>) {
    const events: string[] = [];
    let asleep = true;
    const ports = { registry: { workspace: () => ({ id: 'workspace', path: '/fixture', asleep }),
        setAsleep: async (_id: string, value: boolean) => { asleep = value; events.push('awake', 'agents', 'sites', 'flows', 'config'); return true; },
    }, reverifyTrustBeforeRedock: async () => { events.push('verify'); await verify(); events.push('verified'); },
    engines: { toResume: () => ['database'], start: async () => { events.push('engine'); } },
    } as unknown as WorkspaceOpsPorts;
    return { ports, events, asleep: () => asleep };
}

it('story394: redock awaits fresh host trust before metadata can activate any agent/site/flow/config/engine work', async () => {
    let release!: () => void;
    const f = fixture(() => new Promise<void>((resolve) => { release = resolve; }));
    const waking = wakeWorkspace(f.ports, 'workspace');
    try { expect(f.events).toEqual(['verify']); expect(f.asleep()).toBe(true); }
    finally { release?.(); }
    expect(await waking).toMatchObject({ ok: true });
    expect(f.events).toEqual(['verify', 'verified', 'awake', 'agents', 'sites', 'flows', 'config', 'engine']);
});

it('story394: failed host trust verification keeps the workspace asleep and activates nothing', async () => {
    const f = fixture(async () => { throw new Error('trust unavailable'); });
    expect(await wakeWorkspace(f.ports, 'workspace')).toMatchObject({ ok: false, reason: expect.stringMatching(/trust unavailable/) });
    expect(f.asleep()).toBe(true); expect(f.events).toEqual(['verify']);
});

it('story394: the redock refresh purpose survives the existing window-to-host hosting call', async () => {
    const refreshed = vi.fn(async () => null);
    const none = () => () => {};
    const service = new HostingService({ sites: { onChange: none }, engines: { onChange: none, onStarted: none }, onFrontDoorChange: none, trust: { refresh: refreshed, onVerdict: none }, engineReconcile: Promise.resolve({}) } as never, { workspaces: () => ['workspace'], schedule: () => () => {} });
    // The call publishes its dump after refresh. Isolate that unrelated snapshot assembly, not the real call/forwarding.
    vi.spyOn(service, 'dump').mockReturnValue({ frontDoorPort: 0, browserTrust: { caPem: null, reason: 'fixture' }, externalFrontDoor: { running: false, reason: 'fixture' }, routes: [], configuredHosts: [], deckItems: [], sites: [], specs: {}, declared: {}, engines: [], workspaces: {}, dependents: {}, reconcile: null, problems: [] });
    const replica = new HostingReplica((method, args) => service.call(method, args));
    type Refresh = (id: string, purpose?: 'redock') => Promise<unknown>;
    await (replica.trust.refresh as Refresh)('workspace', 'redock');
    expect(refreshed).toHaveBeenCalledWith('workspace', 'redock');
});

it('story394: a hidden registered folder is refused by the hosting replica rather than mistaken for a new folder', async () => {
    const replica = new HostingReplica(async () => null);
    const dump: HostingDump & { registeredFolders: readonly string[] } = {
        frontDoorPort: 0, browserTrust: { caPem: null, reason: 'fixture' }, externalFrontDoor: { running: false, reason: 'fixture' },
        routes: [], configuredHosts: [], deckItems: [], sites: [], specs: {}, declared: {}, engines: [], dependents: {}, reconcile: null, problems: [],
        workspaces: { awake: { env: {}, choices: [], toRelease: [], toResume: [], path: '/fixture/awake' } },
        registeredFolders: ['/fixture/awake', '/fixture/ghost'],
        trust: [{ workspaceId: 'awake', path: '/fixture/awake', trusted: true, changed: false, list: { sites: [], hooks: [], servers: [], gitKeys: [], approvals: [] } }],
    };
    replica.rebase(dump);
    expect(await replica.trust.mayWriteInto('/fixture/ghost')).toBe(false);
    expect(await replica.trust.mayWriteInto('/fixture/awake')).toBe(true);
    expect(await replica.trust.mayWriteInto('/fixture/new')).toBe(true);
});
