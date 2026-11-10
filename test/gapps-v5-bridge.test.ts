import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { APP_BRIDGE, type ElementDefinition } from '../src/core/catalog.js';
import { appHost } from '../src/core/gapp-origin.js';
import { GAppBridge, GAppCallers, createGAppToolRunner } from '../src/main/gapp-bridge.js';
import { GAppServer } from '../src/main/gapp-server.js';
import { GAPP_STORAGE_QUOTA } from '../src/main/gapp-storage.js';
import { PACKAGE_MANIFEST_FILE } from '../src/core/plugin-integrity.js';
import { GAppBook } from '../src/main/gapps-host.js';
import { genieCatalog } from '../src/main/genie-catalog.js';
import type { Registration } from '../src/main/mcp-tools.js';
import { signPackage } from './plugin-sign-helper.js';

/**
 * GAPPS V2, V5 (Tynn #570; spec .ai/plans/specs/gapps-v2.md, section 4): THE BRIDGE. What an app's window can ask genie-host,
 * over the channel V4 sealed: who it is, a call to an element it was granted (the grant checked, then the element run as
 * Genie runs it), its own isolated store, and the two events. Taking something back counts from the next call.
 */
const pair = generateKeyPairSync('ed25519');
const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
const keys = { [KEY_ID]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const NOTES = 'com.example.notesapp';
const OTHER = 'com.example.otherapp';
const BARE = 'com.example.bareapp';
const catalog = genieCatalog();
const NON_TOOL = catalog.list().find((d) => d.kind !== 'tool' && d.payload.grantable !== false && d.payload.gated !== true)!;

let root: string;
let book: GAppBook;
let bridge: GAppBridge;
let server: GAppServer;
let port: number;
let gone: Set<string>;
let fireCatalog: (revision: number) => void;
const run = vi.fn();
const open: WebSocket[] = [];

async function install(id: string, options: { uses: string[]; storage?: string; scope?: 'workstation' | string[] }): Promise<string> {
    const dir = join(root, 'src', id);
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(join(dir, PACKAGE_MANIFEST_FILE), JSON.stringify({
        id, name: id.split('.').pop(), version: '1.0.0', publisher: { name: 'Example Co', keyId: KEY_ID },
        contributions: [{
            id: `${id}.app`, kind: 'app', docs: { name: 'App', description: 'An app.' },
            reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local', link: { calls: [...APP_BRIDGE.calls], events: [...APP_BRIDGE.events] } },
            permissions: { capabilities: [], network: ['api.example.com', 'cdn.example.com'] },
            payload: { entry: 'app/index.html', uses: options.uses, storage: options.storage ?? 'app' },
        }],
    }));
    await writeFile(join(dir, 'app', 'index.html'), '<!doctype html><title>app</title>');
    await signPackage(dir, pair.privateKey);
    const review = await book.reviewInstall(dir);
    if (!review.ok) throw new Error(review.reason);
    const r = await book.install(dir, { scope: options.scope ?? 'workstation', consent: { digest: review.review.digest, items: review.review.items } });
    if (!r.ok) throw new Error(r.reason);
    return dir;
}

function bridgeOver(quotaBytes?: number): GAppBridge {
    return new GAppBridge({
        book,
        // A preview of an installed app, with that app's grant: what is tested here is that its store is its own.
        previews: { entry: (id) => { const e = book.list().find((x) => x.packageId === id); return e ? { ...e, workspaceId: 'w1', workspaceName: 'w1', publisher: e.grant.publisher, networkAllowed: false } : null; }, appElement: (id) => book.appElement(id) },
        catalog: (id) => (gone.has(id) ? null : catalog.get(id)),
        run,
        onCatalogChange: (fn) => { fireCatalog = fn; return () => undefined; },
        ...(quotaBytes === undefined ? {} : { quotaBytes }),
    });
}

let notesDir: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-v5-'));
    gone = new Set();
    run.mockReset();
    run.mockImplementation(async (def: ElementDefinition, args: unknown) => ({ ok: true, result: { ran: def.id, args } }));
    book = await GAppBook.open({ dir: join(root, 'gapps'), keys, publisherChecksOff: () => false, catalog: () => genieCatalog(), now: () => 1000 });
    notesDir = await install(NOTES, { uses: ['knowledge', 'checkIssues', NON_TOOL.id] });
    await install(OTHER, { uses: ['knowledge'] });
    await install(BARE, { uses: [], storage: 'none', scope: ['w1'] });
    bridge = bridgeOver();
    server = new GAppServer({ book, bridge });
    port = await server.listen(0);
});
afterEach(async () => {
    for (const ws of open.splice(0)) ws.close();
    await server.close();
    bridge.close();
    await rm(root, { recursive: true, force: true });
});

