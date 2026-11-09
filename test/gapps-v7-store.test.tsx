// @vitest-environment happy-dom
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_BRIDGE } from '../src/core/catalog.js';
import { GAPP_METHODS, type GAppListing, type GAppReview, type GAppsApi } from '../src/core/gapps.js';
import { PACKAGE_MANIFEST_FILE } from '../src/core/plugin-integrity.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { capabilityOf, inMemoryPair, REMOTE_METHODS, type RemoteMethod, type ServerConnection } from '../src/core/remote-protocol.js';
import { dispatchGapps, gappsApi } from '../src/main/gapps-api.js';
import { GAppBook } from '../src/main/gapps-host.js';
import { genieCatalog } from '../src/main/genie-catalog.js';
import { buildHostApi } from '../src/main/host-api.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { GAppStoreFlyout, type GAppStoreActions } from '../src/renderer/components/GAppStore.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { signPackage } from './plugin-sign-helper.js';

/**
 * GAPPS V2, V7 (Tynn #572; spec .ai/plans/specs/gapps-v2.md): THE GAPP STORE'S ACTIONS, over the book V3 built. Install shows
 * the review, each element by Genie's catalog name and each network host, and installs what the person consented to. Every
 * action shows progress, then success, or the failure in words with Retry. Uninstall asks first. A local window's actions
 * only: another machine never installs an app here.
 */
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;

const notes: GAppListing = { id: 'com.example.notes', name: 'Notes', version: '1.2.0', state: 'installed', dev: false };
const parked: GAppListing = { id: 'com.example.parked', name: 'Parked', version: '2.0.0', state: 'off', dev: false };
const launcher: GAppListing = { id: 'ws-shop', name: 'Shop', version: null, state: 'installed', dev: true, workspace: 'shop' };
const review: GAppReview = {
    packageId: 'com.example.new', name: 'New App', version: '1.0.0', digest: 'd1', publisher: 'sha256:abc', update: false, consent: true,
    items: [
        { kind: 'element', id: 'knowledge', name: 'Knowledge base', description: 'Search and add what Genie knows.' },
        { kind: 'network', host: 'api.example.com' },
    ],
};

type Fake = { [K in keyof GAppsApi]: ReturnType<typeof vi.fn<GAppsApi[K]>> };
function fakeApi(): Fake {
    return {
        list: vi.fn<GAppsApi['list']>().mockResolvedValue([]),
        review: vi.fn<GAppsApi['review']>().mockResolvedValue(review),
        install: vi.fn<GAppsApi['install']>().mockResolvedValue(notes),
        setOn: vi.fn<GAppsApi['setOn']>().mockResolvedValue(undefined),
        uninstall: vi.fn<GAppsApi['uninstall']>().mockResolvedValue(undefined),
    };
}

