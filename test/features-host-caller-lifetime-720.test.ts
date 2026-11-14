import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, RESTRICTED_CALL_CONTEXT, type CallContext, type ServerConnection } from '../src/core/remote-protocol.js';
import { HOST_FEATURE_CALLER_LIMIT } from '../src/main/features-host.js';
import { HostPicks } from '../src/main/host-picks.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { CALLER_A, CALLER_B, RECIPIENT, deferred, workspaceCallerFixture, type WorkspaceCallerFixture } from './helpers/features-host-workspace-caller.js';

let f: WorkspaceCallerFixture;
const closers: Array<() => void> = [];
beforeEach(async () => { f = await workspaceCallerFixture(); });
afterEach(async () => { for (const close of closers.splice(0)) close(); await f?.settle(); vi.restoreAllMocks(); await f?.close(); });
const search = (query: string, caller = CALLER_A) => f.act({ kind: 'knowledge.search', query }, caller);
const send = (path: string, caller = CALLER_A) => f.act({ kind: 'inbox.send', to: 'fixture', text: 'picked fixture', attachments: [path] }, caller);
function holdSetting(fail = false) {
    const entered = deferred(), finish = deferred();
    const original = f.settings.set.bind(f.settings);
    vi.spyOn(f.settings, 'set').mockImplementationOnce(async (key, value) => {
        entered.resolve(); await finish.promise;
        if (fail) throw new Error('fixture held write failed');
        return original(key, value);
    });
    return { entered: entered.promise, release: () => finish.resolve(), start: () => f.act({ kind: 'settings.set', key: 'publisher_checks_off', value: true }) };
}
async function door() {
    const contexts: CallContext[] = [];
    let accept!: (connection: ServerConnection) => void;
    const devices = await DeviceStore.open(f.dir, { now: Date.now, random: () => 'fixture-device' });
    new RemoteHost({ hostName: 'fixture-host', devices, baton: new Baton(), pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        api: { ...f.api, invoke: (method, args, context) => { if (context) contexts.push(context); return f.api.invoke(method, args, context); } },
        transport: { onConnection: listener => { accept = listener; return () => {}; } } });
    const connect = async (label: string) => {
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: { label, isOwner: true, workspaceId: null, readonly: false } });
        const client = connectRemote(pair.client, { kind: 'relay' }, label); closers.push(() => client.close());
        expect(await client.ready).toEqual({ ok: true });
        expect(await client.takeBaton({ force: true })).toEqual({ ok: true });
        await client.bridge.features.act({ kind: 'knowledge.search', query: label });
        const context = contexts.at(-1)!;
        expect(context.connectionId).not.toBe(''); return { client, context };
    };
    return { connect };
}

