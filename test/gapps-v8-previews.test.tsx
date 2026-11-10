// @vitest-environment happy-dom
import { createHash, generateKeyPairSync } from 'node:crypto';
import { request } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { APP_BRIDGE } from '../src/core/catalog.js';
import { appHost, previewHost } from '../src/core/gapp-origin.js';
import type { GAppListing, GAppReview, GAppsApi } from '../src/core/gapps.js';
import { PACKAGE_MANIFEST_FILE } from '../src/core/plugin-integrity.js';
import { GAppBridge } from '../src/main/gapp-bridge.js';
import { GAppPreviews } from '../src/main/gapp-previews.js';
import { GAppServer } from '../src/main/gapp-server.js';
import { GAppWindows } from '../src/main/gapp-window.js';
import { gappSessions, gappsApi } from '../src/main/gapps-api.js';
import { GAppBook } from '../src/main/gapps-host.js';
import { genieCatalog } from '../src/main/genie-catalog.js';
import { GAppStoreFlyout, type GAppStoreActions } from '../src/renderer/components/GAppStore.js';
import { signPackage } from './plugin-sign-helper.js';

/**
 * GAPPS V2, V8 (Tynn #573; spec .ai/plans/specs/gapps-v2.md, section 5): DEV LAUNCHERS AND PREVIEWS. A workspace whose
 * folder holds an app package gets a launcher in the store, always ribboned. It runs as a PREVIEW straight from the
 * folder: its own grant (asked like an install), its own store (never the installed app's), its own origin
 * `<app-slug>.preview.apps.gen`. Unsigned is allowed only here, as the workspace's own work in progress: Unverified, with
 * no network until the person allows it, and not re-checked before each run.
 */
const pair = generateKeyPairSync('ed25519');
const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
const keys = { [KEY_ID]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const ID = 'com.example.notes';

let root: string;
let book: GAppBook;
let previews: GAppPreviews;
let bridge: GAppBridge;
let server: GAppServer;
let port: number;
let asked: Array<{ review: GAppReview; scope: unknown }>;
let verdict: 'allowed' | 'denied';
const workspaces = [{ id: 'w1', name: 'notes', path: '' }, { id: 'w2', name: 'other', path: '' }];

async function appFolder(dir: string, over: { sign?: boolean; uses?: string[]; network?: string[]; version?: string } = {}): Promise<string> {
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(join(dir, PACKAGE_MANIFEST_FILE), JSON.stringify({
        id: ID, name: 'Notes', version: over.version ?? '0.1.0', publisher: over.sign === false ? { name: 'Me' } : { name: 'Example', keyId: KEY_ID },
        contributions: [{
            id: `${ID}.app`, kind: 'app', docs: { name: 'Notes', description: 'Notes.' },
            reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local', link: { calls: [...APP_BRIDGE.calls], events: [...APP_BRIDGE.events] } },
            permissions: { capabilities: [], network: over.network ?? ['api.example.com'] }, payload: { entry: 'app/index.html', uses: over.uses ?? ['knowledge'] },
        }],
    }));
    await writeFile(join(dir, 'app', 'index.html'), '<!doctype html><title>preview</title>');
    if (over.sign !== false) await signPackage(dir, pair.privateKey);
    return dir;
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-v8-'));
    workspaces[0]!.path = join(root, 'ws-notes');
    workspaces[1]!.path = join(root, 'ws-other');
    await mkdir(workspaces[1]!.path, { recursive: true });
    await appFolder(workspaces[0]!.path, { sign: false });
    asked = [];
    verdict = 'allowed';
    book = await GAppBook.open({ dir: join(root, 'gapps'), keys, publisherChecksOff: () => false, catalog: () => genieCatalog() });
    previews = await GAppPreviews.open({ dir: join(root, 'gapps'), workspaces: () => workspaces, keys, catalog: () => genieCatalog(), now: () => 5 });
    bridge = new GAppBridge({ book, previews, catalog: (id) => genieCatalog().get(id), run: async () => ({ ok: true, result: 'ran' }), onCatalogChange: () => () => undefined });
    server = new GAppServer({ book, previews, bridge });
    port = await server.listen(0);
});
afterEach(async () => {
    await server.close();
    bridge.close();
    await rm(root, { recursive: true, force: true });
});

