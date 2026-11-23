import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inMemoryPair, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { droneRefusal } from '../src/core/workstation-role.js';
import type { AppInboxDump } from '../src/main/app-inbox-host.js';
import { FilesWatchHub, type FilesHubEvent } from '../src/main/files-watch-hub.js';
import { hostAloneApi, type HostAloneEngine, type HostAlonePorts } from '../src/main/host-alone-api.js';
import * as hostLocalWatches from '../src/main/host-local-watches.js';
import { HOST_LOCAL_OWNER, hostFilesWatch, hostTynnWatch } from '../src/main/host-local-watches.js';
import { hostOwnerOps, restartAppSource, type HostOwnerSources } from '../src/main/host-owner-ops.js';
import { LocalStagingArea } from '../src/main/local-staging-area.js';
import { RemoteAccessHost, hostRemoteApi } from '../src/main/remote-access-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/*
 * CLIENT/HOST SPLIT STEP 2d-3b (Tynn #898): GENIE-HOST'S WATCHES, OWNER OPERATIONS AND LOCAL UPLOADS.
 *
 * What this machine's window asks of its host, that genie-host could not yet answer itself:
 *   - the watch hubs (files, the Tynn board/issues/features) sent only to engine-link owners; genie-host's own answers had
 *     no owner to watch as, so `files.watch` / `tynn.watch` had no port there;
 *   - the owner operations (the Apps and scripts card, the remembered device hosts, "Your workstations" and a role change)
 *     said "open Genie on X";
 *   - local uploads were not configured on genie-host's RemoteHost.
 * At 2d-4 the window connects to genie-host's RemoteHost and is served there, so each must be genie-host's first.
 * Nothing gains a refusal (the owner, 2026-11-18).
 */

let dir = '';
let registry: Registry;

function engine(): HostAloneEngine {
    return { probe: () => null, subscribe: () => () => {}, ledgerFor: () => [], rowsFor: () => [], turnsFor: () => 0, recentStderrFor: () => [], refusals: new Map(), needsNewDriver: () => false, notice: () => true } as unknown as HostAloneEngine;
}

const SHARES = { list: async () => ({ ok: true, links: [] }), mint: async () => ({ ok: false, reason: 'x' }), revoke: async () => ({ ok: true }) };

function ports(over: Record<string, unknown> = {}): HostAlonePorts {
    const e = engine();
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
        workspaceLifecycle: { terminals: () => null, supervisor: () => null, engines: () => null, reverifyTrust: async () => {}, github: () => null, tynn: () => null, defaultEnvFile: () => '', stagingDirectory: () => '' },
        colors: { set: async () => ({ ok: true }) },
        tynnTab: { board: async () => ({ signedIn: () => true, projectFor: () => null, request: async () => ({ ok: true, status: 200, json: async () => ({}) }) }), readPage: async () => ({ ok: true }) },
        shares: SHARES,
        ...over,
    } as unknown as HostAlonePorts;
}

const DUMP: AppInboxDump = {
    url: 'http://127.0.0.1:7000',
    workspaces: { tynn: { sources: [{ kind: 'site', id: 's1', name: 'tynn.gen' }], revoked: [{ kind: 'process', id: 'p9' }], scriptKeys: [{ id: 'k1', name: 'ci', createdAt: '2026-11-19', lastUsedAt: null }] } },
};

