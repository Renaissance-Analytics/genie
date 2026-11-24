import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { REMOTE_METHODS, WORKSPACE_SCOPED_METHODS, capabilityOf, inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type RemoteMethod, type WireMessage } from '../src/core/remote-protocol.js';
import { HOST_ALONE_METHODS, HOST_WORKSPACE_LIFECYCLE_METHODS } from '../src/main/host-alone-api.js';
import { buildHostApi } from '../src/main/host-api.js';
import { Registry } from '../src/main/registry.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { Store, type WorkspaceRecord } from '../src/main/store.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/**
 * "LOCATE FOLDER" (host split P7, build spec item 3; ruling R1, 2026-11-23): `workspaces.relocate` tells the host's
 * registry where a workspace's folder IS. Before this there was no workspace-level relocate at all.
 *
 * - The picked folder must exist and be a directory, and must not be, hold or sit inside ANOTHER workspace's folder.
 * - When both the workspace's old folder and the picked one name an envelope id (project.json `id`) and they differ,
 *   it is refused in words. A folder with no project.json is accepted.
 * - On success ONLY the record's `path` changes, and the missing look runs again at once so the flag clears.
 * - Nothing is written when a check fails.
 * - Over the protocol it is a write beside `workspaces.locateRepo` in every list, and the host OWNER's alone: a share
 *   link (a guest of the workspace, or of the whole host) is refused before the host is asked.
 *
 * Fixtures name no person.
 */

type RelocateResult = { ok: true; path: string } | { ok: false; reason: string };
interface RelocatePorts {
    registry: { workspaceStates(): readonly WorkspaceRecord[]; setWorkspacePath(id: string, path: string): Promise<boolean> };
    fs: { isDirectory(path: string): Promise<boolean>; readText(path: string): Promise<string | null> };
    recheck?: () => Promise<void>;
    caseInsensitive?: boolean;
}
interface RelocateModule {
    relocateWorkspaceIn(ports: RelocatePorts, workspaceId: string, picked: string): Promise<RelocateResult>;
    nodeRelocateFs(): RelocatePorts['fs'];
}
interface MissingModule {
    MissingWorkspaces: new (ports: { workspaces(): readonly { id: string; path: string; asleep?: boolean }[]; isDirectory(path: string): Promise<boolean>; schedule(ms: number, fn: () => void): () => void }) => { check(): Promise<void>; isMissing(id: string): boolean };
    nodeIsDirectory(path: string): Promise<boolean>;
}
async function relocateModule(): Promise<RelocateModule> { const path: string = '../src/main/workspace-relocate-host.js'; return import(path) as Promise<RelocateModule>; }
async function missingModule(): Promise<MissingModule> { const path: string = '../src/main/missing-workspaces.js'; return import(path) as Promise<MissingModule>; }

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const manifest = (dir: string, value: unknown) => writeFileSync(join(dir, 'project.json'), JSON.stringify(value));

/**
 * A registry on a real disk: `moic` (the workspace being located, with every optional field a record can carry),
 * `fancy` (another workspace) and an agent in each. `moic`'s recorded folder `old` is NOT made unless a test makes it.
 */