type Reply = { result?: unknown; error?: string; notGranted?: string };

/** A real window's channel: hello with its token, then calls, and the events it heard. */
async function channel(packageId: string): Promise<{ call(method: string, params?: unknown): Promise<Reply>; events: Array<{ event: string; data: Record<string, unknown> }> }> {
    const session = server.openSession(packageId)!;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/.genie/channel`, { headers: { host: appHost(packageId) } });
    open.push(ws);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const waiting = new Map<number, (r: Reply) => void>();
    let next = 1;
    await new Promise<void>((ok, fail) => {
        ws.on('open', () => ws.send(JSON.stringify({ hello: session.token })));
        ws.on('error', fail);
        ws.on('message', (data) => {
            const m = JSON.parse(String(data)) as Reply & { ok?: boolean; id?: number; event?: string; data?: Record<string, unknown> };
            if (m.ok === true) ok();
            else if (typeof m.event === 'string') events.push({ event: m.event, data: m.data ?? {} });
            else if (typeof m.id === 'number') waiting.get(m.id)?.(m);
        });
    });
    return {
        events,
        call: (method, params) => new Promise<Reply>((ok) => {
            const id = next++;
            waiting.set(id, ok);
            ws.send(JSON.stringify({ id, method, params }));
        }),
    };
}

/** Let what the host already sent arrive. */
const settle = () => new Promise((ok) => setTimeout(ok, 50));
const CALL = 'app.call';

describe('app.me', () => {
    it('says who the app is: its id, version, preview, scope and publisher, and what it can call now', async () => {
        const notes = await channel(NOTES);
        expect((await notes.call('app.me')).result).toEqual({
            packageId: NOTES, version: '1.0.0', preview: false, scope: 'workstation', publisher: KEY_ID,
            granted: ['knowledge', 'checkIssues', NON_TOOL.id],
        });
    });

    it('answers for the window\'s own app, whatever the call says', async () => {
        const other = await channel(OTHER);
        expect((await other.call('app.me', { packageId: NOTES })).result).toMatchObject({ packageId: OTHER });
    });
});

describe('app.call', () => {
    it('a granted call runs the element and answers with what it returned', async () => {
        const notes = await channel(NOTES);
        const reply = await notes.call(CALL, { elementId: 'knowledge', args: { q: 'x' }, workspaceId: 'w1' });
        expect(reply.error).toBeUndefined();
        expect(reply.result).toEqual({ ran: 'knowledge', args: { q: 'x' } });
        expect(run).toHaveBeenCalledTimes(1);
        const [def, args, app, workspaceId] = run.mock.calls[0] as [ElementDefinition, unknown, { packageId: string; name: string }, string];
        expect(def.id).toBe('knowledge');
        expect(args).toEqual({ q: 'x' });
        expect(app).toEqual({ packageId: NOTES, name: 'notesapp' });
        expect(workspaceId).toBe('w1');
    });

    it('one not granted gets NotGranted naming the element, and nothing runs', async () => {
        const other = await channel(OTHER);
        const reply = await other.call(CALL, { elementId: 'checkIssues', args: {}, workspaceId: 'w1' });
        expect(reply.notGranted).toBe('checkIssues');
        expect(reply.error).toMatch(/not granted "checkIssues"/);
        expect(run).not.toHaveBeenCalled();
    });

    it('an element no longer in Genie is refused by name, and is not called "not granted"', async () => {
        const notes = await channel(NOTES);
        gone.add('checkIssues');
        const reply = await notes.call(CALL, { elementId: 'checkIssues', workspaceId: 'w1' });
        expect(reply.error).toMatch(/no longer in Genie/);
        expect(reply.notGranted).toBeUndefined();
        expect(run).not.toHaveBeenCalled();
    });

    it('a granted element that is not a tool is refused in words: only tools can be called', async () => {
        const notes = await channel(NOTES);
        const reply = await notes.call(CALL, { elementId: NON_TOOL.id, workspaceId: 'w1' });
        expect(reply.error).toMatch(/only a tool can be called/);
        expect(run).not.toHaveBeenCalled();
    });

    it('a call must carry an element id, and args that are an object', async () => {
        const notes = await channel(NOTES);
        expect((await notes.call(CALL, {})).error).toMatch(/element/);
        expect((await notes.call(CALL, { elementId: 'knowledge', args: [1], workspaceId: 'w1' })).error).toMatch(/args/);
        expect(run).not.toHaveBeenCalled();
    });

    it('what the element refused comes back as its own words', async () => {
        run.mockResolvedValueOnce({ ok: false, error: 'the knowledge base is locked' });
        const notes = await channel(NOTES);
        expect((await notes.call(CALL, { elementId: 'knowledge', workspaceId: 'w1' })).error).toBe('the knowledge base is locked');
    });

    it('a method outside the bridge is refused', async () => {
        const notes = await channel(NOTES);
        expect((await notes.call('app.secrets')).error).toMatch(/not part of the app bridge/);
    });
});

describe('where a call acts', () => {
    it('a workstation grant names its workspace: without one it is refused in words', async () => {
        const notes = await channel(NOTES);
        expect((await notes.call(CALL, { elementId: 'knowledge' })).error).toMatch(/which workspace/);
        expect(run).not.toHaveBeenCalled();
    });

    it('a grant of one workspace acts there when none is named, and is refused anywhere else, by name', async () => {
        await rm(join(root, 'src', OTHER), { recursive: true, force: true });
        await book.uninstall(OTHER);
        await install(OTHER, { uses: ['knowledge'], scope: ['w1'] });
        const other = await channel(OTHER);
        expect((await other.call(CALL, { elementId: 'knowledge' })).error).toBeUndefined();
        expect(run.mock.calls[0]![3]).toBe('w1');
        const outside = await other.call(CALL, { elementId: 'knowledge', workspaceId: 'w2' });
        expect(outside.error).toMatch(/w2 is outside/);
        expect(run).toHaveBeenCalledTimes(1);
    });
});

describe('revocation counts from the next call', () => {
    it('taking an element back refuses its next call; the book keeps it taken back', async () => {
        const notes = await channel(NOTES);
        expect((await notes.call(CALL, { elementId: 'knowledge', workspaceId: 'w1' })).error).toBeUndefined();
        expect(await book.takeBack(NOTES, { element: 'knowledge' })).toBe(true);
        expect((await notes.call(CALL, { elementId: 'knowledge', workspaceId: 'w1' })).notGranted).toBe('knowledge');
        expect((await notes.call(CALL, { elementId: 'checkIssues', workspaceId: 'w1' })).error).toBeUndefined();
        const reopened = await GAppBook.open({ dir: join(root, 'gapps'), keys, publisherChecksOff: () => false, catalog: () => genieCatalog() });
        expect(reopened.list().find((e) => e.packageId === NOTES)!.grant.uses).not.toContain('knowledge');
    });

    it('a call already running when its element is taken back finishes', async () => {
        let finish: (v: unknown) => void = () => undefined;
        run.mockImplementationOnce(() => new Promise((ok) => { finish = ok; }));
        const notes = await channel(NOTES);
        const running = notes.call(CALL, { elementId: 'knowledge', workspaceId: 'w1' });
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
        await book.takeBack(NOTES, { element: 'knowledge' });
        finish({ ok: true, result: 'finished' });
        expect((await running).result).toBe('finished');
    });

    it('an app turned off, or uninstalled, is refused in words at its next call and its next store read', async () => {
        const notes = await channel(NOTES);
        await book.setOn(NOTES, false);
        expect((await notes.call(CALL, { elementId: 'knowledge', workspaceId: 'w1' })).error).toMatch(/turned off/);
        expect((await notes.call('app.storage.list')).error).toMatch(/turned off/);
        await book.setOn(NOTES, true);
        expect((await notes.call(CALL, { elementId: 'knowledge', workspaceId: 'w1' })).error).toBeUndefined();
        await book.uninstall(NOTES);
        expect((await notes.call(CALL, { elementId: 'knowledge', workspaceId: 'w1' })).error).toMatch(/no longer installed/);
    });

    it('taking back a network host leaves the grant without it; an unknown app or element changes nothing', async () => {
        await book.takeBack(NOTES, { host: 'cdn.example.com' });
        expect(book.list().find((e) => e.packageId === NOTES)!.grant.network).toEqual(['api.example.com']);
        expect(await book.takeBack('com.example.nobody', { element: 'knowledge' })).toBe(false);
    });

    it('an update asks again for what was taken back, and only that', async () => {
        await book.takeBack(NOTES, { element: 'knowledge' });
        const review = await book.reviewInstall(notesDir);
        expect(review.ok && review.review.consent).toBe(true);
        expect(review.ok && review.review.items.map((i) => (i.kind === 'element' ? i.id : i.kind))).toEqual(['knowledge']);
    });
});

describe('the isolated store', () => {
    it('keeps a value, lists it, and deletes it; a key never set reads null', async () => {
        const notes = await channel(NOTES);
        expect((await notes.call('app.storage.set', { key: 'a/b', value: { n: 1 } })).error).toBeUndefined();
        await notes.call('app.storage.set', { key: 'c', value: 'text' });
        expect((await notes.call('app.storage.get', { key: 'a/b' })).result).toEqual({ n: 1 });
        expect((await notes.call('app.storage.get', { key: 'never' })).result).toBeNull();
        expect((await notes.call('app.storage.list')).result).toEqual(['a/b', 'c']);
        expect((await notes.call('app.storage.list', { prefix: 'a/' })).result).toEqual(['a/b']);
        expect((await notes.call('app.storage.delete', { key: 'c' })).result).toBe(true);
        expect((await notes.call('app.storage.delete', { key: 'c' })).result).toBe(false);
        expect((await notes.call('app.storage.list')).result).toEqual(['a/b']);
    });

    it('app B cannot read or list app A\'s', async () => {
        const notes = await channel(NOTES);
        const other = await channel(OTHER);
        await notes.call('app.storage.set', { key: 'secret', value: 'A' });
        expect((await notes.call('app.storage.get', { key: 'secret' })).result).toBe('A'); // Control: it is there.
        expect((await other.call('app.storage.get', { key: 'secret' })).result).toBeNull();
        expect((await other.call('app.storage.list')).result).toEqual([]);
    });

    it('A\'s preview has its own store: neither reads the other, and it says it is a preview', async () => {
        const installed = { packageId: NOTES, preview: false };
        const preview = { packageId: NOTES, preview: true };
        await bridge.handle(installed, 'app.storage.set', { key: 'k', value: 'installed' });
        expect(await bridge.handle(installed, 'app.storage.get', { key: 'k' })).toEqual({ result: 'installed' }); // Control.
        expect(await bridge.handle(preview, 'app.storage.get', { key: 'k' })).toEqual({ result: null });
        await bridge.handle(preview, 'app.storage.set', { key: 'k', value: 'preview' });
        expect(await bridge.handle(installed, 'app.storage.get', { key: 'k' })).toEqual({ result: 'installed' });
        expect(await bridge.handle(preview, 'app.storage.get', { key: 'k' })).toEqual({ result: 'preview' });
        expect(await bridge.handle(preview, 'app.me')).toMatchObject({ result: { preview: true } });
    });

    it('a key cannot reach outside the store', async () => {
        const notes = await channel(NOTES);
        const before = await readFile(join(root, 'gapps', 'book.json'), 'utf8');
        for (const key of ['../../book.json', '..\\..\\book.json', '/etc/x', 'C:\\x', 'a\u0000b']) {
            expect((await notes.call('app.storage.set', { key, value: 'over' })).error, key).toBeUndefined();
            expect((await notes.call('app.storage.get', { key })).result, key).toBe('over');
        }
        expect(await readFile(join(root, 'gapps', 'book.json'), 'utf8')).toBe(before);
        expect((await readdir(book.storageDir(NOTES))).length).toBe(5);
    });

    it('a missing or oversized key, or a set with no value, is refused in words', async () => {
        const notes = await channel(NOTES);
        expect((await notes.call('app.storage.get', {})).error).toMatch(/key/);
        expect((await notes.call('app.storage.set', { key: 'k' })).error).toMatch(/value/);
        expect((await notes.call('app.storage.set', { key: 'x'.repeat(1025), value: 1 })).error).toMatch(/1,024/);
    });

    it('survives the window and the host: another bridge reads it', async () => {
        const notes = await channel(NOTES);
        await notes.call('app.storage.set', { key: 'kept', value: [1, 2] });
        const later = bridgeOver();
        expect(await later.handle({ packageId: NOTES, preview: false }, 'app.storage.get', { key: 'kept' })).toEqual({ result: [1, 2] });
        later.close();
    });

    it('an app that declares no storage is told so', async () => {
        const reply = await bridge.handle({ packageId: BARE, preview: false }, 'app.storage.set', { key: 'k', value: 1 });
        expect('error' in reply && reply.error).toMatch(/keeps no data/);
    });

    it('the quota is 50 MB', () => {
        expect(GAPP_STORAGE_QUOTA).toBe(50 * 1024 * 1024);
    });

    it('past the quota a set is refused in words; nothing is half-written and what was there stays', async () => {
        const small = bridgeOver(1000);
        const app = { packageId: NOTES, preview: false };
        expect(await small.handle(app, 'app.storage.set', { key: 'first', value: 'x'.repeat(800) })).toEqual({ result: true });
        const refused = await small.handle(app, 'app.storage.set', { key: 'second', value: 'y'.repeat(800) });
        expect('error' in refused && refused.error).toMatch(/notesapp.*storage is full/);
        expect(await small.handle(app, 'app.storage.get', { key: 'second' })).toEqual({ result: null });
        expect(await small.handle(app, 'app.storage.list')).toEqual({ result: ['first'] });
        expect((await readdir(book.storageDir(NOTES))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
        // A refused overwrite keeps the old value; a smaller overwrite is measured without the value it replaces.
        expect('error' in await small.handle(app, 'app.storage.set', { key: 'first', value: 'z'.repeat(2000) })).toBe(true);
        expect(await small.handle(app, 'app.storage.get', { key: 'first' })).toEqual({ result: 'x'.repeat(800) });
        expect(await small.handle(app, 'app.storage.set', { key: 'first', value: 'w'.repeat(900) })).toEqual({ result: true });
        small.close();
    });

    it('sets at the same moment cannot pass the quota together', async () => {
        const small = bridgeOver(1000);
        const app = { packageId: NOTES, preview: false };
        const replies = await Promise.all([0, 1, 2, 3].map((n) => small.handle(app, 'app.storage.set', { key: `k${n}`, value: 'x'.repeat(400) })));
        expect(replies.filter((r) => 'result' in r)).toHaveLength(2);
        expect(replies.filter((r) => 'error' in r)).toHaveLength(2);
        small.close();
    });
});

describe('the two events', () => {
    it('taking something back tells that app\'s window, with what it can call now; another app\'s hears nothing', async () => {
        const notes = await channel(NOTES);
        const other = await channel(OTHER);
        await book.takeBack(NOTES, { element: 'knowledge' });
        await settle();
        expect(notes.events).toEqual([{ event: 'app.grantChanged', data: { granted: ['checkIssues', NON_TOOL.id], scope: 'workstation' } }]);
        expect(other.events).toEqual([]);
    });

    it('turning an app off tells its window it can call nothing; a change to another app says nothing to it', async () => {
        const notes = await channel(NOTES);
        await book.setOn(OTHER, false);
        await settle();
        expect(notes.events).toEqual([]);
        await book.setOn(NOTES, false);
        await settle();
        expect(notes.events).toEqual([{ event: 'app.grantChanged', data: { granted: [], scope: 'workstation' } }]);
    });

    it('a change in Genie\'s catalog tells every window, each with what it can call now', async () => {
        const notes = await channel(NOTES);
        const other = await channel(OTHER);
        gone.add('knowledge');
        fireCatalog(7);
        await settle();
        expect(notes.events).toEqual([{ event: 'app.catalogChanged', data: { revision: 7, granted: ['checkIssues', NON_TOOL.id] } }]);
        expect(other.events).toEqual([{ event: 'app.catalogChanged', data: { revision: 7, granted: [] } }]);
    });
});

describe('the channel', () => {
    it('after its window closes, nothing more is answered or run', async () => {
        const session = server.openSession(NOTES)!;
        const ws = new WebSocket(`ws://127.0.0.1:${port}/.genie/channel`, { headers: { host: appHost(NOTES) } });
        open.push(ws);
        await new Promise<void>((ok) => { ws.on('open', () => ws.send(JSON.stringify({ hello: session.token }))); ws.once('message', () => ok()); });
        const closed = new Promise<void>((ok) => ws.on('close', () => ok()));
        session.close();
        await closed;
        expect(ws.readyState).toBe(WebSocket.CLOSED);
        expect(run).not.toHaveBeenCalled();
    });
});