/** genie-host's own parts, as genie-host.ts hands them over; each records what reached it. */
function owner(over: { role?: 'pilot' | 'drone' | null; account?: boolean; status?: number; rows?: unknown[]; roleAfterRead?: 'pilot' | 'drone' | null } = {}) {
    const calls: unknown[][] = [];
    let role = over.role === undefined ? 'pilot' : over.role;
    const restarted: string[] = [];
    const account = {
        host: () => 'https://tynn.ai',
        status: () => ({ signedIn: true }),
        request: async (path: string, init: { method: string; body?: unknown }) => {
            calls.push(['tynn', init.method, path, init.body]);
            const status = over.status ?? 200;
            const body = path.endsWith('/role') ? { workstation: { role: (init.body as { role: string }).role } } : { workstations: over.rows ?? [] };
            return { ok: status < 300, status, json: async () => body };
        },
    };
    const s: HostOwnerSources = {
        appInbox: {
            door: { dump: () => DUMP, call: async (method, args) => { calls.push(['door', method, [...args]]); return method === 'createScriptKey' ? { id: 'k2', token: 'tok_secret' } : true; } },
            enabled: (id) => id === 'tynn',
            workspaceExists: (id) => id === 'tynn',
            restart: { serviceEnvChanged: () => ['s1'], processes: () => ({ status: () => ({ state: 'running' }), restart: async (id) => { restarted.push(id); } }) },
        },
        deviceLink: { call: async (who, method, args) => { calls.push(['device', who, method, [...args]]); return method === 'hosts' ? ['wss://beta:7443'] : true; } },
        tynn: {
            account: () => (over.account === false ? null : account),
            role: () => role,
            readRole: async () => { calls.push(['readRole']); if (over.roleAfterRead !== undefined) role = over.roleAfterRead; },
            registered: () => 'ws_this_launch',
            stored: async (host) => (host === 'https://tynn.ai' ? 'ws_stored' : null),
            v1Settings: () => ({ workstation_id: 'ws_genie1' }),
        },
    };
    return { s, calls, restarted };
}

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, status: 'active', connectable: true, source: 'owner', registered_by_you: true, role: 'drone', ...extra });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-split-2d3b-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await mkdir(join(dir, 'tynn'));
    await writeFile(join(dir, 'tynn', 'project.json'), JSON.stringify({ name: 'tynn' }));
    await registry.addWorkspace({ id: 'tynn', path: join(dir, 'tynn') });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the watch hubs have a host-local owner', () => {
    it('a files view watches through the hub as genie-host\'s own owner; an asleep or unknown workspace is not watched', async () => {
        const subscribed: unknown[][] = [];
        const hub = { subscribe: (...a: unknown[]) => { subscribed.push(['sub', ...a]); }, unsubscribe: (...a: unknown[]) => { subscribed.push(['unsub', ...a]); } };
        const workspaces: Record<string, { id: string; path: string; asleep?: boolean }> = { tynn: { id: 'tynn', path: '/w/tynn' }, nap: { id: 'nap', path: '/w/nap', asleep: true } };
        const { port } = hostFilesWatch({ hub: () => hub as never, workspace: (id) => workspaces[id] ?? null, recordDiskChanges: () => {} });
        expect(await port.watch('v1', 'tynn', { git: true })).toBe(true);
        expect(await port.watch('v2', 'nap', {})).toBe(false);
        expect(await port.watch('v3', 'nope', {})).toBe(false);
        expect(port.exists?.('nap')).toBe(false);
        expect(port.exists?.('tynn')).toBe(true);
        port.unwatch('v1');
        expect(subscribed).toEqual([['sub', HOST_LOCAL_OWNER, 'v1', { id: 'tynn', path: '/w/tynn' }, { git: true }], ['unsub', HOST_LOCAL_OWNER, 'v1']]);
        // No hub yet (genie-host builds it after the engine server): not watched, and nothing throws.
        expect(await hostFilesWatch({ hub: () => null, workspace: (id) => workspaces[id] ?? null, recordDiskChanges: () => {} }).port.watch('v1', 'tynn', {})).toBe(false);
    });

    it('a delivered batch reaches the port\'s listeners and the file panel\'s record; a git delta becomes the whole tree', () => {
        const recorded: unknown[][] = [];
        const files = hostFilesWatch({ hub: () => null, workspace: () => null, recordDiskChanges: (id, changes) => { recorded.push([id, changes]); } });
        const heard: FilesHubEvent[] = [];
        const off = files.port.subscribe((event) => heard.push(event));
        files.deliver({ kind: 'changed', workspaceId: 'tynn', changes: [{ path: 'a.txt', at: 1 }] });
        files.deliver({ kind: 'git', workspaceId: 'tynn', tree: { 'a.txt': 'modified' } });
        files.deliver({ kind: 'git', workspaceId: 'tynn', treeChanges: { set: { 'b.txt': 'added' }, removed: ['a.txt'] } });
        off();
        files.deliver({ kind: 'changed', workspaceId: 'tynn', changes: [{ path: 'c.txt', at: 2 }] });
        expect(recorded).toEqual([['tynn', [{ path: 'a.txt', at: 1 }]], ['tynn', [{ path: 'c.txt', at: 2 }]]]);
        expect(heard).toHaveLength(3);
        expect(heard[2]).toMatchObject({ kind: 'git', workspaceId: 'tynn', tree: { 'b.txt': 'added' } });
        expect((heard[2] as { treeChanges?: unknown }).treeChanges).toBeUndefined();
    });

    it('there is no owner route any more: no hub sends an owner\'s events over the engine link (the files hub since Tynn #1043, the Tynn hubs since #934 task #1474)', () => {
        expect(Object.keys(hostLocalWatches).sort()).toEqual(['HOST_LOCAL_OWNER', 'hostFilesWatch', 'hostTynnWatch']);
    });

    it('the real files hub sends genie-host\'s own view\'s batch here; a view under any other owner is told nowhere', async () => {
        let onPath: ((rel: string) => void) | null = null;
        const timers: Array<() => void> = [];
        const remote: unknown[][] = [];
        let hub: FilesWatchHub | null = null;
        const files = hostFilesWatch({ hub: () => hub, workspace: (id) => (id === 'tynn' ? { id, path: join(dir, 'tynn') } : null), recordDiskChanges: () => {} });
        // As genie-host wires it: its own owner's events to its watch port; `remote` records what any other owner was sent.
        hub = new FilesWatchHub({ send: (owner, event) => { if (owner === HOST_LOCAL_OWNER) files.deliver(event); else remote.push([owner, event]); }, source: (_root, cb) => { onPath = cb; return { close: () => {} }; }, schedule: (fn) => { timers.push(fn); return () => {}; }, now: () => 5 });
        const heard: FilesHubEvent[] = [];
        files.port.subscribe((e) => heard.push(e));
        expect(await files.port.watch('v1', 'tynn', {})).toBe(true);
        hub.subscribe('window-uuid', 'w1', { id: 'tynn', path: join(dir, 'tynn') }, {});
        expect(onPath).not.toBeNull();
        onPath!('a.txt');
        for (const t of timers.splice(0)) t();
        expect(heard).toEqual([{ kind: 'changed', workspaceId: 'tynn', changes: [{ path: 'a.txt', at: 5 }] }]);
        expect(remote).toEqual([['window-uuid', { kind: 'changed', workspaceId: 'tynn', changes: [{ path: 'a.txt', at: 5 }] }]]);
    });

    it('a Tynn view watches its kind\'s hub as genie-host\'s own owner; an unlinked workspace is not; signals come back by kind', async () => {
        const seen: unknown[][] = [];
        const hubOf = (kind: string) => ({ watch: (o: string, v: string, w: string) => { seen.push([kind, 'watch', o, v, w]); return w === 'tynn'; }, unwatch: (o: string, v: string) => { seen.push([kind, 'unwatch', o, v]); } });
        const tynn = hostTynnWatch({ hubs: { board: hubOf('board') as never, issues: hubOf('issues') as never, features: hubOf('features') as never } });
        expect(await tynn.port.watch('board', 'v1', 'tynn')).toBe(true);
        expect(await tynn.port.watch('issues', 'v2', 'unlinked')).toBe(false);
        tynn.port.unwatch('features', 'v3');
        expect(seen).toEqual([['board', 'watch', HOST_LOCAL_OWNER, 'v1', 'tynn'], ['issues', 'watch', HOST_LOCAL_OWNER, 'v2', 'unlinked'], ['features', 'unwatch', HOST_LOCAL_OWNER, 'v3']]);
        const heard: unknown[] = [];
        tynn.port.subscribe((e) => heard.push(e));
        tynn.deliver('issues', { workspaceId: 'tynn', signal: { ring: 1 } as never });
        expect(heard).toEqual([{ kind: 'issues', workspaceId: 'tynn', signal: { ring: 1 } }]);
    });

    it('genie-host\'s answers carry both watch ports, and RemoteHost reads them off its API', () => {
        const files = hostFilesWatch({ hub: () => null, workspace: () => null, recordDiskChanges: () => {} });
        const tynn = hostTynnWatch({ hubs: { board: { watch: () => false, unwatch: () => {} }, issues: { watch: () => false, unwatch: () => {} }, features: { watch: () => false, unwatch: () => {} } } as never });
        const built = hostAloneApi(ports({ local: { filesWatch: files.port, tynnWatch: tynn.port } }));
        const api = hostRemoteApi({ hostName: 'alphar', own: {}, alone: () => built });
        expect(api.filesWatch).toBe(files.port);
        expect(api.tynnWatch).toBe(tynn.port);
    });
});

