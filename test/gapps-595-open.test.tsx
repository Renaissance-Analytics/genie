// @vitest-environment happy-dom
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { APP_BRIDGE } from '../src/core/catalog.js';
import { appHost } from '../src/core/gapp-origin.js';
import type { GAppListing, GAppSessionInfo, GAppsApi } from '../src/core/gapps.js';
import { PACKAGE_MANIFEST_FILE } from '../src/core/plugin-integrity.js';
import { GAppServer } from '../src/main/gapp-server.js';
import { GAppWindows, openGAppWindow } from '../src/main/gapp-window.js';
import { dispatchGapps, GAppSessionOwner, gappSessions } from '../src/main/gapps-api.js';
import { GAppBook } from '../src/main/gapps-host.js';
import { genieCatalog } from '../src/main/genie-catalog.js';
import { GAppStoreFlyout, type GAppStoreActions } from '../src/renderer/components/GAppStore.js';
import { signPackage } from './plugin-sign-helper.js';

/**
 * AN INSTALLED APP OPENS (Tynn #595). The store offers Open; the window process asks the host for a session, gives the app
 * its own browser session (`.gen` to the front door, a `.gen` certificate trusted only when Genie's CA signed it for that
 * name) and opens the sealed window from V4. A failure says why, with Retry. scripts/gapp-open-cdp.mjs opens a real
 * installed app in a real window on CI.
 */
const info: GAppSessionInfo = { packageId: 'com.example.notes', url: 'https://com-example-notes.apps.gen/app/index.html', channel: 'wss://com-example-notes.apps.gen/.genie/channel', token: 'tok-1', window: { width: 800, height: 600 } };

function fakeWindow() {
    const events = new Map<string, () => void>();
    const win = {
        on: (e: string, fn: () => void) => { events.set(e, fn); },
        loadURL: vi.fn(async (_url: string): Promise<void> => undefined),
        close: vi.fn(() => { events.get('closed')?.(); }),
        focus: vi.fn(),
        webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() },
    };
    return win;
}

describe('the window process opens an app', () => {
    function rig(over: { caPem?: string | null } = {}) {
        const log: string[] = [];
        const sessions = { open: vi.fn(async (_id: string): Promise<GAppSessionInfo> => info), close: vi.fn() };
        const wins: Array<ReturnType<typeof fakeWindow>> = [];
        const prepareSession = vi.fn(async (id: string) => { log.push(`routed ${id}`); return `session-of-${id}`; });
        const create = vi.fn((options: Record<string, unknown>, session: unknown) => { log.push(`window in ${String(session)}`); void options; const w = fakeWindow(); wins.push(w); return w; });
        const windows = new GAppWindows({ sessions, caPem: () => (over.caPem === undefined ? 'PEM' : over.caPem), prepareSession, create: create as never, preload: '/dist/gapp-preload.cjs' });
        return { windows, sessions, wins, create, prepareSession, log };
    }

    it('asks the host for a session, routes the app\'s own browser session first, then opens the sealed window on it', async () => {
        const r = rig();
        await r.windows.open('com.example.notes');
        expect(r.sessions.open).toHaveBeenCalledWith('com.example.notes');
        expect(r.log).toEqual(['routed com.example.notes', 'window in session-of-com.example.notes']);
        const options = r.create.mock.calls[0]![0] as { webPreferences: Record<string, unknown>; width: number };
        expect(options.width).toBe(800);
        expect(options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, preload: '/dist/gapp-preload.cjs' });
        expect(r.wins[0]!.loadURL).toHaveBeenCalledWith(info.url);
    });

    it('an app already open comes to the front: no second window or session', async () => {
        const r = rig();
        await r.windows.open('com.example.notes');
        await r.windows.open('com.example.notes');
        expect(r.wins).toHaveLength(1);
        expect(r.sessions.open).toHaveBeenCalledTimes(1);
        expect(r.wins[0]!.focus).toHaveBeenCalledTimes(1);
    });

    it('closing the window ends its session, and it can be opened again', async () => {
        const r = rig();
        await r.windows.open('com.example.notes');
        r.wins[0]!.close();
        expect(r.sessions.close).toHaveBeenCalledWith('tok-1');
        await r.windows.open('com.example.notes');
        expect(r.wins).toHaveLength(2);
    });

    it('a page that cannot load says why, closes the window and ends the session', async () => {
        const r = rig();
        r.create.mockImplementationOnce(() => { const w = fakeWindow(); w.loadURL.mockRejectedValueOnce(new Error('ERR_CERT_AUTHORITY_INVALID')); r.wins.push(w); return w; });
        await expect(r.windows.open('com.example.notes')).rejects.toThrow(/ERR_CERT_AUTHORITY_INVALID/);
        expect(r.wins[0]!.close).toHaveBeenCalled();
        expect(r.sessions.close).toHaveBeenCalledWith('tok-1');
        await r.windows.open('com.example.notes');
        expect(r.wins).toHaveLength(2);
    });

    it('a session that cannot be routed gives its token back, and opens nothing', async () => {
        const r = rig();
        r.prepareSession.mockRejectedValueOnce(new Error('no route'));
        await expect(r.windows.open('com.example.notes')).rejects.toThrow('no route');
        expect(r.create).not.toHaveBeenCalled();
        expect(r.sessions.close).toHaveBeenCalledWith('tok-1');
    });

    it('with no CA for .gen it is refused in words, before asking the host for anything', async () => {
        const r = rig({ caPem: null });
        await expect(r.windows.open('com.example.notes')).rejects.toThrow(/certificate/);
        expect(r.sessions.open).not.toHaveBeenCalled();
    });

    it('what the host refuses comes back in its words', async () => {
        const r = rig();
        r.sessions.open.mockRejectedValueOnce(new Error('Notes is refused as tampered'));
        await expect(r.windows.open('com.example.notes')).rejects.toThrow('refused as tampered');
        expect(r.create).not.toHaveBeenCalled();
    });

    it('openGAppWindow reports its load', async () => {
        const w = fakeWindow();
        const opened = openGAppWindow({ ...info, close: vi.fn() }, { create: (() => w) as never, preload: '/p.cjs' });
        expect(opened.window).toBe(w);
        await expect(opened.loaded).resolves.toBeUndefined();
    });
});