let api: Fake;
let actions: GAppStoreActions;
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    api = fakeApi();
    actions = { api, pickFolder: vi.fn(async () => '/packages/new'), refresh: vi.fn(async () => undefined), workspace: { id: 'w1', name: 'shop' } };
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const draw = (apps: readonly GAppListing[] = [notes], given: GAppStoreActions | undefined = actions) => act(() => {
    root.render(<GAppStoreFlyout open onClose={() => undefined} apps={apps} {...(given ? { actions: given } : {})} />);
});
const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((ok) => setTimeout(ok, 0)); });
async function press(action: string, within = ''): Promise<void> {
    const button = q(`${within} [data-gapp-action="${action}"]`.trim());
    expect(button, action).not.toBeNull();
    act(() => { button!.click(); });
    await settle();
}
const startInstall = () => press('install-from-folder');
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe('install', () => {
    it('shows the review: each element by its catalog name, each host, the publisher; nothing is installed yet', async () => {
        draw();
        await startInstall();
        expect(api.review).toHaveBeenCalledWith('/packages/new');
        const text = q('[data-gapp-review]')!.textContent!;
        expect(text).toContain('New App');
        expect(text).toContain('Knowledge base');
        expect(text).toContain('Search and add what Genie knows.');
        expect(text).toContain('api.example.com');
        expect(text).toContain('sha256:abc');
        expect(api.install).not.toHaveBeenCalled();
    });

    it('installs what was reviewed, in this workspace by default, then says so and reads the list again', async () => {
        draw();
        await startInstall();
        await press('consent');
        expect(api.install).toHaveBeenCalledWith('/packages/new', { scope: ['w1'], consent: { digest: 'd1', items: review.items } });
        expect(q('[data-gapp-success]')!.textContent).toContain('New App');
        expect(q('[data-gapp-review]')).toBeNull();
        expect(actions.refresh).toHaveBeenCalled();
    });

    it('every workspace is the person\'s choice', async () => {
        draw();
        await startInstall();
        act(() => { q('[data-gapp-scope] [role="switch"]')!.click(); });
        await press('consent');
        expect(api.install.mock.calls[0]![1].scope).toBe('workstation');
    });

    it('with no workspace on screen it is the whole workstation, and there is nothing to choose', async () => {
        draw([notes], { ...actions, workspace: null });
        await startInstall();
        expect(q('[data-gapp-scope] [role="switch"]')).toBeNull();
        await press('consent');
        expect(api.install.mock.calls[0]![1].scope).toBe('workstation');
    });

    it('Cancel installs nothing; choosing no folder does nothing', async () => {
        draw();
        await startInstall();
        await press('cancel');
        expect(q('[data-gapp-review]')).toBeNull();
        expect(api.install).not.toHaveBeenCalled();
        (actions.pickFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
        api.review.mockClear();
        await startInstall();
        expect(api.review).not.toHaveBeenCalled();
    });

    it('a package the host refuses is shown in the host\'s words, with Retry; Retry reads it again', async () => {
        api.review.mockRejectedValueOnce(new Error('Notes is unsigned: unsigned plugins are not installed'));
        draw();
        await startInstall();
        expect(q('[data-gapp-failure]')!.textContent).toContain('unsigned plugins are not installed');
        await press('retry');
        expect(api.review).toHaveBeenCalledTimes(2);
        expect(q('[data-gapp-failure]')).toBeNull();
        expect(q('[data-gapp-review]')).not.toBeNull();
    });

    it('a failed install shows the failure in words with Retry; Retry tries again and succeeds', async () => {
        api.install.mockRejectedValueOnce(new Error('New App changed since the person reviewed it; nothing was installed.'));
        draw();
        await startInstall();
        await press('consent');
        expect(q('[data-gapp-failure]')!.textContent).toContain('nothing was installed');
        expect(q('[data-gapp-success]')).toBeNull();
        await press('retry');
        expect(api.install).toHaveBeenCalledTimes(2);
        expect(q('[data-gapp-failure]')).toBeNull();
        expect(q('[data-gapp-success]')).not.toBeNull();
    });

    it('shows progress while it reads the package and while it installs, and nothing else can start', async () => {
        const reading = deferred<GAppReview>();
        api.review.mockReturnValueOnce(reading.promise);
        draw();
        await startInstall();
        expect(q('[data-gapp-progress]')).not.toBeNull();
        expect((q('[data-gapp-action="install-from-folder"]') as HTMLButtonElement).disabled).toBe(true);
        expect((q('[data-gapp-action="uninstall"]') as HTMLButtonElement).disabled).toBe(true);
        reading.resolve(review);
        await settle();
        expect(q('[data-gapp-progress]')).toBeNull();
        const installing = deferred<GAppListing>();
        api.install.mockReturnValueOnce(installing.promise);
        await press('consent');
        expect(q('[data-gapp-progress]')).not.toBeNull();
        installing.resolve(notes);
        await settle();
        expect(q('[data-gapp-progress]')).toBeNull();
    });
});

describe('update', () => {
    it('asking for nothing new installs straight away, with no review and no consent', async () => {
        api.review.mockResolvedValueOnce({ ...review, update: true, consent: false, items: [] });
        draw();
        await startInstall();
        expect(q('[data-gapp-review]')).toBeNull();
        expect(api.install).toHaveBeenCalledWith('/packages/new', { scope: 'workstation' });
        expect(q('[data-gapp-success]')).not.toBeNull();
    });

    it('asking for something new shows only that, and offers no choice of workspace: the grant keeps its own', async () => {
        const items = [{ kind: 'network' as const, host: 'new.example.com' }];
        api.review.mockResolvedValueOnce({ ...review, update: true, items });
        draw();
        await startInstall();
        const text = q('[data-gapp-review]')!.textContent!;
        expect(text).toContain('new.example.com');
        expect(text).not.toContain('Knowledge base');
        expect(q('[data-gapp-scope]')).toBeNull();
        await press('consent');
        expect(api.install).toHaveBeenCalledWith('/packages/new', { scope: 'workstation', consent: { digest: 'd1', items } });
    });
});

describe('turn off and on', () => {
    it('an installed app turns off; one that is off turns on', async () => {
        draw([notes, parked]);
        await press('turn-off', '[data-gapp="com.example.notes"]');
        expect(api.setOn).toHaveBeenCalledWith('com.example.notes', false);
        expect(q('[data-gapp-success]')).not.toBeNull();
        expect(actions.refresh).toHaveBeenCalled();
        await press('turn-on', '[data-gapp="com.example.parked"]');
        expect(api.setOn).toHaveBeenCalledWith('com.example.parked', true);
    });

    it('a failure is in words with Retry', async () => {
        api.setOn.mockRejectedValueOnce(new Error('Genie could not reach the host'));
        draw();
        await press('turn-off');
        expect(q('[data-gapp-failure]')!.textContent).toContain('could not reach the host');
        await press('retry');
        expect(api.setOn).toHaveBeenCalledTimes(2);
        expect(q('[data-gapp-failure]')).toBeNull();
    });
});

describe('uninstall', () => {
    it('asks first, saying it removes the app and its data; Cancel removes nothing', async () => {
        draw();
        await press('uninstall');
        expect(q('[data-gapp-confirm]')!.textContent).toMatch(/removes the app and its data/i);
        expect(q('[data-gapp-confirm]')!.textContent).toContain('Notes');
        expect(api.uninstall).not.toHaveBeenCalled();
        await press('cancel-uninstall');
        expect(q('[data-gapp-confirm]')).toBeNull();
        expect(api.uninstall).not.toHaveBeenCalled();
    });

    it('confirming removes it, then says so', async () => {
        draw();
        await press('uninstall');
        await press('confirm-uninstall');
        expect(api.uninstall).toHaveBeenCalledWith('com.example.notes');
        expect(q('[data-gapp-confirm]')).toBeNull();
        expect(q('[data-gapp-success]')!.textContent).toContain('Notes');
    });

    it('a failure is in words with Retry', async () => {
        api.uninstall.mockRejectedValueOnce(new Error('com.example.notes could not be removed'));
        draw();
        await press('uninstall');
        await press('confirm-uninstall');
        expect(q('[data-gapp-failure]')!.textContent).toContain('could not be removed');
        await press('retry');
        expect(api.uninstall).toHaveBeenCalledTimes(2);
    });
});

describe('what the store shows', () => {
    it('reads the list again each time it opens', () => {
        draw();
        expect(actions.refresh).toHaveBeenCalledTimes(1);
    });

    it('a launcher of a workspace\'s app has no install-book actions', () => {
        draw([launcher]);
        expect(q('[data-gapp="ws-shop"] [data-gapp-action]')).toBeNull();
    });

    it('a window with no actions only lists', () => {
        draw([notes], undefined as never);
        expect(q('[data-gapp-store]')).not.toBeNull();
        expect(q('[data-gapp-action]')).toBeNull();
    });

    it('every action is a react-fancy Button', () => {
        const source = readFileSync(join('src', 'renderer', 'components', 'GAppStore.tsx'), 'utf8');
        expect(source).toMatch(/import \{[^}]*\bButton\b[^}]*\} from '@particle-academy\/react-fancy'/);
        expect(source).not.toMatch(/<button\b/);
    });
});