async function estate() {
    const { relocateWorkspaceIn, nodeRelocateFs } = await relocateModule();
    const root = mkdtempSync(join(tmpdir(), 'genie-p7-relocate-'));
    roots.push(root);
    const home = join(root, 'home'); const old = join(root, 'old'); const fresh = join(root, 'new'); const other = join(root, 'other');
    for (const dir of [home, fresh, other, join(other, 'inner'), join(root, 'holder', 'child')]) mkdirSync(dir, { recursive: true });
    const store = new Store(home);
    const registry = new Registry(store);
    await registry.load({ name: 'fixture-host', healthy: true });
    await registry.addWorkspace({ id: 'fancy', path: other });
    await registry.addWorkspace({ id: 'nested', path: join(root, 'holder', 'child') });
    await registry.addWorkspace({ id: 'moic', path: old, governs: ['fancy'], mcpOff: ['slack'], envFile: '.env.local' });
    await registry.register({ workspaceId: 'moic', provider: 'claude', name: 'atlas' });
    await registry.register({ workspaceId: 'fancy', provider: 'claude', name: 'bolt' });

    const writes = vi.spyOn(store, 'writeWorkspaces');
    const agentWrites = vi.spyOn(store, 'writeAgents');
    const order: string[] = [];
    writes.mockImplementation(async (workspaces) => { order.push('write'); await Store.prototype.writeWorkspaces.call(store, workspaces); });
    const read: string[] = [];
    const real = nodeRelocateFs();
    const fs: RelocatePorts['fs'] = { isDirectory: (path) => real.isDirectory(path), readText: (path) => { read.push(path); return real.readText(path); } };
    const recheck = vi.fn(async () => { order.push('recheck'); });
    const records = (): WorkspaceRecord[] => JSON.parse(JSON.stringify(registry.workspaceStates())) as WorkspaceRecord[];
    const onDisk = (): WorkspaceRecord[] => JSON.parse(readFileSync(store.workspacesFile, 'utf8')) as WorkspaceRecord[];
    const agents = () => JSON.stringify(registry.listAgents());
    const relocate = (id: string, picked: string) => relocateWorkspaceIn({ registry, fs, recheck }, id, picked);
    /** A refusal wrote nothing, anywhere. */
    const untouched = (before: WorkspaceRecord[], result: RelocateResult) => {
        expect(result.ok).toBe(false);
        expect(writes).not.toHaveBeenCalled();
        expect(agentWrites).not.toHaveBeenCalled();
        expect(recheck).not.toHaveBeenCalled();
        expect(records()).toEqual(before);
        expect(onDisk()).toEqual(before);
    };
    return { root, home, old, fresh, other, store, registry, writes, agentWrites, order, read, recheck, records, onDisk, agents, relocate, untouched, relocateWorkspaceIn, fs };
}

