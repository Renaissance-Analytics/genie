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
import type { GAppReview, GAppsApi } from '../src/core/gapps.js';
import { gappInstallDetail } from '../src/core/gapps.js';
import { PACKAGE_MANIFEST_FILE } from '../src/core/plugin-integrity.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { askOnDeck, gappsApi } from '../src/main/gapps-api.js';
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
 * GAPPS V2 (Tynn #596; spec .ai/plans/specs/gapps-v2.md, section 3). Consent to an install is a blocking Deck item with the
 * review, asked by the host, so the install waits on the person's answer wherever they give it. And the store's list is
 * live: a change in one window appears in another without reopening.
 */
const pair = generateKeyPairSync('ed25519');
const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
const keys = { [KEY_ID]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const ID = 'com.example.notes';
const settleHost = () => new Promise((ok) => setTimeout(ok, 40));

describe('consent is a blocking Deck item', () => {
    let dir: string;
    let book: GAppBook;
    let approvals: ApprovalQueue;
    let gapps: ReturnType<typeof gappsApi>;

    async function folder(name: string, over: { version?: string; uses?: string[]; network?: string[] } = {}): Promise<string> {
        const source = join(dir, name);
        await mkdir(join(source, 'app'), { recursive: true });
        await writeFile(join(source, PACKAGE_MANIFEST_FILE), JSON.stringify({
            id: ID, name: 'Notes', version: over.version ?? '1.0.0', publisher: { name: 'Example', keyId: KEY_ID },
            contributions: [{
                id: `${ID}.app`, kind: 'app', docs: { name: 'Notes', description: 'Notes.' },
                reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local', link: { calls: [...APP_BRIDGE.calls], events: [...APP_BRIDGE.events] } },
                permissions: { capabilities: [], network: over.network ?? ['api.example.com'] }, payload: { entry: 'app/index.html', uses: over.uses ?? ['knowledge'] },
            }],
        }));
        await writeFile(join(source, 'app', 'index.html'), '<!doctype html>');
        await signPackage(source, pair.privateKey);
        return source;
    }
    const consentOf = (review: GAppReview) => ({ digest: review.digest, items: review.items });
    const answer = (choice: 'allow' | 'deny') => { expect(approvals.resolve(approvals.deckItems()[0]!.id, choice)).toBe(true); };

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-596-'));
        book = await GAppBook.open({ dir: join(dir, 'gapps'), keys, publisherChecksOff: () => false, catalog: () => genieCatalog() });
        approvals = new ApprovalQueue();
        gapps = gappsApi(book, askOnDeck(approvals, (id) => (id === 'w1' ? 'shop' : id)));
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('an install waits on a blocking item that shows the review, and nothing is installed until it is answered', async () => {
        const source = await folder('v1');
        const review = await gapps.review(source);
        let done = false;
        const installing = gapps.install(source, { scope: ['w1'], consent: consentOf(review) }).then((entry) => { done = true; return entry; });
        await settleHost();
        const items = approvals.deckItems();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ blocking: true, priority: 'high', workspaceId: null, agentName: 'GApp Store', answer: { kind: 'inline' } });
        const title = items[0]!.title;
        expect(title).toContain('Notes 1.0.0');
        expect(title).toContain(genieCatalog().get('knowledge')!.docs.name);
        expect(title).toContain('api.example.com');
        expect(title).toContain(KEY_ID);
        expect(title).toContain('shop');
        expect(done).toBe(false);
        expect(book.list()).toEqual([]);
        answer('allow');
        expect(await installing).toMatchObject({ id: ID, state: 'installed' });
        expect(book.list()[0]!.grant.scope).toEqual(['w1']);
        expect(approvals.deckItems()).toEqual([]);
    });

    it('a denial installs nothing, says so, and leaves the Deck', async () => {
        const source = await folder('v1');
        const review = await gapps.review(source);
        const installing = gapps.install(source, { scope: 'workstation', consent: consentOf(review) });
        await settleHost();
        expect(approvals.deckItems()[0]!.title).toContain('every workspace');
        answer('deny');
        await expect(installing).rejects.toThrow(/Notes was not installed: it was denied on the Deck/);
        expect(book.list()).toEqual([]);
        expect(approvals.deckItems()).toEqual([]);
    });

    it('nothing is asked when the store did not review this package, or asks without a review', async () => {
        const source = await folder('v1');
        const review = await gapps.review(source);
        await expect(gapps.install(source, { scope: 'workstation' })).rejects.toThrow(/needs the person's consent/);
        await expect(gapps.install(source, { scope: 'workstation', consent: { digest: 'other', items: review.items } })).rejects.toThrow(/changed since/);
        expect(approvals.deckItems()).toEqual([]);
    });

    async function installV1(): Promise<void> {
        const source = await folder('v1');
        const review = await gapps.review(source);
        const installing = gapps.install(source, { scope: 'workstation', consent: consentOf(review) });
        await settleHost();
        answer('allow');
        await installing;
    }

    it('an update that asks for nothing new is not put to the person', async () => {
        await installV1();
        const source = await folder('v2', { version: '1.1.0' });
        expect((await gapps.review(source)).consent).toBe(false);
        await expect(gapps.install(source, { scope: 'workstation' })).resolves.toMatchObject({ version: '1.1.0' });
        expect(approvals.deckItems()).toEqual([]);
    });

    it('an update that asks for something new asks for only that', async () => {
        await installV1();
        const source = await folder('v2', { version: '1.1.0', network: ['api.example.com', 'new.example.com'] });
        const review = await gapps.review(source);
        const installing = gapps.install(source, { scope: 'workstation', consent: consentOf(review) });
        await settleHost();
        const title = approvals.deckItems()[0]!.title;
        expect(title).toContain('new.example.com');
        expect(title).not.toContain('api.example.com');
        answer('allow');
        await expect(installing).resolves.toMatchObject({ version: '1.1.0' });
    });

    it('the detail names everything a long review asks for', () => {
        const items = Array.from({ length: 40 }, (_, i) => ({ kind: 'network' as const, host: `h${i}.example.com` }));
        const detail = gappInstallDetail({ name: 'Notes', version: '1.0.0', digest: 'd', packageId: ID, publisher: 'unverified', update: false, consent: true, items }, 'every workspace');
        for (const { host } of items) expect(detail).toContain(host);
        expect(detail).toContain('Unverified');
    });
});

describe('the store sends the person to the Deck', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    const review: GAppReview = { packageId: ID, name: 'New App', version: '1.0.0', digest: 'd1', publisher: 'sha256:abc', update: false, consent: true, items: [{ kind: 'network', host: 'api.example.com' }] };
    let api: { review: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn> };
    let actions: GAppStoreActions;

    beforeEach(() => {
        g.IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        api = { review: vi.fn(async () => review), install: vi.fn() };
        actions = { api: api as unknown as GAppsApi, pickFolder: vi.fn(async () => '/p'), refresh: vi.fn(async () => undefined), workspace: null };
    });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

    const q = (s: string) => document.querySelector<HTMLElement>(s);
    const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((ok) => setTimeout(ok, 0)); });
    const press = async (a: string) => { act(() => { q(`[data-gapp-action="${a}"]`)!.click(); }); await settle(); };
    const start = async () => {
        act(() => { root.render(<GAppStoreFlyout open onClose={() => undefined} apps={[]} actions={actions} />); });
        await settle();
        await press('install-from-folder');
    };

    it('the install says it waits for the answer on the Deck; the store itself offers no Allow', async () => {
        let finish: (v: unknown) => void = () => undefined;
        api.install.mockReturnValueOnce(new Promise((ok) => { finish = ok; }));
        await start();
        expect(q('[data-gapp-review]')!.textContent).not.toMatch(/Allow/);
        await press('request-install');
        expect(q('[data-gapp-progress]')!.textContent).toMatch(/Deck/);
        act(() => { finish({}); });
        await settle();
        expect(q('[data-gapp-success]')).not.toBeNull();
    });

    it('a denial is shown in words with Retry, and Retry asks again', async () => {
        api.install.mockRejectedValueOnce(new Error('New App was not installed: it was denied on the Deck.'));
        api.install.mockResolvedValueOnce({});
        await start();
        await press('request-install');
        expect(q('[data-gapp-failure]')!.textContent).toContain('denied on the Deck');
        await press('retry');
        expect(api.install).toHaveBeenCalledTimes(2);
    });
});

