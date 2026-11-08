import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginHost } from '../src/main/plugin-host.js';
import { PluginsService } from '../src/main/plugins-host.js';
import { signPackage } from './plugin-sign-helper.js';
import { MarketplaceClient, openMarketplacePlugins as startPlugins, type MarketplaceClientOptions } from '../src/main/marketplace-client.js';

const opened = new Set<MarketplaceClient>();
async function createClient(options: MarketplaceClientOptions): Promise<MarketplaceClient> {
    const client = await MarketplaceClient.open(options);
    opened.add(client);
    return client;
}

const publisherId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const cursor = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const pair = generateKeyPairSync('ed25519');
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
const row = () => ({ key_id: fingerprint, public_key_pem: pem, publisher: { id: publisherId, name: 'Example Publisher', verification: { method: 'domain', identity: 'publisher.example.org' } } });
const page = (keys: unknown[] = [row()], next_cursor: string | null = null) => new Response(JSON.stringify({ keys, next_cursor }), { headers: { 'Content-Type': 'application/json' } });

let dir: string;
let cacheFile: string;
let clock: number;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const open = () => createClient({ cacheFile, fetch: fetcher, now: () => clock, maxCacheAgeMs: 60_000 });

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-marketplace-c3-'));
    cacheFile = join(dir, 'publisher-keys.json');
    clock = Date.parse('2026-11-08T12:00:00Z');
    fetcher = vi.fn<typeof fetch>().mockImplementation(async () => page());
});
afterEach(async () => { for (const client of opened) client.close(); opened.clear(); await rm(dir, { recursive: true, force: true }); });