describe('relocate: only the path changes', () => {
    it('a missing workspace is pointed at the folder picked: its whole record is as before but for `path`, and so is everything else', async () => {
        const e = await estate();
        const before = e.records();
        const agentsBefore = e.agents();
        const mine = before.find((w) => w.id === 'moic')!;
        // The record carries every optional field, so "only path" is measured against all of them.
        expect(mine).toMatchObject({ id: 'moic', path: e.old, governs: ['fancy'], mcpOff: ['slack'], envFile: '.env.local', defaultAgentAuto: true });
        expect(typeof mine.defaultAgentId).toBe('string');

        expect(await e.relocate('moic', e.fresh)).toEqual({ ok: true, path: e.fresh });

        const after = e.records();
        expect(after.find((w) => w.id === 'moic')).toEqual({ ...mine, path: e.fresh });
        expect(after.filter((w) => w.id !== 'moic')).toEqual(before.filter((w) => w.id !== 'moic'));
        expect(after.map((w) => w.id)).toEqual(before.map((w) => w.id));
        expect(e.onDisk()).toEqual(after);
        expect(e.agents()).toBe(agentsBefore);
        expect(e.agentWrites).not.toHaveBeenCalled();
        // One write, through the store, and the missing look asked for after it.
        expect(e.writes).toHaveBeenCalledTimes(1);
        expect(e.recheck).toHaveBeenCalledTimes(1);
        expect(e.order).toEqual(['write', 'recheck']);

        // It survives reopening.
        const again = new Registry(new Store(e.home));
        await again.load({ name: 'fixture-host', healthy: true });
        expect(again.workspace('moic')).toMatchObject({ id: 'moic', path: e.fresh, asleep: false, governs: ['fancy'] });
        expect(again.agentsOf('moic').map((a) => a.name)).toEqual(['atlas']);
    });

    it('the registry tells its listeners', async () => {
        const e = await estate();
        const heard: string[] = [];
        e.registry.subscribe((snapshot) => { heard.push(snapshot.workspaces?.find((w) => w.id === 'moic')?.path ?? ''); });
        expect(await e.relocate('moic', e.fresh)).toMatchObject({ ok: true });
        expect(heard).toEqual([e.fresh]);
    });

    it('the missing flag clears at once, with the real look (it was set before: the control)', async () => {
        const { MissingWorkspaces, nodeIsDirectory } = await missingModule();
        const e = await estate();
        const missing = new MissingWorkspaces({ workspaces: () => e.registry.workspaceStates(), isDirectory: nodeIsDirectory, schedule: () => () => {} });
        e.registry.setMissingWorkspaces((id) => missing.isMissing(id));
        await missing.check();
        expect(missing.isMissing('moic')).toBe(true);
        expect(e.registry.snapshot().workspaces?.find((w) => w.id === 'moic')).toMatchObject({ missing: true });

        expect(await e.relocateWorkspaceIn({ registry: e.registry, fs: e.fs, recheck: () => missing.check() }, 'moic', e.fresh)).toEqual({ ok: true, path: e.fresh });
        // No further look is asked for here: relocate's own was enough.
        expect(missing.isMissing('moic')).toBe(false);
        const row = e.registry.snapshot().workspaces?.find((w) => w.id === 'moic');
        expect(row).toMatchObject({ id: 'moic', path: e.fresh });
        expect('missing' in row!).toBe(false);
    });

    it('works for a workspace that is not missing too', async () => {
        const e = await estate();
        mkdirSync(e.old);
        const mine = e.records().find((w) => w.id === 'moic')!;
        expect(await e.relocate('moic', e.fresh)).toEqual({ ok: true, path: e.fresh });
        expect(e.records().find((w) => w.id === 'moic')).toEqual({ ...mine, path: e.fresh });
    });

    it('a hibernated workspace stays hibernated, and its old folder is not read', async () => {
        const e = await estate();
        mkdirSync(e.old);
        manifest(e.old, { id: 'env_old', name: 'moic' });
        manifest(e.fresh, { id: 'env_other', name: 'something else' });
        expect(await e.registry.setAsleep('moic', true)).toBe(true);
        e.writes.mockClear();
        const mine = e.records().find((w) => w.id === 'moic')!;
        expect(mine.asleep).toBe(true);

        expect(await e.relocate('moic', e.fresh)).toEqual({ ok: true, path: e.fresh });
        expect(e.records().find((w) => w.id === 'moic')).toEqual({ ...mine, path: e.fresh });
        expect(e.read).not.toContain(join(e.old, 'project.json'));
        // Positive control: the picked folder's own project.json was read through the same recorder.
        expect(e.read).toContain(join(e.fresh, 'project.json'));
    });
});

describe('relocate: accepted folders', () => {
    it('a folder with no project.json', async () => {
        const e = await estate();
        mkdirSync(e.old);
        manifest(e.old, { id: 'env_a', name: 'moic' });
        expect(await e.relocate('moic', e.fresh)).toEqual({ ok: true, path: e.fresh });
    });

    it('a folder whose project.json names the SAME envelope id', async () => {
        const e = await estate();
        mkdirSync(e.old);
        manifest(e.old, { id: 'env_a', name: 'moic' });
        manifest(e.fresh, { id: 'env_a', name: 'moic, moved' });
        expect(await e.relocate('moic', e.fresh)).toEqual({ ok: true, path: e.fresh });
    });

    it('a folder whose project.json names no id, or is not JSON', async () => {
        const e = await estate();
        mkdirSync(e.old);
        manifest(e.old, { id: 'env_a', name: 'moic' });
        manifest(e.fresh, { name: 'no id here' });
        expect(await e.relocate('moic', e.fresh)).toEqual({ ok: true, path: e.fresh });
        const second = join(e.root, 'second');
        mkdirSync(second);
        writeFileSync(join(second, 'project.json'), '{ not json');
        expect(await e.relocate('moic', second)).toEqual({ ok: true, path: second });
    });

    it('the old folder is gone, so no id is known for this workspace: a folder that names one is accepted', async () => {
        const e = await estate();
        manifest(e.fresh, { id: 'env_b', name: 'moic' });
        expect(await e.relocate('moic', e.fresh)).toEqual({ ok: true, path: e.fresh });
    });
});