describe('the host mints a session for a window', () => {
    const pair = generateKeyPairSync('ed25519');
    const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
    const keys = { [KEY_ID]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    const ID = 'com.example.notes';
    let dir: string;
    let book: GAppBook;
    let server: GAppServer;
    let port: number;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-595-'));
        book = await GAppBook.open({ dir: join(dir, 'gapps'), keys, publisherChecksOff: () => false, catalog: () => genieCatalog() });
        server = new GAppServer({ book, bridge: { handle: async () => ({ result: null }), onEvent: () => () => undefined } });
        port = await server.listen(0);
        const source = join(dir, 'src');
        await mkdir(join(source, 'app'), { recursive: true });
        await writeFile(join(source, PACKAGE_MANIFEST_FILE), JSON.stringify({
            id: ID, name: 'Notes', version: '1.0.0', publisher: { name: 'Example', keyId: KEY_ID },
            contributions: [{
                id: `${ID}.app`, kind: 'app', docs: { name: 'Notes', description: 'Notes.' },
                reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local', link: { calls: [...APP_BRIDGE.calls], events: [...APP_BRIDGE.events] } },
                permissions: { capabilities: [], network: [] }, payload: { entry: 'app/index.html', uses: [] },
            }],
        }));
        await writeFile(join(source, 'app', 'index.html'), '<!doctype html>');
        await signPackage(source, pair.privateKey);
        const review = await book.reviewInstall(source);
        if (!review.ok) throw new Error(review.reason);
        const done = await book.install(source, { scope: 'workstation', consent: { digest: review.review.digest, items: review.review.items } });
        if (!done.ok) throw new Error(done.reason);
    });
    afterEach(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });

    const hello = (token: string) => new Promise<Record<string, unknown>>((ok, fail) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/.genie/channel`, { headers: { host: appHost(ID) } });
        ws.on('open', () => ws.send(JSON.stringify({ hello: token })));
        ws.on('message', (data) => { ok(JSON.parse(String(data)) as Record<string, unknown>); ws.close(); });
        ws.on('error', fail);
    });

    it('a session says where the window goes, and its token is live until it is closed', async () => {
        const sessions = gappSessions(book, server);
        const opened = await sessions.open(ID);
        expect(opened.url).toBe(`https://${appHost(ID)}/app/index.html`);
        expect(await hello(opened.token)).toMatchObject({ ok: true });
        sessions.close(opened.token);
        expect(await hello(opened.token)).toMatchObject({ ok: false });
    });

    it('files changed after install are refused as tampered, and no session is made', async () => {
        const spy = vi.spyOn(server, 'openSession');
        await writeFile(join(book.installedDir(ID)!, 'app', 'index.html'), '<!doctype html><title>changed</title>');
        await expect(gappSessions(book, server).open(ID)).rejects.toThrow(/tampered/);
        expect(spy).not.toHaveBeenCalled();
    });

    it('an app turned off, or one the book does not have, is refused in words', async () => {
        const sessions = gappSessions(book, server);
        await book.setOn(ID, false);
        await expect(sessions.open(ID)).rejects.toThrow(/turned off/);
        await expect(sessions.open('com.example.nobody')).rejects.toThrow(/com\.example\.nobody/);
    });

    it('a window connection owns its sessions: another cannot close them, and they end when it goes', async () => {
        const close = vi.fn();
        const api = { open: vi.fn(async (): Promise<GAppSessionInfo> => info), close };
        const a = new GAppSessionOwner(() => api);
        const b = new GAppSessionOwner(() => api);
        expect(await a.call('openSession', [ID])).toEqual(info);
        await expect(b.call('closeSession', ['tok-1'])).rejects.toThrow(/not this window/);
        expect(close).not.toHaveBeenCalled();
        a.closeAll();
        expect(close).toHaveBeenCalledWith('tok-1');
        await expect(a.call('nope', [])).rejects.toThrow(/Invalid GApp operation/);
        await expect(a.call('openSession', [1])).rejects.toThrow(/Invalid GApp operation/);
    });
});

