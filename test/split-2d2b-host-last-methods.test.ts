import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_METHODS } from '../src/core/engine-protocol.js';
import type { AgentRecord } from '../src/core/identity.js';
import { capabilityOf, REMOTE_METHODS, type RemoteMethod } from '../src/core/remote-protocol.js';
import { hostAloneApi, HOST_ALONE_METHODS, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import { hostRemoteApi } from '../src/main/remote-access-host.js';
import type { HostApi } from '../src/main/remote-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { shareLinksOver } from '../src/main/tynn-share-links.js';
import type { UpdaterPort, UpdateState } from '../src/main/updater.js';
import { NO_WINDOW_INSTALL, remoteUpdatesPort, UpdatesService, type InstallWait, type UpdaterEvent } from '../src/main/updates-host.js';
import { UpdatesReplica } from '../src/main/updates-replica.js';

/*
 * CLIENT/HOST SPLIT STEP 2d-2b (Tynn #898, P4 #332): NO REMOTE METHOD NEEDS A WINDOW.
 *
 * After 2d-2, eleven remote methods were still answered by the newest local window through the engine link's reverse call
 * (`client.remoteInvoke`): opening, stopping and interrupting an agent, a queued draft's action, the host's folder calls,
 * the update actions and the share links. genie-host has every part they need: its session host, its own disk, its
 * updater and its Tynn account. So it answers them itself, and the window fallback and the reverse call are deleted: a
 * remote client is served by genie-host alone, as the window will be at 2d-4.
 *
 * Nothing gains a refusal (the owner, 2026-11-18). An install is still accepted only while a Genie window is open on the
 * host, as it was when the window answered it; a window open there is now every window, and each is spared by the
 * install's teardown and quits when it restarts, whoever asked.
 */

const FAMILY = [
    'openAgent', 'stopAgent', 'cancelTurn', 'resolvePrompt', 'host.listDir', 'host.mkdir', 'host.home',
    'updates.check', 'updates.download', 'updates.install', 'updates.forceDrain',
    'tynnNetwork.shares.list', 'tynnNetwork.shares.mint', 'tynnNetwork.shares.revoke',
] as const satisfies readonly RemoteMethod[];

let dir = '';
let registry: Registry;
let atlas: AgentRecord;

function engine() {
    const calls: unknown[][] = [];
    const e = {
        probe: () => null, subscribe: () => () => {}, ledgerFor: () => [], rowsFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(), needsNewDriver: () => false, notice: () => true,
        stop: async (id: string) => { calls.push(['stop', id]); return true; },
        cancel: async (id: string, by: string, intent: string) => { calls.push(['cancel', id, by, intent]); return { ok: true }; },
        resolvePrompt: async (id: string, promptId: string, action: unknown) => { calls.push(['resolvePrompt', id, promptId, action]); return { ok: true }; },
    };
    return { calls, engine: e as unknown as HostAloneEngine };
}

function ports(over: Record<string, unknown> = {}): HostAlonePorts {
    const e = engine().engine;
    return {
        hostName: 'alphar', registry, engine: () => e, cwdFor: () => '/w', startRefusal: () => null,
        models: { get: async () => ({ models: [] }) }, providerInstalled: () => true,
        attention: { finished: () => [], answer: async () => true, lists: { done: async () => true } },
        approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [], involving: () => [] },
        deliverToAgent: async () => true,
        files: { children: async () => [], open: async () => ({ ok: false }), readBytes: async () => ({ ok: false }), upload: async () => ({ ok: false }) },
        terminals: { open: () => null, list: () => [], attach: () => null, write: () => true, resize: () => true, close: () => true, onData: () => () => {}, onExit: () => () => {} },
        takeOver: () => null,
        headroom: { view: () => ({}), subscribe: () => () => {} },
        settings: { snapshotFor: () => ({}), workspaceValues: () => ({}), setFor: async () => {}, resetFor: async () => {}, onChange: () => () => {} },
        serviceEnvFor: () => ({}),
        uploads: { sendFile: async () => ({ ok: true, messageId: 'msg_1' }) },
        updates: { state: () => ({ phase: 'idle' }), onChange: () => () => {}, check: async () => ({ phase: 'idle' }), download: async () => true, install: () => Promise.resolve({ report: 'r' }), forceDrain: async () => true, notes: async () => null },
        shares: { list: async () => ({ ok: true, links: [] }), mint: async () => ({ ok: false, reason: 'x' }), revoke: async () => ({ ok: true }) },
        ...over,
    } as unknown as HostAlonePorts;
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-split-2d2b-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await mkdir(join(dir, 'tynn'));
    await writeFile(join(dir, 'tynn', 'project.json'), JSON.stringify({ name: 'tynn' }));
    await registry.addWorkspace({ id: 'tynn', path: join(dir, 'tynn') });
    atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('genie-host owns the last methods a window answered', () => {
    it('each is in the set genie-host owns', () => {
        for (const method of FAMILY) expect(HOST_ALONE_METHODS.has(method)).toBe(true);
    });

    it('every remote method a connection can reach is genie-host\'s: none is left for a window', () => {
        const own = new Set<string>(['updates.state', 'takeOver', 'accounts.list', 'accounts.act', 'accounts.dismissOffer', 'features.snapshot', 'features.act']);
        const reachable = REMOTE_METHODS.filter((m) => capabilityOf(m) !== 'local' && capabilityOf(m) !== 'host-only');
        expect(reachable.filter((m) => !HOST_ALONE_METHODS.has(m) && !own.has(m))).toEqual([]);
    });

    it('the remote API has no window to fall back on: each of them reaches genie-host\'s answers', async () => {
        const alone = hostAloneApi(ports());
        const invoke = vi.spyOn(alone, 'invoke');
        const api: HostApi = hostRemoteApi({ hostName: 'alphar', own: {}, alone });
        for (const method of FAMILY) {
            const answer = await api.invoke(method, []).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
            expect(String(answer)).not.toMatch(/open Genie on alphar/);
        }
        expect(invoke.mock.calls.map(([method]) => method)).toEqual([...FAMILY]);
    });

    it('before genie-host\'s answers are built, a call is told to try again, never sent to a window', async () => {
        const api = hostRemoteApi({ hostName: 'alphar', own: {}, alone: () => null });
        await expect(api.invoke('openAgent', [atlas.id])).rejects.toThrow(/alphar's services are still starting; try again in a moment/);
    });
});

describe('what each one does on genie-host', () => {
    it('openAgent shows a known agent and starts nothing; an unknown one is said', async () => {
        const e = engine();
        const api = hostAloneApi(ports({ engine: () => e.engine }));
        expect(await api.invoke('openAgent', [atlas.id])).toEqual({ ok: true });
        expect(await api.invoke('openAgent', ['agent_nope'])).toEqual({ ok: false, reason: 'unknown agent' });
        expect(e.calls).toEqual([]);
    });

    it('stopAgent, cancelTurn and resolvePrompt reach genie-host\'s session host', async () => {
        const e = engine();
        const api = hostAloneApi(ports({ engine: () => e.engine }));
        expect(await api.invoke('stopAgent', [atlas.id])).toEqual({ ok: true });
        expect(await api.invoke('cancelTurn', [atlas.id, 'interrupt'])).toEqual({ ok: true });
        expect(await api.invoke('resolvePrompt', [atlas.id, 'p1', 'withdraw'])).toEqual({ ok: true });
        expect(e.calls).toEqual([['stop', atlas.id], ['cancel', atlas.id, 'you', 'interrupt'], ['resolvePrompt', atlas.id, 'p1', 'withdraw']]);
    });

    it('host.home, host.listDir and host.mkdir are genie-host\'s own disk', async () => {
        const api = hostAloneApi(ports());
        expect(await api.invoke('host.home', [])).toBe(homedir());
        expect(await api.invoke('host.mkdir', [dir, 'made-here'])).toMatchObject({ ok: true });
        expect(existsSync(join(dir, 'made-here'))).toBe(true);
        const listed = JSON.stringify(await api.invoke('host.listDir', [dir]));
        expect(listed).toContain('made-here');
    });

    it('the share links are genie-host\'s Tynn account\'s', async () => {
        const shares = { list: vi.fn(async () => ({ ok: true, links: [] })), mint: vi.fn(async () => ({ ok: false, reason: 'no' })), revoke: vi.fn(async () => ({ ok: true })) };
        const api = hostAloneApi(ports({ shares }));
        expect(await api.invoke('tynnNetwork.shares.list', ['tynn'])).toEqual({ ok: true, links: [] });
        await api.invoke('tynnNetwork.shares.mint', [{ workspaceId: 'tynn', capability: 'readonly', expiresInDays: 3 }]);
        expect(await api.invoke('tynnNetwork.shares.revoke', ['link_1'])).toEqual({ ok: true });
        expect(shares.list).toHaveBeenCalledWith('tynn');
        expect(shares.mint).toHaveBeenCalledWith({ workspaceId: 'tynn', capability: 'readonly', expiresInDays: 3 });
        expect(shares.revoke).toHaveBeenCalledWith('link_1');
    });

    it('the update actions are genie-host\'s updater\'s', async () => {
        const updates = { state: () => ({ phase: 'idle' }), onChange: () => () => {}, check: vi.fn(async () => ({ phase: 'available' })), download: vi.fn(async () => true), install: vi.fn(() => Promise.resolve({ report: 'done' })), forceDrain: vi.fn(async () => true), notes: vi.fn(async () => null) };
        const api = hostAloneApi(ports({ updates }));
        expect(await api.invoke('updates.check', [])).toEqual({ phase: 'available' });
        expect(await api.invoke('updates.download', [])).toBe(true);
        expect(await api.invoke('updates.install', [])).toEqual({ report: 'done' });
        expect(await api.invoke('updates.forceDrain', [])).toBe(true);
        expect([updates.check, updates.download, updates.install, updates.forceDrain].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
    });
});

describe('share links over a Tynn session', () => {
    it('read the workstation at each call; a revoke ends the link\'s live sessions', async () => {
        let workstation: string | null = null;
        const asked: string[] = [];
        const ended = vi.fn(async () => {});
        const request = async (path: string, init: { method: string }) => { asked.push(`${init.method} ${path}`); return { ok: true, status: 200, json: async () => ({ links: [] }) }; };
        const shares = shareLinksOver({ request, workstation: () => workstation, endSessions: ended });
        expect((await shares.list(null)).ok).toBe(false);
        workstation = 'ws_9';
        expect(await shares.list(null)).toEqual({ ok: true, links: [] });
        expect(await shares.revoke('l1')).toEqual({ ok: true });
        expect(asked).toEqual(['GET /api/v1/workstations/ws_9/share-links', 'DELETE /api/v1/workstations/ws_9/share-links/l1']);
        expect(ended).toHaveBeenCalledTimes(1);
    });
});

/** genie-host's updater with a helper that answers at once, a machine of processes, and what the install did. */
function updaterRig() {
    const order: string[] = [];
    const waits: InstallWait[] = [];
    const procs = [
        { pid: 100, executable: '/opt/genie/genie', parentPid: 1 },
        { pid: 200, executable: '/opt/genie/genie', parentPid: 1 },
        { pid: 201, executable: '/opt/genie/genie', parentPid: 200 },
        { pid: 300, executable: '/opt/genie/genie', parentPid: 1 },
        { pid: 600, executable: '/opt/genie/genie', parentPid: 1 },
    ];
    const lib: UpdaterPort = { configure: () => {}, check: async () => ({ version: '2.0.1' }), download: async (p) => { p(100); }, quitAndInstall: () => {} };
    let service: UpdatesService;
    const send = (event: UpdaterEvent) => {
        if (event.kind !== 'request') return;
        if (event.op === 'install' && event.wait) waits.push(event.wait);
        queueMicrotask(() => service.helperCall('reply', [event.id, true, event.op === 'check' ? { version: '2.0.1' } : null], 'helper'));
    };
    service = new UpdatesService({
        host: {
            installDir: '/opt/genie', ownPid: 100, processes: async () => procs, kill: (pid: number) => { order.push(`kill ${pid}`); return true; }, caseInsensitive: false,
            channel: 'stable', agents: { live: () => [], stopAll: async () => {} }, port: lib,
        } as never,
        startHelper: () => { service.helperLinked('helper', 900, send); },
        defaultLaunch: { file: '/opt/genie/genie', args: ['--updater'] },
        windowConnected: () => false,
        exit: () => { order.push('host exit'); },
        defer: (fn) => { fn(); },
        helperPatienceMs: 200,
    });
    return { service, order, waits, port: remoteUpdatesPort(service) };
}

describe('genie-host\'s updater, asked by a remote client', () => {
    it('check, download and notes need no window', async () => {
        const r = updaterRig();
        expect((await r.port.check()).phase).toBe('available');
        expect(await r.port.download()).toBe(true);
        expect(r.service.dump().phase).toBe('downloaded');
    });

    it('CONTROL, unchanged: with no window open on the host, an install is refused in words and nothing is stopped', async () => {
        const r = updaterRig();
        await r.port.check(); await r.port.download();
        await expect(Promise.resolve(r.port.install())).rejects.toThrow(NO_WINDOW_INSTALL);
        expect(r.order).toEqual([]);
        await expect(Promise.resolve(r.port.forceDrain?.())).rejects.toThrow(NO_WINDOW_INSTALL);
    });

    it('with windows open, it installs: every window\'s tree is spared by the teardown and the helper waits for each', async () => {
        const r = updaterRig();
        await r.service.call('window', [200], { window: true, connection: 'w1' });
        await r.service.call('window', [300], { window: true, connection: 'w2' });
        await r.port.check(); await r.port.download();
        await r.port.install();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(r.order).toEqual(['kill 600', 'host exit']);
        expect(r.waits).toHaveLength(1);
        expect([...r.waits[0]!.pids].sort()).toEqual([100, 200, 300]);
    });

    it('a window whose link closed is neither spared nor waited for, and with none left the install is refused again', async () => {
        const r = updaterRig();
        await r.service.call('window', [200], { window: true, connection: 'w1' });
        await r.service.call('window', [300], { window: true, connection: 'w2' });
        r.service.windowDropped('w2');
        await r.port.check(); await r.port.download();
        await r.port.install();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(r.order).toEqual(['kill 300', 'kill 600', 'host exit']);
        expect([...r.waits[0]!.pids].sort()).toEqual([100, 200]);
        const s = updaterRig();
        await s.service.call('window', [200], { window: true, connection: 'w1' });
        s.service.windowDropped('w1');
        await s.port.check(); await s.port.download();
        await expect(Promise.resolve(s.port.install())).rejects.toThrow(NO_WINDOW_INSTALL);
    });

    it('only a window says it is a window: a remote client\'s or the helper\'s claim is refused', async () => {
        const r = updaterRig();
        await expect(r.service.call('window', [200], { window: false })).rejects.toThrow();
        await expect(r.service.call('window', [200], { window: true })).rejects.toThrow();
        await r.port.check(); await r.port.download();
        await expect(Promise.resolve(r.port.install())).rejects.toThrow(NO_WINDOW_INSTALL);
    });
});

describe('a window quits when the host\'s install restarts, whoever asked', () => {
    const installing = (step: string, reason?: string): UpdateState => ({ phase: 'installing', version: '2.0.1', percent: 100, error: null, checkedAt: 1, installing: { step, agents: 0, left: 0, ...(reason ? { reason } : {}) } } as unknown as UpdateState);

    it('told once at "restarting"; never while the agents stop, and never for a quit\'s drain', () => {
        const replica = new UpdatesReplica(async () => null, 77);
        let told = 0;
        replica.onInstalling(() => { told += 1; });
        replica.rebase(installing('waiting', 'quit'));
        replica.rebase(installing('agents', 'quit'));
        replica.rebase(installing('agents'));
        replica.rebase(installing('processes'));
        expect(told).toBe(0);
        replica.rebase(installing('restarting'));
        replica.rebase(installing('restarting'));
        expect(told).toBe(1);
    });

    it('a window says it is one, with its pid, each time it links', async () => {
        const calls: unknown[][] = [];
        const replica = new UpdatesReplica(async (method, args) => { calls.push([method, ...args]); return null; }, 77);
        await replica.announce();
        expect(calls).toEqual([['window', 77]]);
        const main = readFileSync('src/main/main.ts', 'utf8');
        const linked = main.slice(main.indexOf('onLinked: (client) => {'), main.indexOf('onLinked: (client) => {') + 2000);
        expect(linked).toMatch(/client\.updates\(\)\.announce\(\)/);
    });

    it('the engine link tells the updater which link said it, and when a window\'s link closes', () => {
        const server = readFileSync('src/main/session-engine-server.ts', 'utf8');
        // Genie's launcher's own link says it is the launcher's (Tynn #1058 L6); a window's link, a window's.
        expect(server).toMatch(/updates\.call\(str\(0\), Array\.isArray\(args\[1\]\) \? args\[1\] : \[\], conn\.launcher \? \{ window: false, launcher: true, connection: conn\.id \} : \{ window: true, connection: conn\.id \}\)/);
        expect(server).toMatch(/updates\?\.windowDropped\(conn\.id\)/);
    });
});

describe('the reverse call is gone', () => {
    it('no engine method, server call, window handler or wire codec for it remains', () => {
        expect((ENGINE_METHODS as readonly string[]).includes('client.remoteInvoke')).toBe(false);
        expect(readFileSync('src/main/session-engine-server.ts', 'utf8')).not.toMatch(/remoteInvoke|remote-invoke-wire/);
        expect(readFileSync('src/main/session-engine-client.ts', 'utf8')).not.toMatch(/onRemoteInvoke|remote-invoke-wire/);
        expect(readFileSync('src/main/main.ts', 'utf8')).not.toMatch(/onRemoteInvoke/);
        expect(existsSync('src/main/remote-invoke-wire.ts')).toBe(false);
    });

    it('genie-host wires the remote API with no window port, and its own updater and share links into its answers', () => {
        const host = readFileSync('src/main/genie-host.ts', 'utf8');
        const remote = host.slice(host.indexOf('api: hostRemoteApi({'), host.indexOf('api: hostRemoteApi({') + 2500);
        expect(remote).not.toMatch(/window: \{/);
        expect(remote).not.toMatch(/remoteInvoke/);
        const block = host.slice(host.indexOf('phoneApi = hostAloneApi({'));
        expect(block).toMatch(/updates: remoteUpdatesPort\(updatesService\)/);
        expect(block).toMatch(/shares: shareLinksOver\(\{/);
        expect(host).not.toMatch(/check for updates from Genie’s window/);
        expect(readFileSync('src/main/remote-access-host.ts', 'utf8')).not.toMatch(/only while a Genie window is open there/);
    });
});