describe('relocate: refused, and nothing is written', () => {
    it('a path that does not exist', async () => {
        const e = await estate();
        const before = e.records();
        const result = await e.relocate('moic', join(e.root, 'nowhere'));
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist') });
        e.untouched(before, result);
    });

    it('a file', async () => {
        const e = await estate();
        const file = join(e.root, 'a-file.txt');
        writeFileSync(file, 'x');
        const before = e.records();
        const result = await e.relocate('moic', file);
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('not a folder') });
        e.untouched(before, result);
    });

    it('another workspace\'s folder', async () => {
        const e = await estate();
        const before = e.records();
        const result = await e.relocate('moic', e.other);
        expect(result).toEqual({ ok: false, reason: `${e.other} is the folder of the workspace fancy` });
        e.untouched(before, result);
    });

    it('a folder INSIDE another workspace\'s folder', async () => {
        const e = await estate();
        const before = e.records();
        const inner = join(e.other, 'inner');
        const result = await e.relocate('moic', inner);
        expect(result).toEqual({ ok: false, reason: `${inner} is inside the folder of the workspace fancy (${e.other})` });
        e.untouched(before, result);
    });

    it('a folder that CONTAINS another workspace\'s folder', async () => {
        const e = await estate();
        const before = e.records();
        const holder = join(e.root, 'holder');
        const result = await e.relocate('moic', holder);
        expect(result).toEqual({ ok: false, reason: `${holder} holds the folder of the workspace nested (${join(holder, 'child')})` });
        e.untouched(before, result);
    });

    it('a sibling whose name only begins like another workspace\'s folder is NOT inside it (the control for the two rows above)', async () => {
        const e = await estate();
        const sibling = `${e.other}-2`;
        mkdirSync(sibling);
        expect(await e.relocate('moic', sibling)).toEqual({ ok: true, path: sibling });
    });

    it('a hibernated workspace\'s folder is another workspace\'s folder too', async () => {
        const e = await estate();
        expect(await e.registry.setAsleep('fancy', true)).toBe(true);
        e.writes.mockClear(); e.agentWrites.mockClear();
        const before = e.records();
        const result = await e.relocate('moic', e.other);
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('is the folder of the workspace fancy') });
        e.untouched(before, result);
    });

    it('a folder whose project.json names a DIFFERENT envelope id, in words', async () => {
        const e = await estate();
        mkdirSync(e.old);
        manifest(e.old, { id: 'env_a', name: 'moic' });
        manifest(e.fresh, { id: 'env_b', name: 'storefront' });
        const before = e.records();
        const result = await e.relocate('moic', e.fresh);
        expect(result).toEqual({ ok: false, reason: 'that folder is storefront, not moic' });
        e.untouched(before, result);
    });

    it('a path that is not a full path, and a workspace nobody has', async () => {
        const e = await estate();
        const before = e.records();
        const relative = await e.relocate('moic', 'new');
        expect(relative).toMatchObject({ ok: false, reason: expect.stringContaining('full path') });
        e.untouched(before, relative);
        const nobody = await e.relocate('nobody', e.fresh);
        expect(nobody).toEqual({ ok: false, reason: 'no workspace "nobody"' });
        e.untouched(before, nobody);
    });

    it('a folder Genie could not look at is refused, not taken as there or as gone', async () => {
        const e = await estate();
        const before = e.records();
        const result = await e.relocateWorkspaceIn({
            registry: e.registry, recheck: e.recheck,
            fs: { isDirectory: async () => { throw Object.assign(new Error('EACCES: fixture'), { code: 'EACCES' }); }, readText: async () => null },
        }, 'moic', e.fresh);
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('could not look') });
        e.untouched(before, result);
    });

    it('the write spy sees a real relocate (the positive control for "nothing written")', async () => {
        const e = await estate();
        expect(e.writes).not.toHaveBeenCalled();
        expect(await e.relocate('moic', e.fresh)).toMatchObject({ ok: true });
        expect(e.writes).toHaveBeenCalledTimes(1);
    });
});