describe('the owner operations are genie-host\'s', () => {
    it('the Apps and scripts card is read from genie-host\'s app door and the workspace\'s switch', async () => {
        const { s } = owner();
        const api = hostAloneApi(ports({ owner: hostOwnerOps(s) }));
        expect(await api.invoke('appInbox.state', ['tynn'])).toEqual({ ok: true, state: { url: DUMP.url, enabled: true, sources: DUMP.workspaces.tynn!.sources, revoked: DUMP.workspaces.tynn!.revoked, scriptKeys: DUMP.workspaces.tynn!.scriptKeys } });
        expect(await api.invoke('appInbox.state', ['other'])).toEqual({ ok: true, state: { url: DUMP.url, enabled: false, sources: [], revoked: [], scriptKeys: [] } });
    });

    it('a key is made and revoked at the door; a source is rotated there and restarted with its new credential', async () => {
        const { s, calls } = owner();
        const api = hostAloneApi(ports({ owner: hostOwnerOps(s) }));
        expect(await api.invoke('appInbox.createKey', ['tynn', 'ci'])).toMatchObject({ ok: true, id: 'k2', token: 'tok_secret' });
        expect(await api.invoke('appInbox.revokeKey', ['tynn', 'k1'])).toMatchObject({ ok: true });
        expect(await api.invoke('appInbox.source', ['tynn', 'rotate', 'site', 's1'])).toMatchObject({ ok: true, text: 'Rotated: restarted with it' });
        expect(await api.invoke('appInbox.source', ['tynn', 'revoke', 'process', 'p1'])).toMatchObject({ ok: true, text: 'Revoked: restarted with it' });
        expect(calls.filter((c) => c[0] === 'door')).toEqual([
            ['door', 'createScriptKey', ['tynn', 'ci']],
            ['door', 'revokeScriptKey', ['k1']],
            ['door', 'rotate', ['site', 's1']],
            ['door', 'revokeSource', [{ kind: 'process', id: 'p1', workspaceId: 'tynn' }]],
        ]);
    });

    it('a source restarts only when it runs: a site the hosting restarted, a running process; otherwise its next start', async () => {
        const restarted: string[] = [];
        const book = (state: string) => ({ status: () => ({ state }), restart: async (id: string) => { restarted.push(id); } });
        expect(await restartAppSource({ serviceEnvChanged: () => ['s1'], processes: () => null }, 'tynn', 'site', 's1')).toBe('restarted with it');
        expect(await restartAppSource({ serviceEnvChanged: () => [], processes: () => null }, 'tynn', 'site', 's1')).toBe('its next start uses it');
        expect(await restartAppSource({ serviceEnvChanged: () => [], processes: () => book('running') }, 'tynn', 'process', 'p1')).toBe('restarted with it');
        expect(await restartAppSource({ serviceEnvChanged: () => [], processes: () => book('stopped') }, 'tynn', 'process', 'p2')).toBe('its next start uses it');
        expect(await restartAppSource({ serviceEnvChanged: () => [], processes: () => null }, 'tynn', 'process', 'p3')).toBe('its next start uses it');
        expect(restarted).toEqual(['p1']);
    });

    it('the remembered device hosts are genie-host\'s device link\'s', async () => {
        const { s, calls } = owner();
        const api = hostAloneApi(ports({ owner: hostOwnerOps(s) }));
        expect(await api.invoke('deviceLink.hosts', [])).toEqual(['wss://beta:7443']);
        expect(await api.invoke('deviceLink.forget', ['wss://beta:7443'])).toBe(true);
        expect(await api.invoke('deviceLink.adopt', ['wss://gamma:7443', 'tok'])).toBe(true);
        expect(calls.filter((c) => c[0] === 'device')).toEqual([
            ['device', HOST_LOCAL_OWNER, 'hosts', []],
            ['device', HOST_LOCAL_OWNER, 'forget', ['wss://beta:7443']],
            ['device', HOST_LOCAL_OWNER, 'adopt', ['wss://gamma:7443', 'tok']],
        ]);
    });

    it('"Your workstations" is asked of Tynn with genie-host\'s account, and leaves out every identity this machine holds', async () => {
        const { s, calls } = owner({ rows: [row('ws_this_launch'), row('ws_stored'), row('ws_genie1'), row('ws_beta')] });
        const api = hostAloneApi(ports({ owner: hostOwnerOps(s) }));
        const answer = await api.invoke('tynnNetwork.workstations', []) as { ok: true; workstations: Array<{ id: string }> };
        expect(answer.ok).toBe(true);
        expect(answer.workstations.map((w) => w.id)).toEqual(['ws_beta']);
        expect(calls).toContainEqual(['tynn', 'GET', '/api/v1/workstations/connectable', undefined]);
    });

    it('no account, or a drone, is said before Tynn is asked; Tynn\'s refusal reads the role again first', async () => {
        const none = owner({ account: false });
        expect(await hostAloneApi(ports({ owner: hostOwnerOps(none.s) })).invoke('tynnNetwork.workstations', [])).toEqual({ ok: false, reason: 'this Genie has no Tynn account' });
        const drone = owner({ role: 'drone' });
        expect(await hostAloneApi(ports({ owner: hostOwnerOps(drone.s) })).invoke('tynnNetwork.workstations', [])).toEqual({ ok: false, reason: droneRefusal('drone') });
        expect(drone.calls.filter((c) => c[0] === 'tynn')).toEqual([]);
        const demoted = owner({ status: 404, roleAfterRead: 'drone' });
        expect(await hostAloneApi(ports({ owner: hostOwnerOps(demoted.s) })).invoke('tynnNetwork.workstations', [])).toEqual({ ok: false, reason: droneRefusal('drone') });
        expect(demoted.calls).toContainEqual(['readRole']);
    });

    it('a role change goes to Tynn with the code, and the role is read again once it is changed', async () => {
        const { s, calls } = owner();
        const api = hostAloneApi(ports({ owner: hostOwnerOps(s) }));
        expect(await api.invoke('tynnNetwork.setRole', ['ws_beta', 'pilot', '123 456'])).toEqual({ ok: true, role: 'pilot' });
        expect(calls).toContainEqual(['tynn', 'PUT', '/api/v1/workstations/ws_beta/role', { role: 'pilot', code: '123456' }]);
        expect(calls).toContainEqual(['readRole']);
    });

    it('every owner method is answered by genie-host: none says to open a window', async () => {
        const { s } = owner({ rows: [] });
        const api = hostRemoteApi({ hostName: 'alphar', own: {}, alone: hostAloneApi(ports({ owner: hostOwnerOps(s) })) });
        const asks: Array<[string, unknown[]]> = [
            ['appInbox.state', ['tynn']], ['appInbox.createKey', ['tynn', 'ci']], ['appInbox.revokeKey', ['tynn', 'k1']], ['appInbox.source', ['tynn', 'allow', 'site', 's1']],
            ['deviceLink.hosts', []], ['deviceLink.forget', ['wss://beta:7443']], ['deviceLink.adopt', ['wss://beta:7443', 't']],
            ['tynnNetwork.workstations', []], ['tynnNetwork.setRole', ['ws_beta', 'drone', '123456']], ['tynnNetwork.shares.list', [null]],
        ];
        for (const [method, args] of asks) await expect(api.invoke(method as never, args), method).resolves.not.toBeUndefined();
    });

    it('CONTROL: with no owner port the owner operations are still refused in words, not an open door', async () => {
        await expect(hostRemoteApi({ hostName: 'alphar', own: {}, alone: hostAloneApi(ports()) }).invoke('tynnNetwork.workstations', [])).rejects.toThrow('this host cannot reach its Tynn network');
    });
});

