import { createHash, generateKeyPairSync } from 'node:crypto';
import { request } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { APP_BRIDGE } from '../src/core/catalog.js';
import { appCsp, appHost, previewHost } from '../src/core/gapp-origin.js';
import { siteNameProblem } from '../src/core/gen-name.js';
import { GenRouterServer } from '../src/main/gen-router-server.js';
import { GAppServer } from '../src/main/gapp-server.js';
import { openGAppWindow } from '../src/main/gapp-window.js';
import { GAPP_MANIFEST_FILE, GAppBook } from '../src/main/gapps-host.js';
import { genieCatalog } from '../src/main/genie-catalog.js';
import { signPackage } from './plugin-sign-helper.js';

/**
 * GAPPS V2, V4 (Tynn #569; spec .ai/plans/specs/gapps-v2.md, approved 2026-11-08): SERVING AN APP, AND ITS WINDOW. The host
 * serves an installed app's own files at `<app-slug>.apps.gen`, its own origin behind the front door, under a strict CSP.
 * The installed copy's digest is checked again as its page loads. The app window is sealed: its preload exposes only
 * `window.genieApp`, and it talks to the host over an app channel with a token minted for that window and that app.
 */
const pair = generateKeyPairSync('ed25519');
const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
const keys = { [KEY_ID]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const NOTES = 'com.example.notesapp';
const OTHER = 'com.example.otherapp';

let root: string;
let book: GAppBook;
let server: GAppServer;
let port: number;

async function install(id: string): Promise<void> {
    const dir = join(root, 'src', id);
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(join(dir, GAPP_MANIFEST_FILE), JSON.stringify({
        id, name: id.split('.').pop(), version: '1.0.0', publisher: { name: 'Example Co', keyId: KEY_ID },
        contributions: [{
            id: `${id}.app`, kind: 'app', docs: { name: 'App', description: 'An app.' },
            reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local', link: { calls: [...APP_BRIDGE.calls], events: [...APP_BRIDGE.events] } },
            permissions: { capabilities: [], network: ['api.example.com'] },
            payload: { entry: 'app/index.html', window: { width: 800, height: 600 }, uses: [], storage: 'app' },
        }],
    }));
    await writeFile(join(dir, 'app', 'index.html'), `<!doctype html><title>${id}</title>`);
    await writeFile(join(dir, 'app', 'app.js'), 'console.log(1);\n');
    await signPackage(dir, pair.privateKey);
    const review = await book.reviewInstall(dir);
    if (!review.ok) throw new Error(review.reason);
    const r = await book.install(dir, { scope: 'workstation', consent: { digest: review.review.digest, items: review.review.items } });
    if (!r.ok) throw new Error(r.reason);
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-v4-'));
    book = await GAppBook.open({ dir: join(root, 'gapps'), keys, publisherChecksOff: () => false, catalog: () => genieCatalog(), now: () => 1000 });
    server = new GAppServer({ book });
    port = await server.listen(0);
    await install(NOTES);
    await install(OTHER);
});
afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
});

const HOST = appHost(NOTES);
function get(path: string, host = HOST, target = port): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((ok, fail) => {
        const req = request({ host: '127.0.0.1', port: target, path, method: 'GET', headers: { host } }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d: string) => { body += d; });
            res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on('error', fail);
        req.end();
    });
}

describe('the origin', () => {
    it('each app has its own host under apps.gen; a preview its own under preview.apps.gen', () => {
        expect(appHost('com.example.notesapp')).toBe('com-example-notesapp.apps.gen');
        expect(previewHost('com.example.notesapp')).toBe('com-example-notesapp.preview.apps.gen');
    });

    it('a very long package id still makes one DNS label, and two long ids do not collide', () => {
        const a = `com.example.${'a'.repeat(80)}.one`;
        const b = `com.example.${'a'.repeat(80)}.two`;
        const label = appHost(a).split('.')[0]!;
        expect(label.length).toBeLessThanOrEqual(63);
        expect(appHost(a)).not.toBe(appHost(b));
    });

    it('`apps` is kept for Genie: no site can take it or anything under it', () => {
        expect(siteNameProblem('apps')).toMatch(/kept for Genie/);
        expect(siteNameProblem('notes.apps')).toMatch(/kept for Genie/);
        expect(siteNameProblem('notes.preview.apps')).toMatch(/kept for Genie/);
        expect(siteNameProblem('apparatus')).toBeNull();
    });

    it('the CSP limits it to its own origin and its granted hosts', () => {
        const csp = appCsp(['api.example.com']);
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("connect-src 'self' https://api.example.com wss://api.example.com");
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(appCsp([])).toContain("connect-src 'self';");
    });
});