describe('the protocol: `workspaces.relocate` beside `workspaces.locateRepo`', () => {
    const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
    /** A file's top-level statements: each list of methods is one. */
    const statements = (text: string) => text.split(/\n(?=(?:export )?(?:const|type|function|interface) )/);

    it('is named in every list of the protocol that names locateRepo', () => {
        const lists = statements(source('src/core/remote-protocol.ts')).filter((s) => s.includes('\'workspaces.locateRepo\''));
        // Positive control: the three lists are found (the methods, their capabilities, the workspace-scoped ones).
        expect(lists.length).toBeGreaterThanOrEqual(3);
        for (const list of lists) expect(list, list.slice(0, 80)).toContain('\'workspaces.relocate\'');
    });

    it('is named in every list of host-alone-api that names locateRepo', () => {
        const lists = statements(source('src/main/host-alone-api.ts')).filter((s) => s.includes('\'workspaces.locateRepo\''));
        expect(lists.length).toBeGreaterThanOrEqual(1);
        for (const list of lists) expect(list, list.slice(0, 80)).toContain('\'workspaces.relocate\'');
    });

    it('has locateRepo\'s level, is workspace-scoped, and genie-host answers it with no window', () => {
        const method = 'workspaces.relocate' as RemoteMethod;
        expect(REMOTE_METHODS as readonly string[]).toContain(method);
        expect(capabilityOf(method)).toBe('write');
        expect(capabilityOf(method)).toBe(capabilityOf('workspaces.locateRepo'));
        expect(WORKSPACE_SCOPED_METHODS).toContain(method);
        expect(HOST_WORKSPACE_LIFECYCLE_METHODS.has(method)).toBe(true);
        expect(HOST_ALONE_METHODS.has(method)).toBe(true);
    });

    it('the host API dispatches it with the workspace and the path; a host without it says so', async () => {
        const seen: unknown[][] = [];
        const api = buildHostApi({ workspaceOps: { relocate: async (ws: string, path: string) => { seen.push([ws, path]); return { ok: true, path }; } } } as never);
        expect(await api.invoke('workspaces.relocate' as RemoteMethod, ['moic', '/w/moic-2'])).toEqual({ ok: true, path: '/w/moic-2' });
        expect(seen).toEqual([['moic', '/w/moic-2']]);
        const without = buildHostApi({ workspaceOps: {} } as never);
        await expect(without.invoke('workspaces.relocate' as RemoteMethod, ['moic', '/w/moic-2'])).rejects.toThrow(/cannot locate a workspace/);
    });

    it('the window\'s bridges send it: over the wire, and over this machine\'s own link', () => {
        expect(source('src/renderer/remote-bridge.ts')).toMatch(/relocate: \(workspaceId, path\) => answer\('workspaces\.relocate', workspaceId, path\)/);
        expect(source('src/renderer/local-session.ts')).toMatch(/relocate: \(id, path\) => request\(\(ws\) => ws\.relocate!\(id, path\)\)/);
    });
});