/*
 * STEP 2e-3 (Tynn #898, story #915): A MISSING MEMBER IS ABSENT, AND REFUSED POLITELY. genie-host's windowOnly Proxy gave
 * every missing member a throwing function, so host-api's optional checks (`owner().deviceLink?.hosts()`,
 * `if (!deps.workspaceOps.previewAdd)`) never saw it absent, and what answered said "only while a Genie window is open
 * there", which no window can cure since every client is served by genie-host. Nothing gains a refusal (the owner): the
 * refusals that were there say "this host cannot …", and an optional member that is absent gets host-api's own answer.
 */
describe('a member genie-host lacks is absent, and refused as "this host cannot …" (step 2e-3)', () => {
    const noOwner = () => hostAloneApi(ports());

    it('with no owner port, the app keys and the Tynn network are refused as this host cannot, not by a window or a TypeError', async () => {
        await expect(noOwner().invoke('appInbox.state', ['tynn'])).rejects.toThrow('this host cannot manage app keys');
        await expect(noOwner().invoke('tynnNetwork.workstations', [])).rejects.toThrow('this host cannot reach its Tynn network');
    });

    it('with no owner port, the optional device link is absent: host-api answers no remembered hosts', async () => {
        expect(await noOwner().invoke('deviceLink.hosts', [])).toEqual([]);
        expect(await noOwner().invoke('deviceLink.forget', ['wss://beta:7443'])).toBe(false);
    });

    it('with an owner port and no share links, a share-link read answers in the shares API\'s own words', async () => {
        const { s } = owner({ rows: [] });
        const api = hostAloneApi(ports({ owner: hostOwnerOps(s), shares: undefined }));
        expect(await api.invoke('tynnNetwork.shares.list', [null])).toEqual({ ok: false, reason: 'this host cannot share links' });
        expect(await api.invoke('tynnNetwork.shares.revoke', ['l1'])).toEqual({ ok: false, reason: 'this host cannot share links' });
    });

    it('CONTROL: what is given still answers: the share links with no owner port, and no port at all is the old refusal', async () => {
        expect(await noOwner().invoke('tynnNetwork.shares.list', [null])).toEqual({ ok: true, links: [] });
        await expect(hostAloneApi(ports({ shares: undefined })).invoke('appInbox.state', ['tynn'])).rejects.toThrow('this host has no local owner operations');
    });

    it('no genie-host answer sends anyone to a window, and no Proxy invents members', () => {
        const alone = readFileSync('src/main/host-alone-api.ts', 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(alone).not.toMatch(/only while a Genie window is open/);
        expect(alone).not.toMatch(/open Genie on/);
        expect(alone).not.toMatch(/windowOnly/);
        expect(alone).not.toMatch(/new Proxy\(/);
    });
});

describe('local uploads on genie-host', () => {
    async function localCall(createLocalUploads?: () => Promise<unknown>) {
        let accept!: (c: ServerConnection) => void;
        const access = await RemoteAccessHost.open({
            home: dir, hostName: 'alphar', api: hostRemoteApi({ hostName: 'alphar', own: {}, alone: hostAloneApi(ports()) }),
            transport: { onConnection: (l: (c: ServerConnection) => void) => { accept = l; return () => {}; } },
            ...(createLocalUploads ? { createLocalUploads } : {}),
        } as never);
        const pair = inMemoryPair();
        const frames: WireMessage[] = [];
        pair.client.onMessage((text) => frames.push(JSON.parse(text)));
        accept({ ...pair.server, preAuth: { kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false } });
        pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'local' } }));
        await vi.waitFor(() => expect(frames.some((f) => f.kind === 'welcome')).toBe(true));
        pair.client.send(JSON.stringify({ kind: 'call', id: 1, method: 'localUpload.begin', args: [{ purpose: 'draft-file', subtype: 'text', size: 0 }] }));
        await vi.waitFor(() => expect(frames.some((f) => f.kind === 'result' && f.id === 1)).toBe(true));
        pair.client.close();
        await access.close();
        return frames.find((f) => f.kind === 'result' && f.id === 1) as WireMessage & { ok: boolean; reason?: string };
    }

    it('genie-host\'s window connection stages an upload in genie-host\'s own staging area', async () => {
        const area = await LocalStagingArea.open(dir);
        const made: Array<{ dispose(): Promise<void> }> = [];
        const answer = await localCall(async () => { const u = area.createConnection(); made.push(u); return u; });
        expect(answer.ok, answer.reason).toBe(true);
        for (const u of made) await u.dispose();
    });

    it('CONTROL: with no staging configured it is said, not staged', async () => {
        expect(await localCall()).toMatchObject({ ok: false, reason: 'local staging is not configured on this host' });
    });
});

