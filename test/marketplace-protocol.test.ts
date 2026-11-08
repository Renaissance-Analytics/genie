import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_LINK_LABEL, isEngineMethod } from '../src/core/engine-protocol.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { MarketplaceApi, MarketplaceReview } from '../src/core/marketplace.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';

const token = 'marketplace-protocol-test-token';
const channels: Array<ReturnType<typeof memoryPair>[0]> = [];
afterEach(() => { for (const channel of channels.splice(0)) channel.close(); });
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; };
function api() {
    const review: MarketplaceReview = {
        token: 'opaque-reviewed-package-token', installedVersion: null, needsConsent: true,
        package: { id: 'org.example.plugin', name: 'Example', publisher: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'Example', verification: { method: 'domain', identity: 'example.org' } }, version: { version: '1.0.0', digest: 'a'.repeat(64), key_id: `sha256:${'b'.repeat(64)}`, permissions: { network: { hosts: [] }, genieApi: [] }, file_count: 1, uncompressed_size: 10, published_at: '2026-11-08T12:00:00Z', download_url: 'https://tynn.ai/archive' } },
        manifest: { id: 'org.example.plugin', name: 'Example', version: '1.0.0', publisher: { name: 'Example', keyId: 'k' }, capabilities: { network: { hosts: [] }, genieApi: [] }, mcpTools: [], panels: [] },
    };
    return {
        review,
        search: vi.fn<MarketplaceApi['search']>().mockResolvedValue({ packages: [], nextCursor: null }),
        prepare: vi.fn<MarketplaceApi['prepare']>().mockResolvedValue(review),
        install: vi.fn<MarketplaceApi['install']>().mockResolvedValue({ id: 'org.example.plugin', version: '1.0.0' }),
        discard: vi.fn<MarketplaceApi['discard']>().mockResolvedValue(undefined),
    };
}
async function window(server: SessionEngineServer, local = true, browser = false) {
    const [h, w] = memoryPair(); channels.push(w); server.accept(h, { local });
    const client = new SessionEngineClient(browser ? { label: BROWSER_LINK_LABEL } : {});
    expect(await client.connect(w, token)).toMatchObject({ ok: true });
    return { client, close: () => w.close() };
}
async function call(client: SessionEngineClient, operation: string, args: unknown[]) {
    // Fail immediately at the absent allowlist entry rather than wait for an unanswered malformed frame.
    expect(isEngineMethod('engine.marketplace'), 'Marketplace protocol allowlist entry is missing').toBe(true);
    return client.call('engine.marketplace', [operation, args]);
}