describe('the host side, over the real book', () => {
    const pair = generateKeyPairSync('ed25519');
    const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
    const keys = { [KEY_ID]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    const ID = 'com.example.notes';
    let dir: string;
    let book: GAppBook;
    let source: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-v7-'));
        book = await GAppBook.open({ dir: join(dir, 'gapps'), keys, publisherChecksOff: () => false, catalog: () => genieCatalog() });
        source = join(dir, 'src');
        await mkdir(join(source, 'app'), { recursive: true });
        await writeFile(join(source, PACKAGE_MANIFEST_FILE), JSON.stringify({
            id: ID, name: 'Notes', version: '1.0.0', publisher: { name: 'Example', keyId: KEY_ID },
            contributions: [{
                id: `${ID}.app`, kind: 'app', docs: { name: 'Notes', description: 'Notes.' },
                reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local', link: { calls: [...APP_BRIDGE.calls], events: [...APP_BRIDGE.events] } },
                permissions: { capabilities: [], network: [] }, payload: { entry: 'app/index.html', uses: ['knowledge'] },
            }],
        }));
        await writeFile(join(source, 'app', 'index.html'), '<!doctype html>');
        await signPackage(source, pair.privateKey);
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('reviews, installs, lists, turns off, and uninstalls', async () => {
        const gapps = gappsApi(book);
        expect(await gapps.list()).toEqual([]);
        const seen = await gapps.review(source);
        expect(seen.items[0]).toMatchObject({ kind: 'element', id: 'knowledge', name: genieCatalog().get('knowledge')!.docs.name });
        expect(await gapps.install(source, { scope: ['w1'], consent: { digest: seen.digest, items: seen.items } })).toEqual({ id: ID, name: 'Notes', version: '1.0.0', state: 'installed', dev: false });
        await gapps.setOn(ID, false);
        expect((await gapps.list())[0]).toMatchObject({ id: ID, state: 'off' });
        await gapps.uninstall(ID);
        expect(await gapps.list()).toEqual([]);
    });

    it('what the book refuses is thrown in the book\'s words', async () => {
        const gapps = gappsApi(book);
        await expect(gapps.review(join(dir, 'nowhere'))).rejects.toThrow(/no readable genie-package\.json/);
        await expect(gapps.install(source, { scope: 'workstation' })).rejects.toThrow(/needs the person's consent/);
        await expect(gapps.setOn('com.example.nobody', true)).rejects.toThrow(/com\.example\.nobody/);
        await expect(gapps.uninstall('com.example.nobody')).rejects.toThrow(/com\.example\.nobody/);
    });
});

describe('the actions cross to the host only from a local window', () => {
    const OK_CONSENT = { digest: 'd', items: [] };

    it('the operations are checked by name and shape before the host sees them', async () => {
        const gapps = fakeApi();
        const call = (op: unknown, args: unknown[]) => dispatchGapps(() => gapps, op, args);
        await call('list', []);
        expect(gapps.list).toHaveBeenCalled();
        await call('install', ['/p', { scope: ['w1'], consent: OK_CONSENT }]);
        expect(gapps.install).toHaveBeenCalledWith('/p', { scope: ['w1'], consent: OK_CONSENT });
        await call('install', ['/p', { scope: 'workstation' }]);
        expect(gapps.install).toHaveBeenLastCalledWith('/p', { scope: 'workstation' });
        for (const [op, args] of [['nope', []], ['constructor', []], ['review', [1]], ['install', ['/p']], ['install', ['/p', { scope: 'somewhere' }]], ['install', ['/p', { scope: [1] }]], ['install', ['/p', { scope: 'workstation', consent: { digest: 1, items: [] } }]], ['setOn', ['x', 'yes']], ['uninstall', [{}]]] as Array<[string, unknown[]]>) {
            await expect(call(op, args), `${op} ${JSON.stringify(args)}`).rejects.toThrow(/Invalid GApp operation/);
        }
        expect(gapps.install).toHaveBeenCalledTimes(2);
    });

    it('a host with no book says so', async () => {
        await expect(dispatchGapps(() => null, 'list', [])).rejects.toThrow(/GApps are not available/);
    });

    it('a review too large for the window is refused in words, not by dropping the connection', async () => {
        const gapps = fakeApi();
        gapps.review.mockResolvedValueOnce({ ...review, items: [{ kind: 'network', host: 'x'.repeat(64 * 1024 * 1024) }] });
        await expect(dispatchGapps(() => gapps, 'review', ['/p'])).rejects.toThrow(/too large/);
    });

    describe('over the protocol', () => {
        const registered = (method: string): method is RemoteMethod => (REMOTE_METHODS as readonly string[]).includes(method);
        const closes: Array<() => void> = [];
        let dir: string;
        let devices: DeviceStore;
        beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-v7-wire-')); await mkdir(join(dir, 'devices')); let n = 0; devices = await DeviceStore.open(join(dir, 'devices'), { now: Date.now, random: () => `gapps-${++n}` }); });
        afterEach(async () => { for (const close of closes.splice(0)) close(); await rm(dir, { recursive: true, force: true }); });

        function rig() {
            const gapps = fakeApi();
            const hostApi = buildHostApi({ ...protocolContractDeps(dir), gapps: () => gapps });
            const invoked = vi.spyOn(hostApi, 'invoke');
            let accept!: (connection: ServerConnection) => void;
            new RemoteHost({ api: hostApi, hostName: 'gapps-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing, transport: { onConnection: (listener) => { accept = listener; return () => {}; } } });
            const connect = async (local: boolean) => {
                const wire = inMemoryPair();
                closes.push(() => wire.client.close());
                accept({ ...wire.server, preAuth: local ? { kind: 'local' as const, label: 'window', isOwner: true, workspaceId: null, readonly: false } : { label: 'remote owner', isOwner: true, workspaceId: null, readonly: false } });
                const client = connectRemote(wire.client, local ? { kind: 'local' } : { kind: 'relay' }, 'window');
                expect(await client.ready).toMatchObject({ ok: true });
                let next = 100_000;
                const raw = (method: string, args: unknown[]) => {
                    const id = next++;
                    return new Promise<{ ok: boolean; reason?: string }>((resolve) => {
                        const off = wire.client.onMessage((text) => { const m = JSON.parse(text) as { kind: string; id?: number; ok: boolean; reason?: string }; if (m.kind === 'result' && m.id === id) { off(); resolve(m); } });
                        wire.client.send(JSON.stringify({ kind: 'call', id, method, args }));
                    });
                };
                return { client, raw };
            };
            return { gapps, invoked, connect };
        }

        it('the operations are local-only capabilities', () => {
            for (const method of GAPP_METHODS) {
                expect(registered(method), method).toBe(true);
                if (registered(method)) expect(capabilityOf(method)).toBe('local');
            }
        });

        it('a local window reaches the host and hears its failures, and they never go through the common API', async () => {
            const f = rig();
            const { client } = await f.connect(true);
            const bridge = client.bridge.gapps!;
            await bridge.list();
            expect(f.gapps.list).toHaveBeenCalled();
            await bridge.setOn('a', false);
            expect(f.gapps.setOn).toHaveBeenCalledWith('a', false);
            f.gapps.uninstall.mockRejectedValueOnce(new Error('could not be removed'));
            await expect(bridge.uninstall('a')).rejects.toThrow('could not be removed');
            expect(f.invoked.mock.calls.filter(([method]) => method.startsWith('gapps.'))).toEqual([]);
        });

        it('even an authenticated remote owner is refused before any operation', async () => {
            const f = rig();
            const { raw, client } = await f.connect(false);
            expect(client.bridge.gapps).toBeUndefined();
            for (const method of GAPP_METHODS) expect(await raw(method, []), method).toMatchObject({ ok: false, reason: expect.stringMatching(/local.*window|own.*window/i) });
            expect(f.gapps.list).not.toHaveBeenCalled();
        });
    });

    it('the engine answers a local window only, and the host hands it the book (source guard)', () => {
        const server = readFileSync(join('src', 'main', 'session-engine-server.ts'), 'utf8');
        expect(server).toMatch(/if \(method === 'engine\.gapps'\) \{\s*if \(!conn\.local \|\| !conn\.window\) throw/);
        expect(readFileSync(join('src', 'main', 'genie-host.ts'), 'utf8')).toMatch(/gappBook \? \{ gapps: gappsApi\(gappBook\) \} : \{\}/);
        expect(readFileSync(join('src', 'main', 'main.ts'), 'utf8')).toMatch(/gapps: \(\) => agentEngineLink\?\.client\.gapps\(\) \?\? null/);
    });

    it('the shell gives the title bar the store\'s actions (source guard)', () => {
        const shell = readFileSync(join('src', 'renderer', 'Shell.tsx'), 'utf8');
        expect(shell).not.toMatch(/NO_GAPPS/);
        expect(shell).toMatch(/gapps=\{gappStore\}/);
    });
});

describe('what an app can never be granted (the coordinator\'s call, 2026-11-08)', () => {
    it('plan, flows, mail and thumbsUp are never granted, until the owner rules otherwise', () => {
        const genie = genieCatalog();
        for (const id of ['plan', 'flows', 'mail', 'thumbsUp']) expect(genie.get(id)?.payload.grantable, id).toBe(false);
    });
});