describe('the list is live across windows', () => {
    const closes: Array<() => void> = [];
    let dir: string;
    let devices: DeviceStore;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-596-wire-')); await mkdir(join(dir, 'devices')); let n = 0; devices = await DeviceStore.open(join(dir, 'devices'), { now: Date.now, random: () => `gapps-${++n}` }); });
    afterEach(async () => { for (const close of closes.splice(0)) close(); await rm(dir, { recursive: true, force: true }); });

    function rig() {
        const listeners = new Set<() => void>();
        const hostApi = buildHostApi({ ...protocolContractDeps(dir), gappsChanged: { subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } });
        let accept!: (connection: ServerConnection) => void;
        new RemoteHost({ api: hostApi, hostName: 'gapps-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing, transport: { onConnection: (listener) => { accept = listener; return () => {}; } } });
        const connect = async (local: boolean) => {
            const wire = inMemoryPair();
            closes.push(() => wire.client.close());
            const raw: string[] = [];
            wire.client.onMessage((text) => raw.push(text));
            accept({ ...wire.server, preAuth: local ? { kind: 'local' as const, label: 'window', isOwner: true, workspaceId: null, readonly: false } : { label: 'remote owner', isOwner: true, workspaceId: null, readonly: false } });
            const client = connectRemote(wire.client, local ? { kind: 'local' } : { kind: 'relay' }, 'window');
            expect(await client.ready).toMatchObject({ ok: true });
            return { client, raw };
        };
        return { connect, fire: () => { for (const listener of [...listeners]) listener(); } };
    }

    it('a change reaches every local window, as a signal, and each can stop listening', async () => {
        const r = rig();
        const a = await r.connect(true);
        const b = await r.connect(true);
        const heardA = vi.fn();
        const heardB = vi.fn();
        const offA = a.client.bridge.gapps!.onChanged(heardA);
        b.client.bridge.gapps!.onChanged(heardB);
        r.fire();
        await vi.waitFor(() => { expect(heardA).toHaveBeenCalledTimes(1); expect(heardB).toHaveBeenCalledTimes(1); });
        offA();
        r.fire();
        await vi.waitFor(() => expect(heardB).toHaveBeenCalledTimes(2));
        expect(heardA).toHaveBeenCalledTimes(1);
    });

    it('it never reaches another machine', async () => {
        const r = rig();
        const local = await r.connect(true);
        const remote = await r.connect(false);
        const heard = vi.fn();
        local.client.bridge.gapps!.onChanged(heard);
        r.fire();
        await vi.waitFor(() => expect(heard).toHaveBeenCalled()); // Control: the signal went out.
        expect(local.raw.some((m) => m.includes('local-gapps'))).toBe(true);
        expect(remote.raw.some((m) => m.includes('local-gapps'))).toBe(false);
    });

    it('is wired from the book to the shell (source guard)', () => {
        const engine = readFileSync(join('src', 'main', 'session-engine-server.ts'), 'utf8');
        expect(engine).toMatch(/if \(conn\.authed && conn\.local\) this\.#event\(conn, 'gapps\.changed'/);
        expect(readFileSync(join('src', 'main', 'session-engine-client.ts'), 'utf8')).toMatch(/case 'gapps\.changed':/);
        const host = readFileSync(join('src', 'main', 'genie-host.ts'), 'utf8');
        expect(host).toMatch(/gappsChanged: \(listener\) => gappBook\.onChange\(listener\)/);
        expect(host).toMatch(/gappsApi\(gappBook, askOnDeck\(approvals,/);
        expect(readFileSync(join('src', 'main', 'main.ts'), 'utf8')).toMatch(/client\.onGappsChanged\(/);
        expect(readFileSync(join('src', 'renderer', 'Shell.tsx'), 'utf8')).toMatch(/gapps\.onChanged\(/);
    });
});