describe('the store offers Open', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    const notes: GAppListing = { id: 'com.example.notes', name: 'Notes', version: '1.2.0', state: 'installed', dev: false };
    const parked: GAppListing = { id: 'com.example.parked', name: 'Parked', version: '2.0.0', state: 'off', dev: false };
    let open: ReturnType<typeof vi.fn<GAppsApi['open']>>;
    let actions: GAppStoreActions;

    beforeEach(() => {
        g.IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        open = vi.fn<GAppsApi['open']>().mockResolvedValue(undefined);
        actions = { api: { open } as unknown as GAppsApi, pickFolder: vi.fn(async () => null), refresh: vi.fn(async () => undefined), workspace: null };
    });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

    const draw = (apps: readonly GAppListing[]) => act(() => { root.render(<GAppStoreFlyout open onClose={() => undefined} apps={apps} actions={actions} />); });
    const q = (s: string) => document.querySelector<HTMLElement>(s);
    const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((ok) => setTimeout(ok, 0)); });
    const press = async (s: string) => { act(() => { q(s)!.click(); }); await settle(); };

    it('an installed app has Open; it opens that app and shows its progress', async () => {
        let finish: () => void = () => undefined;
        open.mockImplementationOnce(() => new Promise<void>((ok) => { finish = ok; }));
        draw([notes]);
        await press('[data-gapp="com.example.notes"] [data-gapp-action="open"]');
        expect(open).toHaveBeenCalledWith('com.example.notes');
        expect(q('[data-gapp-progress]')!.textContent).toContain('Notes');
        act(() => { finish(); });
        await settle();
        expect(q('[data-gapp-progress]')).toBeNull();
    });

    it('an app turned off cannot be opened, and a launcher has none', () => {
        draw([parked, { id: 'ws', name: 'Shop', version: null, state: 'installed', dev: true, workspace: 'shop' }]);
        expect(q('[data-gapp-action="open"]')).toBeNull();
    });

    it('a failure to open says why, with Retry; Retry opens it', async () => {
        open.mockRejectedValueOnce(new Error('Notes is refused as tampered'));
        draw([notes]);
        await press('[data-gapp-action="open"]');
        expect(q('[data-gapp-failure]')!.textContent).toContain('refused as tampered');
        await press('[data-gapp-action="retry"]');
        expect(open).toHaveBeenCalledTimes(2);
        expect(q('[data-gapp-failure]')).toBeNull();
    });
});

describe('the crossing', () => {
    it('the page asks by id; a host side with no window to open says so', async () => {
        const open = vi.fn(async () => undefined);
        await dispatchGapps(() => ({ open }) as never, 'open', ['com.example.notes']);
        expect(open).toHaveBeenCalledWith('com.example.notes');
        await expect(dispatchGapps(() => ({ open }) as never, 'open', [1])).rejects.toThrow(/Invalid GApp operation/);
        await expect(dispatchGapps(() => ({}) as never, 'open', ['x'])).rejects.toThrow(/window/);
    });

    it('the token never goes to the page: the page\'s operations have no session in them', () => {
        const source = readFileSync(join('src', 'core', 'gapps.ts'), 'utf8');
        expect(source).toMatch(/GAPP_METHODS = \[[^\]]*'gapps\.open'[^\]]*\]/);
        expect(/GAPP_METHODS = \[[^\]]*[sS]ession/.test(source)).toBe(false);
    });

    it('is wired through the window and the host (source guard)', () => {
        const main = readFileSync(join('src', 'main', 'main.ts'), 'utf8');
        expect(main).toMatch(/gapps: \(\) => withGappWindows\(agentEngineLink\?\.client\)/);
        expect(main).toMatch(/gapp-preload\.cjs/);
        const host = readFileSync(join('src', 'main', 'genie-host.ts'), 'utf8');
        expect(host).toMatch(/gappSessions: gappSessions\(gappBook, gappServer\)/);
        const engine = readFileSync(join('src', 'main', 'session-engine-server.ts'), 'utf8');
        expect(engine).toMatch(/new GAppSessionOwner/);
        expect(engine).toMatch(/\.closeAll\(\)/);
    });

    it('an app\'s browser session has the same rules as the Genie Browser\'s, in memory and its own (source guard)', () => {
        const binding = readFileSync(join('src', 'main', 'gapp-windows-electron.ts'), 'utf8');
        expect(binding).toMatch(/guardSession\(/);
        expect(binding).toMatch(/routeSession\(/);
        expect(binding).toMatch(/session\.fromPartition\(`gapp-\$\{appSlug\(packageId\)\}`\)/);
    });

    it('a real window row opens a real installed app, on both platforms', () => {
        const ci = readFileSync(join('.github', 'workflows', 'ci.yml'), 'utf8');
        expect(ci.match(/node scripts\/gapp-open-cdp\.mjs/g)).toHaveLength(2);
    });
});