describe('the app as a caller of Genie\'s tools', () => {
    const app = { packageId: NOTES, name: 'notesapp' };
    const definition = { ...catalog.get('knowledge')!, payload: { ...catalog.get('knowledge')!.payload, handler: 'knowledge' } };
    const paths = (id: string) => (id === 'w1' ? '/work/one' : null);

    function registration(handler: Registration['handler'], visible?: Registration['visible']): Registration {
        return { definition: { name: 'knowledge' } as never, handler, ...(visible ? { visible } : {}) };
    }

    it('runs the tool\'s own handler, as the app, in that workspace; a terminal id in the args never reaches it', async () => {
        const callers = new GAppCallers(paths);
        let seen: { args: unknown; headers: Record<string, string> } | null = null;
        const runner = createGAppToolRunner({ registrations: () => [registration(async (args, context) => { seen = { args, headers: (context as { headers: Record<string, string> }).headers }; return { text: '{"found":1}', isError: false }; })], callers });
        expect(await runner(definition, { q: 'x', terminalId: 'someone-else' }, app, 'w1')).toEqual({ ok: true, result: { found: 1 } });
        expect(seen!.args).toEqual({ q: 'x' });
        expect(callers.callerFor(seen!.headers['genie-session']!)).toEqual({ agentId: `gapp:${NOTES}`, agentName: 'app "notesapp"', workspaceId: 'w1', workspacePath: '/work/one', kind: 'app' });
    });

    it('a key Genie did not mint is nobody', () => {
        expect(new GAppCallers(paths).callerFor('gapp-session-made-up')).toBeNull();
    });

    it('a workspace Genie does not have is refused in words, and nothing runs', async () => {
        const handler = vi.fn();
        const runner = createGAppToolRunner({ registrations: () => [registration(handler as never)], callers: new GAppCallers(paths) });
        expect(await runner(definition, {}, app, 'w9')).toEqual({ ok: false, error: expect.stringMatching(/w9/) });
        expect(handler).not.toHaveBeenCalled();
    });

    it('resolves the tool at the call, never from an earlier list', async () => {
        let regs: Registration[] = [];
        const runner = createGAppToolRunner({ registrations: () => regs, callers: new GAppCallers(paths) });
        expect(await runner(definition, {}, app, 'w1')).toEqual({ ok: false, error: expect.stringMatching(/unavailable/) });
        regs = [registration(async () => ({ text: 'plain', isError: false }))];
        expect(await runner(definition, {}, app, 'w1')).toEqual({ ok: true, result: 'plain' });
    });

    it('a tool hidden from this caller is refused; the tool\'s own error and a throw come back in words', async () => {
        const callers = new GAppCallers(paths);
        const hidden = createGAppToolRunner({ registrations: () => [registration(vi.fn() as never, () => false)], callers });
        expect(await hidden(definition, {}, app, 'w1')).toEqual({ ok: false, error: expect.stringMatching(/unavailable/) });
        const refusing = createGAppToolRunner({ registrations: () => [registration(async () => ({ text: '{"ok":false,"error":"no such note"}', isError: true }))], callers });
        expect(await refusing(definition, {}, app, 'w1')).toEqual({ ok: false, error: 'no such note' });
        const throwing = createGAppToolRunner({ registrations: () => [registration(async () => { throw new Error('boom'); })], callers });
        expect(await throwing(definition, {}, app, 'w1')).toEqual({ ok: false, error: 'boom' });
    });
});

describe('genie-host wires the bridge (source guard)', () => {
    const source = readFileSync('src/main/genie-host.ts', 'utf8');
    it('the server is given the bridge; the host resolves an app\'s session key; the tool is the MCP server\'s own', () => {
        expect(source).toMatch(/new GAppServer\(\{ book: gappBook, bridge: gappBridge \}\)/);
        expect(source).toMatch(/flowCallers\.callerFor\(key\) \?\? gappCallers\.callerFor\(key\)/);
        expect(source).toMatch(/createGAppToolRunner\(\{ registrations: \(\) => mcp\?\.registrations\(\) \?\? \[\], callers: gappCallers \}\)/);
    });
});