describe('C3 publisher-key REST client and host trust integration', () => {
    it('reads C1 via anonymous REST and exposes its independently checked fingerprint', async () => {
        const client = await open();
        expect(client.publisherKeys()).toEqual({});
        await client.refresh();
        expect(client.publisherKeys()).toEqual({ [fingerprint]: pem });
        const [url, init] = fetcher.mock.calls[0]!;
        expect(String(url)).toBe('https://tynn.ai/api/v1/marketplace/publisher-keys');
        expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.stringify(init)).not.toMatch(/authorization|cookie|mcp/i);
    });

    it('commits only a complete paginated snapshot and removes revoked keys on the next refresh', async () => {
        const client = await open();
        fetcher.mockResolvedValueOnce(page([], cursor)).mockResolvedValueOnce(page());
        await client.refresh();
        expect(String(fetcher.mock.calls[1]![0])).toBe(`https://tynn.ai/api/v1/marketplace/publisher-keys?cursor=${cursor}`);
        expect(client.publisherKeys()).toHaveProperty(fingerprint, pem);
        fetcher.mockResolvedValueOnce(page([]));
        await client.refresh();
        expect(client.publisherKeys()).toEqual({});
        expect((await open()).publisherKeys()).toEqual({});
    });

    it('retains the previous complete snapshot after a failed later page, without publishing partial keys', async () => {
        const client = await open();
        await client.refresh();
        const before = await readFile(cacheFile, 'utf8');
        fetcher.mockResolvedValueOnce(page([], cursor)).mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
        await expect(client.refresh()).rejects.toThrow(/registry|publisher|503/i);
        expect(client.publisherKeys()).toEqual({ [fingerprint]: pem });
        expect(await readFile(cacheFile, 'utf8')).toBe(before);
    });

    it.each([
        ['fingerprint mismatch', () => ({ ...row(), key_id: `sha256:${'0'.repeat(64)}` })],
        ['legacy id', () => ({ ...row(), key_id: 'ed25519-legacy' })],
        ['private PEM', () => ({ ...row(), public_key_pem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })],
        ['missing identity', () => ({ ...row(), publisher: { id: publisherId, name: 'Example' } })],
        ['malformed publisher', () => ({ ...row(), publisher: { ...row().publisher, id: '../account' } })],
    ])('refuses %s before it reaches the key store', async (_label, badRow) => {
        const client = await open();
        fetcher.mockResolvedValueOnce(page([badRow()]));
        await expect(client.refresh()).rejects.toThrow(/key|publisher|registry|SPKI/i);
        expect(client.publisherKeys()).toEqual({});
    });

    it.each([
        ['array envelope', []], ['missing cursor', { keys: [] }],
        ['URL cursor', { keys: [], next_cursor: 'https://attacker.example/keys' }],
        ['duplicate key', { keys: [row(), row()], next_cursor: null }],
        ['too many rows', { keys: Array.from({ length: 201 }, row), next_cursor: null }],
    ])('refuses a %s response atomically', async (_label, body) => {
        const client = await open();
        fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body)));
        await expect(client.refresh()).rejects.toThrow();
        expect(client.publisherKeys()).toEqual({});
    });

    it('refuses cursor loops and bounds the refresh rather than making an endless request chain', async () => {
        const client = await open();
        fetcher.mockImplementation(async () => page([], cursor));
        await expect(client.refresh()).rejects.toThrow(/cursor|page/i);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(client.publisherKeys()).toEqual({});
    });

    it('bounds response bodies even when no Content-Length is supplied', async () => {
        const client = await open();
        fetcher.mockResolvedValueOnce(new Response(' '.repeat(524_289)));
        await expect(client.refresh()).rejects.toThrow(/large|limit|size/i);
        expect(client.publisherKeys()).toEqual({});
    });

    it('reloads a valid cache, expires it at the deadline, and never extends freshness on failure', async () => {
        const client = await open();
        await client.refresh();
        clock += 59_999;
        expect((await open()).publisherKeys()).toEqual({ [fingerprint]: pem });
        clock++;
        expect(client.publisherKeys()).toEqual({});
        expect((await open()).publisherKeys()).toEqual({});
        fetcher.mockRejectedValueOnce(new Error('offline'));
        await expect(client.refresh()).rejects.toThrow('offline');
        expect(client.publisherKeys()).toEqual({});
    });

    it('ignores corrupt, future-dated and other-origin cache data', async () => {
        const client = await open();
        await client.refresh();
        const original = JSON.parse(await readFile(cacheFile, 'utf8'));
        for (const body of ['not JSON', JSON.stringify({ ...original, origin: 'https://other.example' }), JSON.stringify({ ...original, fetched_at: clock + 1 })]) {
            await writeFile(cacheFile, body);
            expect((await open()).publisherKeys()).toEqual({});
        }
    });

    it('does not let mutable callers change the stored keys or registry data replace bundled keys', async () => {
        const client = await open();
        await client.refresh();
        const keys = client.publisherKeys({ [fingerprint]: 'bundled-key', 'bundled-only': 'another-bundled-key' });
        expect(keys).toEqual({ [fingerprint]: 'bundled-key', 'bundled-only': 'another-bundled-key' });
        expect(Object.isFrozen(keys)).toBe(true);
        expect(client.publisherKeys()).toEqual({ [fingerprint]: pem });
    });

    it('coalesces simultaneous refreshes into one request and one completed snapshot', async () => {
        const client = await open();
        let reply!: (response: Response) => void;
        fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { reply = resolve; }));
        const first = client.refresh();
        const second = client.refresh();
        expect(fetcher).toHaveBeenCalledTimes(1);
        reply(page());
        await Promise.all([first, second]);
        expect(client.publisherKeys()).toEqual({ [fingerprint]: pem });
    });

    it('does not retain known withdrawn authority when caching the complete refresh fails', async () => {
        const client = await open();
        await client.refresh();
        await rm(cacheFile);
        await mkdir(cacheFile);
        fetcher.mockResolvedValueOnce(page([]));
        await expect(client.refresh()).rejects.toThrow();
        expect(client.publisherKeys()).toEqual({});
        expect(client.keyState(fingerprint)).toBe('withdrawn');
    });

    it.each(['http://tynn.ai', 'https://user:secret@tynn.ai', 'https://tynn.ai/path', 'https://tynn.ai/?token=secret', 'file:///keys'])('refuses non-origin or insecure registry configuration %s', async origin => {
        await expect(createClient({ cacheFile, origin, fetch: fetcher })).rejects.toThrow(/origin|https/i);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('provides registry keys to the existing host check; removing one refuses its installed signed package', async () => {
        const client = await open();
        await client.refresh();
        const plugins = join(dir, 'plugins');
        const folder = join(plugins, 'example');
        await mkdir(folder, { recursive: true });
        const bytes = JSON.stringify({ id: 'org.example.plugin', name: 'Example', version: '1.0.0', publisher: { name: 'Example', keyId: fingerprint }, capabilities: { genieApi: [], network: { hosts: [] } } });
        await writeFile(join(folder, 'genie-plugin.json'), bytes);
        await signPackage(folder, pair.privateKey);
        const installed = await PluginHost.open({ dir: plugins, keys: client.publisherKeys(), publisherChecksOff: false });
        expect(installed.list()).toMatchObject([{ id: 'org.example.plugin', state: 'enabled' }]);
        fetcher.mockResolvedValueOnce(page([]));
        await client.refresh();
        const checked = await PluginHost.open({ dir: plugins, keys: client.publisherKeys(), publisherChecksOff: false });
        expect(checked.list()).toMatchObject([{ id: 'org.example.plugin', state: 'refused', reason: expect.stringMatching(/key|publisher/i) }]);
    });

    it('persists completed-snapshot withdrawals across restart and cache expiry', async () => {
        const client = await open();
        await client.refresh();
        expect(client.keyState(fingerprint)).toBe('trusted');
        fetcher.mockResolvedValueOnce(page([]));
        await client.refresh();
        expect(client.keyState(fingerprint)).toBe('withdrawn');
        clock += 60_000;
        expect((await open()).keyState(fingerprint)).toBe('withdrawn');
    });

    it.each([false, true])('refuses an installed registry package on withdrawal with publisherChecksOff=%s, including old tool references', async publisherChecksOff => {
        const client = await open();
        await client.refresh();
        const pluginsDir = join(dir, 'plugins');
        const folder = join(pluginsDir, 'example');
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'genie-plugin.json'), JSON.stringify({ id: 'org.example.plugin', name: 'Example', version: '1.0.0', publisher: { name: 'Example', keyId: fingerprint }, mcpTools: [{ name: 'hello', description: 'Hello', inputSchema: { type: 'object' }, run: 'tool.cjs', process: 'subprocess', gated: false }], capabilities: { genieApi: [], network: { hosts: [] } } }));
        await writeFile(join(folder, 'tool.cjs'), 'module.exports = { hello: async () => "ok" };');
        await signPackage(folder, pair.privateKey);
        const options = { dir: pluginsDir, keys: {}, publisherChecksOff: () => publisherChecksOff, registry: client };
        const service = await PluginsService.open(options);
        const installed = service.dump().entries.find(entry => entry.id === 'org.example.plugin');
        expect(installed).toMatchObject({ state: 'enabled', unverified: false });
        const previousTool = service.plugins().tools().find(tool => tool.pluginId === 'org.example.plugin')!;
        expect(await previousTool.verify()).toBeNull();
        fetcher.mockImplementation(async () => page([]));
        await client.refresh();
        expect(await previousTool.verify()).toMatch(/withdrawn|revoked|removed.*registry/i);
        const changes: unknown[] = [];
        service.onEvent(dump => changes.push(dump));
        await service.call('refresh', []);
        expect(service.dump().entries.find(entry => entry.id === 'org.example.plugin')).toMatchObject({ state: 'refused', reason: expect.stringMatching(/withdrawn|revoked|registry/i) });
        expect(service.plugins().tools().some(tool => tool.pluginId === 'org.example.plugin')).toBe(false);
        expect(changes).toHaveLength(1);
    });

    it('bounds a refresh deadline and never grants keys from a stalled fetch', async () => {
        fetcher.mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));
        const client = await createClient({ cacheFile, fetch: fetcher, timeoutMs: 20 });
        await expect(client.refresh()).rejects.toThrow(/abort|timeout|timed out/i);
        expect(client.publisherKeys()).toEqual({});
    });

    it('opens official plugins without waiting on registry network, and stopping aborts its owned refresh', async () => {
        let signal: AbortSignal | null = null;
        fetcher.mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? null;
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));
        let scheduled = 0;
        const host = await startPlugins({ cacheFile, pluginsDir: join(dir, 'plugins'), keys: {}, publisherChecksOff: () => false, fetch: fetcher, schedule: () => { scheduled++; return () => {}; } });
        try {
            expect(host.plugins.dump().entries.map(entry => entry.id)).toContain('ai.genie.spreadsheet');
            expect(fetcher).toHaveBeenCalledTimes(1);
        } finally { host.stop(); }
        expect((signal as AbortSignal | null)?.aborted).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(scheduled).toBe(0);
    });
});