const sessions = () => gappSessions(book, server, { previews, ask: async (review, scope) => { asked.push({ review, scope }); return verdict; } });
function get(path: string, host: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((ok, fail) => {
        const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d: string) => { body += d; });
            res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on('error', fail);
        req.end();
    });
}
/** A real window's channel to a session: hello, then one call. */
function call(session: { token: string; channel: string }, host: string, method: string, params?: unknown): Promise<Record<string, unknown>> {
    return new Promise((ok, fail) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/.genie/channel`, { headers: { host } });
        ws.on('open', () => ws.send(JSON.stringify({ hello: session.token })));
        ws.on('message', (data) => {
            const m = JSON.parse(String(data)) as Record<string, unknown>;
            if (m.ok === true) { ws.send(JSON.stringify({ id: 1, method, params })); return; }
            if (m.ok === false || m.id === 1) { ok(m); ws.close(); }
        });
        ws.on('error', fail);
    });
}

describe('the launcher', () => {
    it('a workspace holding an app package has a launcher, from what Genie read in its folder: Unverified when unsigned', () => {
        expect(previews.list()).toEqual([expect.objectContaining({ packageId: ID, name: 'Notes', version: '0.1.0', workspaceId: 'w1', workspaceName: 'notes', unverified: true, networkAllowed: false, grant: null })]);
    });

    it('a signed one is not Unverified; a folder with no package, or one that is not an app, has none', async () => {
        await rm(workspaces[0]!.path, { recursive: true, force: true });
        await appFolder(workspaces[0]!.path);
        await previews.scan();
        expect(previews.list()[0]).toMatchObject({ unverified: false, publisher: KEY_ID });
        await writeFile(join(workspaces[1]!.path, PACKAGE_MANIFEST_FILE), JSON.stringify({ id: 'com.example.lib', name: 'Lib', version: '1.0.0', publisher: { name: 'x' }, contributions: [] }));
        await previews.scan();
        expect(previews.list().map((p) => p.workspaceId)).toEqual(['w1']);
    });

    it('the store lists it as a ribboned dev launcher of its workspace', async () => {
        const api = gappsApi(book, async () => 'allowed', previews);
        expect(await api.list()).toEqual([{ id: `preview:${ID}`, packageId: ID, name: 'Notes', version: '0.1.0', state: 'installed', dev: true, workspace: 'notes', unverified: true, networkAllowed: false }]);
    });
});

describe('running a preview', () => {
    it('the first run asks like an install, for its own workspace, and nothing runs until it is answered', async () => {
        const opened = await sessions().open(ID, { preview: true });
        expect(asked).toHaveLength(1);
        expect(asked[0]!.scope).toEqual(['w1']);
        expect(asked[0]!.review.items.map((i) => (i.kind === 'element' ? i.id : i.kind === 'network' ? i.host : i.kind))).toEqual(['knowledge', 'api.example.com']);
        expect(opened.url).toBe(`https://${previewHost(ID)}/app/index.html`);
        expect(previews.list()[0]!.grant).toMatchObject({ uses: ['knowledge'], scope: ['w1'], publisher: 'unverified' });
        await sessions().open(ID, { preview: true });
        expect(asked).toHaveLength(1); // Granted once: not asked again.
    });

    it('a denial runs nothing and grants nothing', async () => {
        verdict = 'denied';
        await expect(sessions().open(ID, { preview: true })).rejects.toThrow(/denied/);
        expect(previews.list()[0]!.grant).toBeNull();
    });

    it('its own grant: the installed app\'s grant is not the preview\'s, nor the other way round', async () => {
        await sessions().open(ID, { preview: true });
        expect(book.list()).toEqual([]);
        expect(previews.entry(ID)!.grant).not.toBeNull();
    });

    it('it says it is a preview, and cannot read the installed app\'s store', async () => {
        const installed = join(root, 'installed');
        await appFolder(installed);
        const review = await book.reviewInstall(installed);
        if (!review.ok) throw new Error(review.reason);
        await book.install(installed, { scope: 'workstation', consent: { digest: review.review.digest, items: review.review.items } });
        await bridge.handle({ packageId: ID, preview: false }, 'app.storage.set', { key: 'k', value: 'installed' });
        expect(await bridge.handle({ packageId: ID, preview: false }, 'app.storage.get', { key: 'k' })).toEqual({ result: 'installed' }); // Control.
        const session = await sessions().open(ID, { preview: true });
        expect(await call(session, previewHost(ID), 'app.me')).toMatchObject({ result: { packageId: ID, preview: true, version: '0.1.0', publisher: 'unverified' } });
        expect(await call(session, previewHost(ID), 'app.storage.get', { key: 'k' })).toMatchObject({ result: null });
    });

    it('a preview\'s token is not the installed app\'s, nor its origin', async () => {
        const installed = join(root, 'installed');
        await appFolder(installed);
        const review = await book.reviewInstall(installed);
        if (!review.ok) throw new Error(review.reason);
        await book.install(installed, { scope: 'workstation', consent: { digest: review.review.digest, items: review.review.items } });
        const session = await sessions().open(ID, { preview: true });
        expect(await call(session, previewHost(ID), 'app.me')).toMatchObject({ result: { preview: true } }); // Control: at its own origin.
        expect(await call(session, appHost(ID), 'app.me')).toMatchObject({ ok: false, reason: expect.stringMatching(/not for this app/) });
    });
});