describe('who may relocate: the host\'s owner only', () => {
    const RELOCATE = 'workspaces.relocate';
    const snapshot = { agents: [], osAgent: null, workspaces: [{ id: 'tynn', path: '/w/tynn' }, { id: 'fancy', path: '/w/fancy' }], deckItems: [], signals: {}, workstation: { name: 'alphar', healthy: true } };
    let dir = '';
    let devices: DeviceStore;
    let calls: { method: string; args: unknown[] }[];
    let connect: (who: PreAuth) => { call(method: string, ...args: unknown[]): Promise<Extract<WireMessage, { kind: 'result' }>>; next(): Promise<WireMessage>; send(frame: unknown): void };

    function client(t: ClientTransport) {
        const inbox: WireMessage[] = [];
        const waiters: ((m: WireMessage) => void)[] = [];
        t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
        const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
        let id = 0;
        const call = async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next() as Promise<Extract<WireMessage, { kind: 'result' }>>; };
        return { call, next, send: (frame: unknown) => t.send(JSON.stringify(frame)) };
    }

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-p7-relocate-who-'));
        calls = [];
        const api: HostApi = {
            invoke: async (method, args) => { calls.push({ method, args }); return method === 'snapshot' ? snapshot : { ok: true }; },
            onEvent: () => () => {},
            workspaceOfAgent: () => null,
            workspaceOfTerminal: () => null,
            workspacePaths: () => ({ tynn: '/w/tynn', fancy: '/w/fancy' }),
        };
        devices = await DeviceStore.open(dir, { now: () => 1_000_000, random: () => 'tok' });
        const connections: ((c: ReturnType<typeof inMemoryPair>['server']) => void)[] = [];
        new RemoteHost({
            now: () => 1_000_000, confirm: allowEveryPairing, api, hostName: 'alphar', baton: new Baton(),
            pins: new PairingPins({ now: () => 1_000_000 }), devices,
            transport: { onConnection: (cb) => { connections.push(cb); return () => {}; } },
        });
        connect = (who) => { const pair = inMemoryPair(); for (const cb of connections) cb({ ...pair.server, remoteAddress: 'relay:fixture', preAuth: who }); return client(pair.client); };
    });
    afterEach(async () => { await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

    async function admitted(who: PreAuth) {
        const c = connect(who);
        c.send({ kind: 'hello', auth: { kind: 'relay' }, label: who.label });
        let welcome = await c.next();
        while (welcome.kind === 'pairing') welcome = await c.next();
        expect(welcome).toMatchObject({ kind: 'welcome', isOwner: who.isOwner, workspaceId: who.workspaceId });
        if (!who.readonly) expect(await c.call('baton.take')).toMatchObject({ ok: true });
        return c;
    }
    const asked = (method: string) => calls.filter((x) => x.method === method).length;

    const OWNER: PreAuth = { label: 'the owner', isOwner: true, workspaceId: null, readonly: false };
    const WORKSPACE_GUEST: PreAuth = { label: 'a guest', isOwner: false, workspaceId: 'tynn', readonly: false };
    const HOST_GUEST: PreAuth = { label: 'a guest', isOwner: false, workspaceId: null, readonly: false };
    const READONLY_GUEST: PreAuth = { label: 'a guest', isOwner: false, workspaceId: 'tynn', readonly: true };

    it('the owner\'s call reaches the host (the control for every refusal below)', async () => {
        const c = await admitted(OWNER);
        expect(await c.call(RELOCATE, 'tynn', '/w/elsewhere')).toMatchObject({ kind: 'result', ok: true });
        expect(asked(RELOCATE)).toBe(1);
        expect(calls.find((x) => x.method === RELOCATE)?.args).toEqual(['tynn', '/w/elsewhere']);
    });

    it('a share link to the workspace is refused for its OWN workspace, in the owner-only words, and the host is never asked', async () => {
        const c = await admitted(WORKSPACE_GUEST);
        const result = await c.call(RELOCATE, 'tynn', '/w/elsewhere');
        expect(result).toMatchObject({ kind: 'result', ok: false, reason: 'workspaces.relocate changes alphar itself; only its owner can' });
        expect(asked(RELOCATE)).toBe(0);
        // The same guest's Locate repo, inside its workspace, does reach the host: the refusal is this method's, not the guest's.
        expect(await c.call('workspaces.locateRepo', 'tynn', 'r', '/w/tynn/r')).toMatchObject({ kind: 'result', ok: true });
        expect(asked('workspaces.locateRepo')).toBe(1);
    });

    it('a share link to the workspace is refused for another workspace too', async () => {
        const c = await admitted(WORKSPACE_GUEST);
        expect(await c.call(RELOCATE, 'fancy', '/w/elsewhere')).toMatchObject({ kind: 'result', ok: false });
        expect(asked(RELOCATE)).toBe(0);
    });

    it('a guest of the whole host, who is not its owner, is refused the same', async () => {
        const c = await admitted(HOST_GUEST);
        expect(await c.call(RELOCATE, 'tynn', '/w/elsewhere')).toMatchObject({ kind: 'result', ok: false, reason: 'workspaces.relocate changes alphar itself; only its owner can' });
        expect(asked(RELOCATE)).toBe(0);
    });

    it('a read-only link is refused', async () => {
        const c = await admitted(READONLY_GUEST);
        const result = await c.call(RELOCATE, 'tynn', '/w/elsewhere');
        expect(result).toMatchObject({ kind: 'result', ok: false });
        expect((result as { reason: string }).reason).toMatch(/read-only/);
        expect(asked(RELOCATE)).toBe(0);
    });
});