describe('host feature caller state has an owned lifetime and bounded retention (Tynn #720)', () => {
    it('release clears only that caller query and form, leaving the other caller intact', async () => {
        await search('A'); await f.act({ kind: 'knowledge.openAdd', workspaceId: 'work' }); await search('B', CALLER_B);
        f.service.releaseCaller(CALLER_A);
        expect((await f.snapshot()).knowledge).toMatchObject({ query: '', adding: null }); expect((await f.snapshot(CALLER_B)).knowledge.query).toBe('B');
    });
    it('a late action completion cannot put a released caller back in the cache', async () => {
        await search('old caller'); const held = holdSetting(), pending = held.start(); await held.entered;
        f.service.releaseCaller(CALLER_A); held.release(); await pending;
        expect((await f.snapshot()).knowledge.query).toBe('');
    });
    it('closing the service during an action refuses its late result instead of rebuilding state', async () => {
        const held = holdSetting(), pending = held.start(); await held.entered;
        f.service.close(); held.release(); await expect(pending).rejects.toThrow(/feature service is closed/);
    });
    it('same-caller overlapping actions retain both updates in invocation order', async () => {
        await search('kept query'); const held = holdSetting(), first = held.start(); await held.entered;
        const second = f.act({ kind: 'knowledge.openAdd', workspaceId: 'work' });
        await f.settle(); held.release(); await Promise.all([first, second]);
        const data = await f.snapshot(); expect(data.knowledge.query).toBe('kept query'); expect(data.knowledge.adding).not.toBeNull();
    });
    it('a failed queued action keeps its reason and releases the next action in order', async () => {
        const held = holdSetting(true), order: string[] = [];
        const first = held.start().then(() => order.push('unexpected success'), error => { expect(error.message).toBe('fixture held write failed'); order.push('first refused'); });
        await held.entered; const second = search('after failure').then(() => { order.push('second completed'); });
        await f.settle(); held.release(); await Promise.all([first, second]);
        expect(order).toEqual(['first refused', 'second completed']); expect((await f.snapshot()).knowledge.query).toBe('after failure');
    });
    it('the oldest disposable view falls out after the fixed caller retention bound', async () => {
        expect(HOST_FEATURE_CALLER_LIMIT).toBe(64);
        for (let i = 0; i <= HOST_FEATURE_CALLER_LIMIT; i++) await search(`view-${i}`, { ...CALLER_A, connectionId: `bounded-${i}` });
        expect((await f.snapshot({ ...CALLER_A, connectionId: 'bounded-0' })).knowledge.query).toBe('');
        expect((await f.snapshot({ ...CALLER_A, connectionId: `bounded-${HOST_FEATURE_CALLER_LIMIT}` })).knowledge.query).toBe(`view-${HOST_FEATURE_CALLER_LIMIT}`);
    });
    it('a read refreshes a retained caller before another caller needs its slot', async () => {
        for (let i = 0; i < HOST_FEATURE_CALLER_LIMIT; i++) await search(`view-${i}`, { ...CALLER_A, connectionId: `lru-${i}` });
        expect((await f.snapshot({ ...CALLER_A, connectionId: 'lru-0' })).knowledge.query).toBe('view-0');
        await search('new', { ...CALLER_A, connectionId: 'lru-new' });
        expect((await f.snapshot({ ...CALLER_A, connectionId: 'lru-1' })).knowledge.query).toBe('');
        expect((await f.snapshot({ ...CALLER_A, connectionId: 'lru-0' })).knowledge.query).toBe('view-0');
    });
    it('the host accepts an attachment selected by that same admitted local caller', async () => {
        const path = join(f.workspace, 'chosen.txt'); await writeFile(path, 'chosen fixture bytes');
        f.service.picked([path], CALLER_A); await f.answer({ kind: 'inbox.send', to: 'fixture', text: 'picked fixture', attachments: [path] });
        expect(f.inbox.unread(RECIPIENT)).toHaveLength(1); expect(f.inbox.unread(RECIPIENT)[0]?.attachments[0]?.name).toBe('chosen.txt');
    });
    it('one local caller cannot use a path selected in another caller picker', async () => {
        const path = join(f.workspace, 'chosen.txt'); await writeFile(path, 'chosen fixture bytes'); f.service.picked([path], CALLER_A);
        await expect(send(path, CALLER_B)).rejects.toThrow(/was not picked in this window/); expect(f.inbox.unread(RECIPIENT)).toHaveLength(0);
        await send(path); expect(f.inbox.unread(RECIPIENT)).toHaveLength(1);
    });
    it('disconnect releases that caller selected paths along with its view', async () => {
        const path = join(f.workspace, 'chosen.txt'); await writeFile(path, 'chosen fixture bytes'); f.service.picked([path], CALLER_A);
        f.service.releaseCaller(CALLER_A); await expect(send(path)).rejects.toThrow(/was not picked in this window/);
        expect(f.inbox.unread(RECIPIENT)).toHaveLength(0);
    });
    it('each local caller picker retains the existing 500-path bound and its newest pick', async () => {
        const newest = join(f.workspace, 'chosen.txt'); await writeFile(newest, 'chosen fixture bytes');
        const paths = Array.from({ length: 500 }, (_, i) => join(f.workspace, `pick-${i}.txt`));
        f.service.picked([...paths, newest], CALLER_A);
        await expect(send(paths[0]!)).rejects.toThrow(/was not picked in this window/); await send(newest);
        expect(f.inbox.unread(RECIPIENT)).toHaveLength(1);
    });
    it('the host API and wrapper propagate teardown to the owned feature caller', async () => {
        await search('api caller'); f.api.releaseCaller?.(CALLER_A);
        expect((await f.snapshot()).knowledge.query).toBe('');
    });
    it('a real protocol disconnect disposes only the admitted connection view', async () => {
        const d = await door(), a = await d.connect('socket A'), b = await d.connect('socket B');
        a.client.close(); await f.settle();
        expect((await f.snapshot(a.context)).knowledge.query).toBe(''); expect((await f.snapshot(b.context)).knowledge.query).toBe('socket B');
    });
    it('repeated teardown is harmless and a fresh protocol connection starts with an empty view', async () => {
        const d = await door(), old = await d.connect('old socket'); old.client.close(); old.client.close(); await f.settle();
        const next = await d.connect('new socket');
        expect(next.context.connectionId).not.toBe(old.context.connectionId);
        expect((await f.snapshot(old.context)).knowledge.query).toBe(''); expect((await f.snapshot(next.context)).knowledge.query).toBe('new socket');
    });
    it('CONTROL: existing caller queries and forms are isolated before lifetime cleanup', async () => {
        await search('A'); await f.act({ kind: 'knowledge.openAdd', workspaceId: 'work' }); await search('B', CALLER_B);
        expect((await f.snapshot()).knowledge.query).toBe('A'); expect((await f.snapshot()).knowledge.adding).not.toBeNull();
        expect((await f.snapshot(CALLER_B)).knowledge).toMatchObject({ query: 'B', adding: null });
    });
    it('CONTROL: a different caller can complete work while one caller is held', async () => {
        const held = holdSetting(), pending = held.start(); await held.entered;
        try { const answer = await search('independent', CALLER_B); expect(answer.knowledge.query).toBe('independent'); }
        finally { held.release(); await pending; }
    });
    it('CONTROL: generic facts contain no caller query or open form', async () => {
        await search('private query'); await f.act({ kind: 'knowledge.openAdd', workspaceId: 'work' }); const changes = f.changes();
        await f.settings.set('whats_new_seen_version', '2.0.0-beta.63'); await f.settle(); expect(changes.snapshots.length).toBeGreaterThan(0);
        expect(changes.snapshots.every(data => data.knowledge.query === '' && data.knowledge.adding === null)).toBe(true);
    });
    it('CONTROL: nonlocal callers never gain local file-picker authority', async () => {
        const path = join(f.workspace, 'chosen.txt'); await writeFile(path, 'chosen fixture bytes');
        for (const origin of ['remote-window', 'device', 'relay'] as const) {
            const context = { ...CALLER_A, connectionId: `remote-${origin}`, origin };
            await f.api.invoke('features.picked', [[path]], context);
            await expect(send(path, context)).rejects.toThrow(/only from its own window/);
        }
        expect(f.inbox.unread(RECIPIENT)).toHaveLength(0);
    });
    it('CONTROL: missing admitted identity is still refused before a contributor is read', async () => {
        const read = vi.spyOn(f.knowledge, 'summaries');
        await expect(f.api.invoke('features.snapshot', [], RESTRICTED_CALL_CONTEXT)).rejects.toThrow(/admitted caller/);
        expect(read).not.toHaveBeenCalled();
    });
    it('CONTROL: the existing picker primitive itself has a real oldest-entry bound', () => {
        const picks = new HostPicks(2), paths = [1, 2, 3].map(i => join(f.workspace, `primitive-${i}`)); picks.record(paths);
        expect(picks.has(paths[0]!)).toBe(false); expect(picks.has(paths[1]!)).toBe(true); expect(picks.has(paths[2]!)).toBe(true);
    });
});