describe('C4 local-window Marketplace protocol', () => {
    it('forwards only the four explicit operations with their original typed arguments', async () => {
        const marketplace = api(), options = { token, build: 'test', marketplace };
        const server = new SessionEngineServer(options), w = await window(server);
        expect(await call(w.client, 'search', ['notes'])).toMatchObject({ ok: true, value: { packages: [] } });
        expect(marketplace.search).toHaveBeenCalledWith('notes', undefined);
        expect(await call(w.client, 'prepare', ['org.example.plugin', '1.0.0'])).toMatchObject({ ok: true, value: { token: marketplace.review.token } });
        expect(await call(w.client, 'install', [marketplace.review.token, true])).toMatchObject({ ok: true, value: { version: '1.0.0' } });
        expect(marketplace.install).toHaveBeenCalledWith(marketplace.review.token, true);
        await call(w.client, 'prepare', ['org.example.plugin', '1.0.0']);
        expect(await call(w.client, 'discard', [marketplace.review.token])).toMatchObject({ ok: true });
        expect(marketplace.discard).toHaveBeenCalledWith(marketplace.review.token);
    });
    it('refuses a remote peer and the local browser before touching the Marketplace', async () => {
        const marketplace = api(), options = { token, build: 'test', marketplace };
        const server = new SessionEngineServer(options);
        for (const w of [await window(server, false), await window(server, true, true)]) {
            const answer = await call(w.client, 'search', ['']);
            expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/local window/i) });
        }
        expect(marketplace.search).not.toHaveBeenCalled();
    });
    it('rejects unknown operations, objects masquerading as strings and nonboolean consent', async () => {
        const marketplace = api(), options = { token, build: 'test', marketplace };
        const w = await window(new SessionEngineServer(options));
        for (const [op, args] of [['constructor', []], ['__proto__', []], ['close', []], ['search', [{}]], ['prepare', [{}, '1.0.0']], ['install', ['token', 'true']]] as const) {
            expect(await call(w.client, op, [...args])).toMatchObject({ ok: false });
        }
        expect(marketplace.search).not.toHaveBeenCalled(); expect(marketplace.prepare).not.toHaveBeenCalled(); expect(marketplace.install).not.toHaveBeenCalled();
    });
    it('binds a review to its preparing window and discards it when that window closes', async () => {
        const marketplace = api(), options = { token, build: 'test', marketplace };
        const server = new SessionEngineServer(options), a = await window(server), b = await window(server);
        await call(a.client, 'prepare', ['org.example.plugin', '1.0.0']);
        expect(await call(b.client, 'install', [marketplace.review.token, true])).toMatchObject({ ok: false, reason: expect.stringMatching(/review.*window|window.*review/i) });
        expect(marketplace.install).not.toHaveBeenCalled();
        a.close(); await tick();
        expect(marketplace.discard).toHaveBeenCalledWith(marketplace.review.token);
    });
    it('discards a review which finishes preparing after its window has disconnected', async () => {
        expect(isEngineMethod('engine.marketplace'), 'Marketplace protocol allowlist entry is missing').toBe(true);
        const marketplace = api(), preparing = deferred<MarketplaceReview>(); marketplace.prepare.mockReturnValue(preparing.promise);
        const options = { token, build: 'test', marketplace }, w = await window(new SessionEngineServer(options));
        const result = call(w.client, 'prepare', ['org.example.plugin', '1.0.0']); await tick();
        expect(marketplace.prepare).toHaveBeenCalledTimes(1); w.close(); preparing.resolve(marketplace.review);
        await result; await tick();
        expect(marketplace.discard).toHaveBeenCalledWith(marketplace.review.token);
    });
    it('provides a typed client API that surfaces host errors', async () => {
        const marketplace = api(), options = { token, build: 'test', marketplace };
        const w = await window(new SessionEngineServer(options));
        const client = w.client;
        expect(typeof client.marketplace).toBe('function');
        await client.marketplace().search('notes'); expect(marketplace.search).toHaveBeenCalledWith('notes', undefined);
        marketplace.search.mockRejectedValueOnce(new Error('Registry is offline'));
        await expect(client.marketplace().search('notes')).rejects.toThrow('Registry is offline');
    });
    it('names an unavailable Marketplace on a host that has no service', async () => {
        const w = await window(new SessionEngineServer({ token, build: 'test' }));
        expect(await call(w.client, 'search', [''])).toMatchObject({ ok: false, reason: expect.stringMatching(/marketplace.*(?:unavailable|not available|no|not enabled)|no.*marketplace/i) });
    });
    it('production composes the Marketplace with the existing registry, binary transport and owned shutdown', () => {
        const source = readFileSync('src/main/genie-host.ts', 'utf8');
        expect(source).toContain('MarketplaceHost.open(');
        expect(source).toMatch(/registry:\s*marketplacePlugins\.registry/);
        expect(source).toMatch(/streamResponse:\s*true/);
        expect(source).toMatch(/marketplace:\s*marketplaceHost/);
        expect(source).toMatch(/await marketplaceHost\.close\(\)/);
    });
    it('the packaged host includes its ZIP reader and the locked runtime dependency closure', () => {
        const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
        const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version?: string; dev?: boolean; dependencies?: Record<string, string> }> };
        expect(manifest.dependencies.yauzl, 'ZIP reader must ship with the host rather than only in the CI dev install').toBe('3.4.0');
        expect(lock.packages['']!.dependencies?.yauzl).toBe('3.4.0');
        expect(lock.packages['node_modules/yauzl']!.dev).not.toBe(true);
        expect(lock.packages['node_modules/pend']!.dev).not.toBe(true);
    });
});
