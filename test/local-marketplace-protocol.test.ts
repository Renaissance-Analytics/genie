// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { capabilityOf, inMemoryPair, REMOTE_METHODS, type RemoteMethod, type ServerConnection } from '../src/core/remote-protocol.js';
import { LOCAL_FRAME_LIMIT_BYTES, type LocalFramePort } from '../src/core/local-frame.js';
import type { MarketplaceApi, MarketplaceReview } from '../src/core/marketplace.js';
import { buildHostApi } from '../src/main/host-api.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { pageBridge, type GenieBridge, type PreloadBridge } from '../src/renderer/bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

const methods = ['marketplace.search', 'marketplace.prepare', 'marketplace.install', 'marketplace.discard'] as const;
const registered = (method: string): method is RemoteMethod => (REMOTE_METHODS as readonly string[]).includes(method);
const review: MarketplaceReview = {
    token: 'opaque-window-owned-review-token', installedVersion: null, needsConsent: true,
    package: { id: 'org.example.plugin', name: 'Example', publisher: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'Example', verification: { method: 'domain', identity: 'example.org' } }, version: { version: '1.0.0', digest: 'a'.repeat(64), key_id: `sha256:${'b'.repeat(64)}`, permissions: { network: { hosts: [] }, genieApi: [] }, file_count: 1, uncompressed_size: 10, published_at: '2026-11-08T12:00:00Z', download_url: 'https://tynn.ai/archive' } },
    manifest: { id: 'org.example.plugin', name: 'Example', version: '1.0.0', publisher: { name: 'Example', keyId: 'k' }, capabilities: { network: { hosts: [] }, genieApi: [] }, mcpTools: [], panels: [] },
};
const futureApi = (bridge: GenieBridge): MarketplaceApi => {
    expect(bridge.marketplace, 'Marketplace must use the admitted local frame bridge').toBeDefined();
    return bridge.marketplace!;
};
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setTimeout(resolve, 0)); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let dir: string;
let devices: DeviceStore;
const closes: Array<() => void> = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-c4-local-frame-')); await mkdir(join(dir, 'devices')); let sequence = 0; devices = await DeviceStore.open(join(dir, 'devices'), { now: Date.now, random: () => `marketplace-${++sequence}` }); });
afterEach(async () => { for (const close of closes.splice(0)) close(); Reflect.deleteProperty(window, 'genieLocalProtocol'); await rm(dir, { recursive: true, force: true }); });
function api() {
    return { search: vi.fn<MarketplaceApi['search']>().mockResolvedValue({ packages: [], nextCursor: null }), prepare: vi.fn<MarketplaceApi['prepare']>().mockResolvedValue(review), install: vi.fn<MarketplaceApi['install']>().mockResolvedValue({ id: 'org.example.plugin', version: '1.0.0' }), discard: vi.fn<MarketplaceApi['discard']>().mockResolvedValue(undefined) };
}
function rig(marketplace = api()) {
    const deps = { ...protocolContractDeps(dir), marketplace: () => marketplace };
    const hostApi = buildHostApi(deps), invoked = vi.spyOn(hostApi, 'invoke'); let accept!: (connection: ServerConnection) => void;
    new RemoteHost({ api: hostApi, hostName: 'marketplace-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing, transport: { onConnection: listener => { accept = listener; return () => {}; } } });
    const pair = (local: boolean) => {
        const wire = inMemoryPair(); closes.push(() => wire.client.close());
        accept({ ...wire.server, ...(local ? { preAuth: { kind: 'local' as const, label: 'window', isOwner: true, workspaceId: null, readonly: false } } : { preAuth: { label: 'remote owner', isOwner: true, workspaceId: null, readonly: false } }) });
        return wire;
    };
    return { marketplace, invoked, connect: async (local = true) => {
        const wire = pair(local), client = connectRemote(wire.client, local ? { kind: 'local' } : { kind: 'relay' }, 'window');
        expect(await client.ready).toMatchObject({ ok: true });
        let next = 100_000;
        const raw = async (method: string, args: unknown[]) => {
            expect(registered(method), 'Marketplace methods are missing from the local protocol table').toBe(true);
            const id = next++;
            return new Promise<{ ok: boolean; reason?: string; value?: unknown }>(resolve => {
                const off = wire.client.onMessage(text => { const value = JSON.parse(text) as { kind: string; id?: number; ok: boolean; reason?: string; value?: unknown }; if (value.kind === 'result' && value.id === id) { off(); resolve(value); } });
                wire.client.send(JSON.stringify({ kind: 'call', id, method, args }));
            });
        };
        return { client, raw, close: () => wire.client.close() };
    }, framePort: (): LocalFramePort => {
        const wire = inMemoryPair(); closes.push(() => wire.client.close()); const listeners = new Set<Parameters<LocalFramePort['onFrame']>[0]>(); let handle = '';
        wire.client.onMessage(text => { for (const listener of listeners) listener('frame', handle, text); });
        wire.client.onClose(() => { for (const listener of listeners) listener('closed', handle, ''); });
        return { onFrame: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, send: (action, id, text) => {
            if (action === 'open') { handle = id; accept({ ...wire.server, preAuth: { kind: 'local', label: 'page', isOwner: true, workspaceId: null, readonly: false } }); }
            else if (action === 'frame') wire.client.send(text); else wire.client.close();
        } };
    } };
}

describe('C4 Marketplace over the existing admitted local frame protocol', () => {
    it('declares exactly the four operations as local-only capabilities', () => {
        for (const method of methods) { expect(registered(method)).toBe(true); if (registered(method)) expect(capabilityOf(method)).toBe('local'); }
    });
    it('carries the typed API through a real local connection, including current host failures', async () => {
        const f = rig(), w = await f.connect(), marketplace = futureApi(w.client.bridge);
        await marketplace.search('notes'); expect(f.marketplace.search).toHaveBeenCalledWith('notes', undefined);
        await marketplace.prepare('org.example.plugin', '1.0.0');
        expect(await marketplace.install(review.token, true)).toMatchObject({ version: '1.0.0' });
        await marketplace.prepare('org.example.plugin', '1.0.0'); await marketplace.discard(review.token);
        expect(f.marketplace.discard).toHaveBeenCalledWith(review.token);
        f.marketplace.search.mockRejectedValueOnce(new Error('Registry is offline'));
        await expect(marketplace.search('notes')).rejects.toThrow('Registry is offline');
        expect(f.invoked.mock.calls.filter(([method]) => method.startsWith('marketplace.'))).toEqual([]);
    });
    it('refuses even an authenticated remote owner before invoking any Marketplace operation', async () => {
        const f = rig(), w = await f.connect(false);
        for (const method of methods) expect(await w.raw(method, [])).toMatchObject({ ok: false, reason: expect.stringMatching(/own.*window|local.*window/i) });
        expect(f.marketplace.search).not.toHaveBeenCalled(); expect(f.marketplace.prepare).not.toHaveBeenCalled(); expect(f.marketplace.install).not.toHaveBeenCalled(); expect(f.marketplace.discard).not.toHaveBeenCalled();
    });
    it('keeps reviews per renderer window and discards them when that local connection closes', async () => {
        const f = rig(), a = await f.connect(), b = await f.connect();
        await futureApi(a.client.bridge).prepare('org.example.plugin', '1.0.0');
        expect(await b.raw('marketplace.install', [review.token, true])).toMatchObject({ ok: false, reason: expect.stringMatching(/review.*window|window.*review/i) });
        expect(f.marketplace.install).not.toHaveBeenCalled(); a.close(); await settle();
        expect(f.marketplace.discard).toHaveBeenCalledWith(review.token);
    });
    it('discards preparation which finishes after its renderer connection has gone', async () => {
        const f = rig(), w = await f.connect(), marketplace = futureApi(w.client.bridge), pending = deferred<MarketplaceReview>();
        f.marketplace.prepare.mockReturnValueOnce(pending.promise);
        const request = marketplace.prepare('org.example.plugin', '1.0.0'); void request.catch(() => {}); await settle();
        expect(f.marketplace.prepare).toHaveBeenCalledTimes(1); w.close(); pending.resolve(review); await settle();
        expect(f.marketplace.discard).toHaveBeenCalledWith(review.token);
    });
    it('rejects malformed operation arguments without calling the privileged API', async () => {
        const f = rig(), w = await f.connect();
        for (const [method, args] of [['marketplace.search', [{}]], ['marketplace.prepare', [{}, '1.0.0']], ['marketplace.install', ['token', 'true']], ['marketplace.discard', [{}]]] as const) expect(await w.raw(method, [...args])).toMatchObject({ ok: false });
        expect(f.marketplace.search).not.toHaveBeenCalled(); expect(f.marketplace.prepare).not.toHaveBeenCalled(); expect(f.marketplace.install).not.toHaveBeenCalled(); expect(f.marketplace.discard).not.toHaveBeenCalled();
    });
    it('refuses an oversized review and releases its token without closing the local connection', async () => {
        const f = rig(), w = await f.connect(), marketplace = futureApi(w.client.bridge);
        f.marketplace.prepare.mockResolvedValueOnce({ ...review, manifest: { ...review.manifest, mcpTools: [{ name: 'hello', description: 'Hello', inputSchema: { description: 'x'.repeat(LOCAL_FRAME_LIMIT_BYTES - 512) }, run: 'tools.cjs', process: 'subprocess', gated: true }] } });
        await expect(marketplace.prepare('org.example.plugin', '1.0.0')).rejects.toThrow(/review.*(?:size|large|limit)|(?:size|large|limit).*review/i);
        expect(f.marketplace.discard).toHaveBeenCalledWith(review.token);
        await marketplace.search('still connected'); expect(f.marketplace.search).toHaveBeenCalledWith('still connected', undefined);
    });
    it('projects the API into pageBridge through its actual local frame port', async () => {
        const f = rig(); Object.defineProperty(window, 'genieLocalProtocol', { configurable: true, value: f.framePort() });
        const preload = { subscribeAgentWire: () => () => {}, workspaces: {}, files: {} } as unknown as PreloadBridge;
        const bridge = pageBridge(preload); await settle(); expect(bridge.localProtocol?.state().phase).toBe('ready');
        const marketplace = futureApi(bridge);
        await marketplace.search('from page'); expect(f.marketplace.search).toHaveBeenCalledWith('from page', undefined);
        expect(pageBridge(preload)).toBe(bridge);
    });
    it('composes the late-bound engine facade without adding a dedicated IPC handler', () => {
        const source = readFileSync('src/main/main.ts', 'utf8');
        expect(source).toMatch(/marketplace:\s*\(\)\s*=>\s*agentEngineLink\?\.client\.marketplace\(\)/);
        expect(source).not.toMatch(/ipcMain\.handle\(['"]genie:marketplace/);
        expect(readFileSync('src/main/preload.ts', 'utf8')).toContain('LOCAL_FRAME_CHANNELS');
    });
});