describe('serving a preview', () => {
    it('at its own origin, from the workspace folder, with no network until the person allows it', async () => {
        await sessions().open(ID, { preview: true });
        const page = await get('/app/index.html', previewHost(ID));
        expect(page.status).toBe(200);
        expect(page.body).toContain('preview');
        expect(page.headers['content-security-policy']).toContain("connect-src 'self';");
        expect(page.headers['content-security-policy']).not.toContain('api.example.com');
        await previews.allowNetwork(ID, true);
        expect((await get('/app/index.html', previewHost(ID))).headers['content-security-policy']).toContain('https://api.example.com');
        expect(server.routes().map((r) => r.host)).toContain(previewHost(ID));
    });

    it('an unsigned preview is not re-checked before each run: the workspace is still building it', async () => {
        await sessions().open(ID, { preview: true });
        await writeFile(join(workspaces[0]!.path, 'app', 'index.html'), '<!doctype html><title>edited</title>');
        const page = await get('/app/index.html', previewHost(ID));
        expect(page.status).toBe(200);
        expect(page.body).toContain('edited');
    });

    it('a preview that was never granted is not served, and nothing outside its folder is', async () => {
        expect((await get('/app/index.html', previewHost(ID))).status).toBe(404);
        await sessions().open(ID, { preview: true });
        expect((await get('/../ws-other/x', previewHost(ID))).status).toBe(404);
        expect((await get(`/${PACKAGE_MANIFEST_FILE}`, previewHost(ID))).status).toBe(200); // Control: its own files are.
    });

    it('a network allowance is the person\'s, kept, and taken back', async () => {
        await previews.allowNetwork(ID, true);
        const again = await GAppPreviews.open({ dir: join(root, 'gapps'), workspaces: () => workspaces, keys, catalog: () => genieCatalog() });
        expect(again.entry(ID)!.networkAllowed).toBe(true);
        await previews.allowNetwork(ID, false);
        expect(previews.entry(ID)!.networkAllowed).toBe(false);
    });
});

describe('the window process', () => {
    it('a preview is its own window and its own browser session, beside the installed app\'s', async () => {
        const opened: string[] = [];
        const routed: string[] = [];
        const make = () => ({ on: () => undefined, loadURL: async () => undefined, close: () => undefined, webContents: { on: () => undefined, setWindowOpenHandler: () => undefined } });
        const windows = new GAppWindows<string>({
            sessions: { open: async (id, options) => { opened.push(`${id}${options?.preview ? ' preview' : ''}`); return { packageId: id, url: 'https://x.gen/', channel: 'wss://x.gen/c', token: `t${opened.length}`, window: {} }; }, close: () => undefined },
            caPem: () => 'PEM', prepareSession: async (key) => { routed.push(key); return key; }, create: make as never, preload: '/p.cjs', bringUp: () => undefined,
        });
        await windows.open(ID);
        await windows.open(ID, { preview: true });
        expect(opened).toEqual([ID, `${ID} preview`]);
        expect(routed).toEqual([ID, `preview:${ID}`]);
    });
});

describe('the store', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let rootEl: Root;
    let api: { preview: ReturnType<typeof vi.fn>; allowPreviewNetwork: ReturnType<typeof vi.fn> };
    let actions: GAppStoreActions;
    const launcher: GAppListing = { id: `preview:${ID}`, packageId: ID, name: 'Notes', version: '0.1.0', state: 'installed', dev: true, workspace: 'notes', unverified: true, networkAllowed: false };

    beforeEach(() => {
        g.IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        rootEl = createRoot(host);
        api = { preview: vi.fn(async () => undefined), allowPreviewNetwork: vi.fn(async () => undefined) };
        actions = { api: api as unknown as GAppsApi, pickFolder: vi.fn(async () => null), refresh: vi.fn(async () => undefined), workspace: null };
    });
    afterEach(() => { act(() => rootEl.unmount()); host.remove(); document.body.innerHTML = ''; });

    const q = (s: string) => document.querySelector<HTMLElement>(s);
    const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((ok) => setTimeout(ok, 0)); });
    const draw = (apps: readonly GAppListing[]) => act(() => { rootEl.render(<GAppStoreFlyout open onClose={() => undefined} apps={apps} actions={actions} />); });

    it('a launcher has its ribbon, says Unverified, and offers Run and Allow network; never Uninstall', async () => {
        draw([launcher]);
        const row = `[data-gapp="preview:${ID}"]`;
        expect(q(`${row} [data-gapp-dev-ribbon]`)).not.toBeNull();
        expect(q(`${row} [data-gapp-unverified]`)!.textContent).toMatch(/Unverified/);
        expect(q(`${row} [data-gapp-action="uninstall"]`)).toBeNull();
        act(() => { q(`${row} [data-gapp-action="run-preview"]`)!.click(); });
        await settle();
        expect(api.preview).toHaveBeenCalledWith(ID);
        act(() => { q(`${row} [data-gapp-action="allow-network"]`)!.click(); });
        await settle();
        expect(api.allowPreviewNetwork).toHaveBeenCalledWith(ID, true);
    });

    it('a launcher whose network is allowed offers to block it again; a signed one has no Unverified', () => {
        draw([{ ...launcher, networkAllowed: true }, { ...launcher, id: 'preview:b', packageId: 'b', unverified: false }]);
        expect(q(`[data-gapp="preview:${ID}"] [data-gapp-action="block-network"]`)).not.toBeNull();
        expect(q('[data-gapp="preview:b"] [data-gapp-unverified]')).toBeNull();
    });
});