describe('the wiring', () => {
    const host = () => readFileSync('src/main/genie-host.ts', 'utf8');

    it('genie-host\'s files hub sends its own owner\'s events here and no other owner\'s anywhere (Tynn #1043); its three Tynn hubs send theirs here the same way (Tynn #934 task #1474)', () => {
        const src = host();
        expect(src).toMatch(/files = new FilesWatchHub\(\{[^\n]*send: \(owner, event\) => \{ if \(owner === HOST_LOCAL_OWNER\) hostFilesWatches\.deliver\(event\); \},/);
        for (const kind of ['board', 'issues', 'features']) expect(src).toContain(`send: (owner, event) => { if (owner === HOST_LOCAL_OWNER) hostTynnWatches.deliver('${kind}', event); },`);
        expect(src).not.toContain('ownerRoute');
    });

    it('genie-host hands its answers the watch ports and its owner operations, and stages its window\'s uploads', () => {
        const src = host();
        const block = src.slice(src.indexOf('phoneApi = hostAloneApi({'));
        expect(block).toMatch(/filesWatch: hostFilesWatches\.port/);
        expect(block).toMatch(/tynnWatch: hostTynnWatches\.port/);
        expect(block).toMatch(/owner: hostOwnerOps\(\{/);
        const open = src.slice(src.indexOf('RemoteAccessHost.open({'), src.indexOf('RemoteAccessHost.open({') + 600);
        expect(open).toMatch(/createLocalUploads: /);
    });

    it('the device link is one service, the engine link\'s and the owner operations\'', () => {
        const src = host();
        expect(src).toMatch(/const deviceLinkService = new DeviceLinkService\(\{/);
        expect(src).toMatch(/deviceLink: deviceLinkService,/);
    });

    it('genie-host restarts an app source and reads the card; main keeps no copy of either (Tynn #952, 2g-1)', () => {
        const ops = readFileSync('src/main/host-owner-ops.ts', 'utf8');
        expect(ops).toMatch(/restartAppSource/);
        expect(ops).toMatch(/appInboxCardState\(/);
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).not.toMatch(/restartAppSource|appInboxCardState/);
    });
});