describe('serving the installed copy', () => {
    it('an installed app\'s page is served at its origin, under its CSP', async () => {
        const root_ = await get('/');
        expect(root_.status).toBe(302);
        expect(root_.headers.location).toBe('/app/index.html');
        const page = await get('/app/index.html');
        expect(page.status).toBe(200);
        expect(page.body).toContain(NOTES);
        expect(page.headers['content-type']).toMatch(/text\/html/);
        expect(page.headers['content-security-policy']).toContain('https://api.example.com');
        expect(page.headers['x-content-type-options']).toBe('nosniff');
        expect((await get('/app/app.js')).headers['content-type']).toMatch(/javascript/);
    });

    it('is reached through the front door, with its CSP intact', async () => {
        expect(server.routes()).toContainEqual({ host: HOST, target: `127.0.0.1:${port}` });
        const door = new GenRouterServer(() => server.routes());
        const doorPort = await door.listen(0);
        try {
            const page = await get('/app/index.html', HOST, doorPort);
            expect(page.status).toBe(200);
            expect(page.headers['content-security-policy']).toContain("default-src 'self'");
        } finally {
            await new Promise<void>((r) => door.close(r));
        }
    });

    it('nothing outside the app\'s own files is served', async () => {
        for (const path of ['/../book.json', '/..%2f..%2fbook.json', '/app/../../book.json', '/app/%2e%2e/%2e%2e/book.json', '/storage/x']) {
            expect((await get(path)).status, path).toBe(404);
        }
    });

    it('an app turned off is not served, and neither is a host with no app; only GET and HEAD are', async () => {
        await book.setOn(NOTES, false);
        expect(server.routes().map((r) => r.host)).not.toContain(HOST);
        expect((await get('/app/index.html')).status).toBe(404);
        expect((await get('/app/index.html', 'nobody.apps.gen')).status).toBe(404);
        await book.setOn(NOTES, true);
        const post = await new Promise<number>((ok, fail) => {
            const req = request({ host: '127.0.0.1', port, path: '/app/index.html', method: 'POST', headers: { host: HOST } }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
            req.on('error', fail);
            req.end();
        });
        expect(post).toBe(405);
    });

    it('a file changed after install: its page is refused as tampered as it loads', async () => {
        expect((await get('/app/index.html')).status).toBe(200);
        await writeFile(join(book.installedDir(NOTES)!, 'app', 'app.js'), 'console.log("changed");\n');
        const page = await get('/app/index.html');
        expect(page.status).toBe(403);
        expect(page.body).toMatch(/tampered/);
        // CONTROL: another app, untouched, still loads.
        expect((await get('/app/index.html', appHost(OTHER))).status).toBe(200);
    });
});

describe('the app channel', () => {
    /** Open the channel on an app's host and say hello with a token: what the host answers. */
    function hello(host: string, token: string | null): Promise<{ answer: Record<string, unknown>; closed: Promise<void> }> {
        return new Promise((ok, fail) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/.genie/channel`, { headers: { host } });
            const closed = new Promise<void>((done) => ws.on('close', () => done()));
            ws.on('open', () => { if (token !== null) ws.send(JSON.stringify({ hello: token })); else ws.send(JSON.stringify({ nothing: true })); });
            ws.on('message', (data) => { const answer = JSON.parse(String(data)) as Record<string, unknown>; ok({ answer, closed }); ws.close(); });
            ws.on('error', fail);
        });
    }

    it('a token minted for this window and this app is accepted', async () => {
        const session = server.openSession(NOTES);
        expect(session).not.toBeNull();
        const { answer } = await hello(HOST, session!.token);
        expect(answer).toMatchObject({ ok: true, packageId: NOTES });
    });

    it('a token minted for another app is refused', async () => {
        const other = server.openSession(OTHER)!;
        const { answer, closed } = await hello(HOST, other.token);
        expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/not for this app/) });
        await closed;
    });

    it('a token after its window closed is refused; so is none, or one Genie never made', async () => {
        const session = server.openSession(NOTES)!;
        session.close();
        expect((await hello(HOST, session.token)).answer).toMatchObject({ ok: false });
        expect((await hello(HOST, null)).answer).toMatchObject({ ok: false });
        expect((await hello(HOST, 'made-up')).answer).toMatchObject({ ok: false });
    });

    it('a session says where its window goes and how big; an app turned off has none', async () => {
        const session = server.openSession(NOTES)!;
        expect(session.url).toBe(`https://${HOST}/app/index.html`);
        expect(session.channel).toBe(`wss://${HOST}/.genie/channel`);
        expect(session.window).toMatchObject({ width: 800, height: 600 });
        await book.setOn(NOTES, false);
        expect(server.openSession(NOTES)).toBeNull();
    });
});

describe('the app window is sealed', () => {
    function fakeWindow() {
        const events = new Map<string, (...args: unknown[]) => void>();
        const content = new Map<string, (...args: unknown[]) => void>();
        const made: { options?: Record<string, any>; loaded?: string; openHandler?: (d: { url: string }) => { action: string } } = {};
        const create = (options: Record<string, any>) => {
            made.options = options;
            return {
                on: (e: string, fn: (...a: unknown[]) => void) => { events.set(e, fn); },
                loadURL: async (url: string) => { made.loaded = url; },
                webContents: {
                    on: (e: string, fn: (...a: unknown[]) => void) => { content.set(e, fn); },
                    setWindowOpenHandler: (fn: (d: { url: string }) => { action: string }) => { made.openHandler = fn; },
                },
            };
        };
        return { create, made, events, content };
    }

    const session = () => { const s = server.openSession(NOTES)!; return { ...s, close: vi.fn(s.close) }; };

    it('sandboxed, isolated, no Node; the channel and its token and no other credential reach its preload', () => {
        const f = fakeWindow();
        const s = session();
        openGAppWindow(s, { create: f.create as never, preload: '/x/gapp-preload.cjs' });
        const prefs = f.made.options!.webPreferences;
        expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, preload: '/x/gapp-preload.cjs' });
        expect(prefs.additionalArguments).toEqual([`--genie-app-channel=${s.channel}`, `--genie-app-token=${s.token}`]);
        expect(JSON.stringify(f.made.options)).not.toMatch(/engine|GENIE_MCP/i);
        expect(f.made.options).toMatchObject({ width: 800, height: 600 });
        expect(f.made.loaded).toBe(s.url);
    });

    it('it cannot navigate off its origin or open other windows', () => {
        const f = fakeWindow();
        openGAppWindow(session(), { create: f.create as never, preload: '/x/p.cjs' });
        const navigate = f.content.get('will-navigate')!;
        const off = { preventDefault: vi.fn() };
        navigate(off, 'https://evil.example/');
        expect(off.preventDefault).toHaveBeenCalled();
        const same = { preventDefault: vi.fn() };
        navigate(same, `https://${HOST}/app/other.html`);
        expect(same.preventDefault).not.toHaveBeenCalled();
        expect(f.made.openHandler!({ url: 'https://evil.example/' })).toEqual({ action: 'deny' });
    });

    it('closing the window ends its session', () => {
        const f = fakeWindow();
        const s = session();
        openGAppWindow(s, { create: f.create as never, preload: '/x/p.cjs' });
        f.events.get('closed')!();
        expect(s.close).toHaveBeenCalled();
    });
});
