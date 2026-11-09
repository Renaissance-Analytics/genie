import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginCapabilities } from '../src/core/plugins.js';
import type { MarketplacePackage } from '../src/core/marketplace.js';
import { MarketplaceHost, type MarketplaceHostOptions as HostOptions } from '../src/main/marketplace-host.js';
import { MarketplaceClient } from '../src/main/marketplace-client.js';
import { PluginsService } from '../src/main/plugins-host.js';
import { PluginHost } from '../src/main/plugin-host.js';
import { signPackage } from './plugin-sign-helper.js';

type PackageData = { -readonly [K in keyof MarketplacePackage]: MarketplacePackage[K] };
const id = 'org.example.plugin';
const publisher = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'Example Publisher', verification: { method: 'domain' as const, identity: 'publisher.example.org' } };
const pair = generateKeyPairSync('ed25519');
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
const baseCaps: PluginCapabilities = { network: { hosts: ['api.example.org'] }, genieApi: ['knowledge'] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
interface Fixture { package: PackageData; bytes: Buffer; files: Record<string, Buffer> }

let dir: string;
let pluginsDir: string;
let stagingDir: string;
let grantsFile: string;
let clock: number;
let registry: MarketplaceClient;
let plugins: PluginsService;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let publisherChecksOff: boolean;
let registryKeysActive: boolean;
const versions = new Map<string, Fixture>();
const opened = new Set<MarketplaceHost>();

async function zip(files: Record<string, Buffer>): Promise<Buffer> {
    const archive = new ZipFile();
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
        archive.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
        archive.outputStream.on('error', reject);
        archive.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
    for (const [name, bytes] of Object.entries(files)) archive.addBuffer(bytes, name);
    archive.end();
    return done;
}
function patchCentral(bytes: Buffer, name: string, change: (copy: Buffer, at: number) => void): Buffer {
    const copy = Buffer.from(bytes);
    const end = copy.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let at = copy.readUInt32LE(end + 16);
    while (copy.readUInt32LE(at) === 0x02014b50) {
        const names = copy.readUInt16LE(at + 28), extra = copy.readUInt16LE(at + 30), comment = copy.readUInt16LE(at + 32);
        if (copy.subarray(at + 46, at + 46 + names).toString('utf8') === name) { change(copy, at); return copy; }
        at += 46 + names + extra + comment;
    }
    throw new Error(`fixture ZIP has no ${name}`);
}
function renameEntry(bytes: Buffer, from: string, to: string): Buffer {
    if (Buffer.byteLength(from) !== Buffer.byteLength(to)) throw new Error('fixture rename must preserve byte length');
    return patchCentral(bytes, from, (copy, at) => {
        const local = copy.readUInt32LE(at + 42);
        Buffer.from(to).copy(copy, at + 46);
        Buffer.from(to).copy(copy, local + 30);
    });
}
async function fixture(version = '1.0.0', capabilities = baseCaps): Promise<Fixture> {
    const folder = join(dir, 'fixtures', randomUUID());
    await mkdir(folder, { recursive: true });
    const manifest = Buffer.from(JSON.stringify({ id, name: 'Example plugin', version, publisher: { name: publisher.name, keyId }, capabilities, mcpTools: [{ name: 'hello', description: 'Hello', inputSchema: { type: 'object' }, run: 'tools.cjs', process: 'subprocess', gated: true }] }));
    // This would fail the install if any installer tried to execute third-party code while checking it.
    const tool = Buffer.from('throw new Error("plugin code must not execute during install");');
    await writeFile(join(folder, 'genie-plugin.json'), manifest);
    await writeFile(join(folder, 'tools.cjs'), tool);
    const digest = await signPackage(folder, pair.privateKey);
    const files = { 'genie-plugin.json': manifest, 'tools.cjs': tool, 'genie-plugin.sig': await readFile(join(folder, 'genie-plugin.sig')) };
    const result: Fixture = {
        files, bytes: await zip(files),
        package: { id, name: 'Example plugin', publisher, version: { version, digest, key_id: keyId, permissions: capabilities, file_count: 2, uncompressed_size: manifest.length + tool.length, published_at: '2026-11-08T12:00:00Z', download_url: `https://tynn.ai/api/v1/marketplace/packages/${id}/versions/${version}/download` } },
    };
    versions.set(version, result);
    return result;
}
async function open(over: Partial<HostOptions> = {}): Promise<MarketplaceHost> {
    const host = await MarketplaceHost.open({ pluginsDir, stagingDir, grantsFile, registry, plugins, fetch: fetcher, now: () => clock, ...over });
    opened.add(host); return host;
}
const installed = () => plugins.dump().entries.find(entry => entry.id === id);

beforeEach(async () => {
    versions.clear();
    dir = await mkdtemp(join(tmpdir(), 'genie-marketplace-c4-'));
    pluginsDir = join(dir, 'plugins'); stagingDir = join(dir, 'marketplace-staging'); grantsFile = join(dir, 'marketplace-grants.json');
    await mkdir(pluginsDir);
    clock = Date.parse('2026-11-08T12:00:00Z');
    publisherChecksOff = false;
    registryKeysActive = true;
    fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://tynn.ai');
        expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
        expect(JSON.stringify(init?.headers)).not.toMatch(/authorization|cookie/i);
        if (url.pathname === '/api/v1/marketplace/publisher-keys') return json({ keys: registryKeysActive ? [{ key_id: keyId, public_key_pem: pem, publisher }] : [], next_cursor: null });
        const all = [...versions.values()].reverse();
        if (url.pathname === '/api/v1/marketplace/packages') return json({ packages: all.length ? [all[0]!.package] : [], next_cursor: null });
        if (url.pathname === `/api/v1/marketplace/packages/${id}`) return json({ id, name: 'Example plugin', publisher, versions: all.map(item => item.package.version), next_cursor: null });
        const route = new RegExp(`^/api/v1/marketplace/packages/${id.replaceAll('.', '\\.')}/versions/([^/]+)(/download)?$`).exec(url.pathname);
        if (route) {
            const item = versions.get(decodeURIComponent(route[1]!));
            if (!item) return json({ error: 'missing version' }, 404);
            return route[2] ? new Response(Uint8Array.from(item.bytes), { headers: { 'Content-Type': 'application/zip' } }) : json(item.package);
        }
        throw new Error(`Unexpected C4 fixture request ${url.pathname}`);
    });
    registry = await MarketplaceClient.open({ cacheFile: join(dir, 'keys.json'), fetch: fetcher, now: () => clock });
    await registry.refresh();
    plugins = await PluginsService.open({ dir: pluginsDir, keys: {}, publisherChecksOff: () => publisherChecksOff, registry });
});
afterEach(async () => { for (const host of opened) await host.close(); opened.clear(); registry.close(); await rm(dir, { recursive: true, force: true }); });

describe('C4 host-owned Marketplace review and installation', () => {
    it('searches anonymous REST and reports current install/update state', async () => {
        await fixture(); const host = await open();
        expect((await host.search('notes')).packages).toMatchObject([{ id, installedVersion: null, updateAvailable: false }]);
        expect(fetcher.mock.calls.some(([url]) => String(url).includes('/marketplace/packages?q=notes'))).toBe(true);
    });

    it('verifies and stages a signed archive for review without activating or executing it', async () => {
        const item = await fixture(); const host = await open();
        const review = await host.prepare(id, '1.0.0');
        expect(review).toMatchObject({ package: item.package, installedVersion: null, needsConsent: true, manifest: { id, version: '1.0.0', capabilities: baseCaps, mcpTools: [{ run: 'tools.cjs', process: 'subprocess' }] } });
        expect(review.token).toEqual(expect.any(String));
        expect(review.token.length).toBeGreaterThanOrEqual(32);
        expect(installed()).toBeUndefined();
        expect(await readdir(pluginsDir)).toEqual([]);
        expect(await readdir(stagingDir)).not.toEqual([]);
        await expect(host.install(review.token, false)).rejects.toThrow(/consent|permission/i);
        expect(installed()).toBeUndefined();
        await expect(host.install(review.token, true)).resolves.toMatchObject({ id, version: '1.0.0' });
        expect(installed()).toMatchObject({ state: 'enabled', version: '1.0.0', unverified: false });
        expect(plugins.plugins().tools().some(tool => tool.pluginId === id)).toBe(true);
    });

    it('persists consent, auto-installs a narrower update, and requires renewed consent for a wider one', async () => {
        await fixture(); const host = await open();
        await host.install((await host.prepare(id, '1.0.0')).token, true);
        await fixture('1.1.0', { network: { hosts: [] }, genieApi: ['knowledge'] });
        const same = await host.prepare(id, '1.1.0');
        expect(same).toMatchObject({ installedVersion: '1.0.0', needsConsent: false });
        await host.install(same.token, false);
        expect(installed()).toMatchObject({ version: '1.1.0' });
        await fixture('1.2.0', { network: { hosts: [] }, genieApi: ['knowledge', 'manageTerminals'] });
        const wider = await host.prepare(id, '1.2.0');
        expect(wider.needsConsent).toBe(true);
        await expect(host.install(wider.token, false)).rejects.toThrow(/consent|permission/i);
        expect(installed()).toMatchObject({ version: '1.1.0' });
        await host.install(wider.token, true);
        expect(installed()).toMatchObject({ version: '1.2.0' });
        await host.close(); opened.delete(host);
        await fixture('1.3.0', { network: { hosts: [] }, genieApi: ['knowledge', 'manageTerminals'] });
        expect((await (await open()).prepare(id, '1.3.0')).needsConsent).toBe(false);
    });

    it('offering an update uses semantic precedence rather than publication or lexical order', async () => {
        await fixture(); const host = await open();
        await host.install((await host.prepare(id, '1.0.0')).token, true);
        await fixture('1.10.0'); await fixture('1.9.0');
        const results = await host.search('');
        expect(results.packages).toMatchObject([{ id, installedVersion: '1.0.0', updateAvailable: true, version: { version: '1.10.0' } }]);
    });

    it.each(['reload', 'refresh'] as const)('an earlier %s cannot replace a newly installed snapshot after finishing late', async operation => {
        await fixture(); const host = await open(); await host.install((await host.prepare(id, '1.0.0')).token, true);
        const old = plugins.plugins(); let release!: (value: PluginHost) => void;
        const pending = new Promise<PluginHost>(resolve => { release = resolve; });
        const openedOld = vi.fn(() => pending), spy = vi.spyOn(PluginHost, 'open').mockImplementationOnce(openedOld);
        const stale = operation === 'reload' ? plugins.reload() : plugins.call('refresh', []);
        try {
            await vi.waitFor(() => expect(openedOld).toHaveBeenCalledTimes(1));
            await fixture('1.1.0'); await host.install((await host.prepare(id, '1.1.0')).token, false);
            expect(installed()).toMatchObject({ version: '1.1.0', state: 'enabled' });
        } finally { release(old); await stale; spy.mockRestore(); }
        expect(installed()).toMatchObject({ version: '1.1.0', state: 'enabled' });
    });

    it('cancel, unknown tokens, consumed tokens and expired reviews cannot install', async () => {
        await fixture(); const host = await open({ reviewMaxAgeMs: 1000 });
        const cancelled = await host.prepare(id, '1.0.0');
        await host.discard(cancelled.token);
        await expect(host.install(cancelled.token, true)).rejects.toThrow(/review|token|expired|unknown/i);
        await expect(host.install('forged-review-token', true)).rejects.toThrow(/review|token|unknown/i);
        const expired = await host.prepare(id, '1.0.0'); clock += 1000;
        await expect(host.install(expired.token, true)).rejects.toThrow(/expir|review/i);
        expect(installed()).toBeUndefined();
        const valid = await host.prepare(id, '1.0.0'); await host.install(valid.token, true);
        await expect(host.install(valid.token, true)).rejects.toThrow(/review|token|used|unknown/i);
    });

    it.each([false, true])('rechecks publisher withdrawal after review with publisherChecksOff=%s', async off => {
        publisherChecksOff = off;
        await fixture(); const host = await open(); const review = await host.prepare(id, '1.0.0');
        registryKeysActive = false;
        await registry.refresh();
        await expect(host.install(review.token, true)).rejects.toThrow(/publisher|withdraw|key|trust/i);
        expect(installed()).toBeUndefined();
    });

    it('refuses tampered bytes and metadata/manifest permission disagreement before review', async () => {
        const item = await fixture(); const host = await open();
        item.bytes = await zip({ ...item.files, 'tools.cjs': Buffer.from('tampered') });
        await expect(host.prepare(id, '1.0.0')).rejects.toThrow(/digest|tamper|signature/i);
        expect(installed()).toBeUndefined();
        item.bytes = await zip(item.files);
        item.package.version = { ...item.package.version, permissions: { network: { hosts: [] }, genieApi: [] } };
        await expect(host.prepare(id, '1.0.0')).rejects.toThrow(/permission|metadata|manifest/i);
        expect(await readdir(pluginsDir)).toEqual([]);
    });

    it('refuses caller IDs and registry download URLs that could escape the fixed origin/routes', async () => {
        const item = await fixture(); const host = await open();
        await expect(host.prepare('../outside', '1.0.0')).rejects.toThrow(/id|package|invalid/i);
        await expect(host.prepare(id, '../outside')).rejects.toThrow(/version|invalid/i);
        item.package.version = { ...item.package.version, download_url: 'https://attacker.example/payload.zip' };
        await expect(host.prepare(id, '1.0.0')).rejects.toThrow(/origin|download|registry|url/i);
        expect(fetcher.mock.calls.every(([url]) => new URL(String(url)).origin === 'https://tynn.ai')).toBe(true);
    });

    it('failed consent persistence cannot leave a half-installed package or a success result', async () => {
        await fixture(); const host = await open(); const review = await host.prepare(id, '1.0.0');
        await mkdir(grantsFile);
        await expect(host.install(review.token, true)).rejects.toThrow();
        expect(installed()).toBeUndefined();
        expect(await readdir(pluginsDir)).toEqual([]);
    });

    it.each([false, true])('recovers a process-interrupted update with the new directory activated=%s', async activated => {
        const first = await fixture(); const host = await open();
        await host.install((await host.prepare(id, '1.0.0')).token, true);
        const previous = JSON.parse(await readFile(grantsFile, 'utf8')) as { grants: unknown[] };
        const next = await fixture('1.1.0'); await host.prepare(id, '1.1.0');
        const session = (await readdir(stagingDir)).find(name => name.startsWith('reviews-'))!;
        const packageDir = (await readdir(join(stagingDir, session))).find(name => name.startsWith('package-'))!;
        const transaction = `${session}/${packageDir}`, folder = join(stagingDir, transaction);
        // Filesystem state left by death after the journal was persisted, before or after the final rename.
        await writeFile(join(stagingDir, 'activation.json'), JSON.stringify({ version: 1, origin: 'https://tynn.ai', id, folder: id, transaction, previousDigest: first.package.version.digest, nextDigest: next.package.version.digest, previousGrants: previous.grants }));
        await rename(join(pluginsDir, id), join(folder, 'previous'));
        if (activated) await rename(join(folder, 'contents'), join(pluginsDir, id));
        await writeFile(grantsFile, JSON.stringify({ version: 1, origin: 'https://tynn.ai', grants: [] }));
        const recovered = await open();
        expect(JSON.parse(await readFile(join(pluginsDir, id, 'genie-plugin.json'), 'utf8'))).toMatchObject({ version: '1.0.0' });
        expect(installed()).toMatchObject({ version: '1.0.0', state: 'enabled' });
        expect(JSON.parse(await readFile(grantsFile, 'utf8'))).toMatchObject({ grants: previous.grants });
        expect(await readdir(stagingDir)).not.toContain('activation.json');
        expect((await recovered.prepare(id, '1.1.0')).needsConsent).toBe(false);
    });

    it('refuses an invalid recovery journal without touching unrelated directories', async () => {
        const host = await open(); const marker = join(dir, 'outside-marker'); await writeFile(marker, 'keep me');
        await writeFile(join(stagingDir, 'activation.json'), JSON.stringify({ version: 1, origin: 'https://tynn.ai', id, folder: '../../outside-marker', transaction: '../../outside', previousDigest: null, nextDigest: 'a'.repeat(64), previousGrants: [] }));
        await expect(open()).rejects.toThrow(/recovery|journal|path/i);
        expect(await readFile(marker, 'utf8')).toBe('keep me');
        await host.close();
    });

    it('bounds actual streamed archive bytes without relying on Content-Length', async () => {
        const item = await fixture(); const host = await open({ maxArchiveBytes: 4096 });
        item.bytes = Buffer.alloc(4097);
        await expect(host.prepare(id, '1.0.0')).rejects.toThrow(/size|limit|large/i);
        expect(installed()).toBeUndefined();
        expect(await readdir(pluginsDir)).toEqual([]);
    });

    it.each(['../pwnedx', '..\\pwnedx', 'C:bad.txt', 'CON.cjs  '])('refuses portable path escape/alias %s before extraction', async badName => {
        const item = await fixture(); const host = await open();
        item.bytes = renameEntry(item.bytes, 'tools.cjs', badName);
        await expect(host.prepare(id, '1.0.0')).rejects.toThrow(/path|file.?name|relative|travers|device|reserved|portable/i);
        expect(installed()).toBeUndefined();
        expect(await readdir(pluginsDir)).toEqual([]);
    });

    const unsafeExtraFiles: Array<[string, Record<string, Buffer>]> = [
        ['case collision', { 'Tools.cjs': Buffer.from('alias') }],
        ['NFC collision', { 'a\u0301.txt': Buffer.from('one'), '\u00e1.txt': Buffer.from('two') }],
        ['file parent', { parent: Buffer.from('file'), 'parent/child.txt': Buffer.from('child') }],
        ['Windows device', { 'COM\u00b9.txt': Buffer.from('device') }],
    ];
    it.each(unsafeExtraFiles)('refuses %s before writing archive entries', async (_label, extra) => {
        const item = await fixture(); const host = await open();
        item.bytes = await zip({ ...item.files, ...extra });
        item.package.version = { ...item.package.version, file_count: 2 + Object.keys(extra).length, uncompressed_size: item.package.version.uncompressed_size + Object.values(extra).reduce((n, bytes) => n + bytes.length, 0) };
        await expect(host.prepare(id, '1.0.0')).rejects.toThrow(/collision|duplicate|parent|path|device|reserved|portable/i);
        expect(installed()).toBeUndefined();
    });

    it('refuses ZIP links/nonregular entries and CRC disagreement even when signed file bytes are unchanged', async () => {
        const item = await fixture(); const original = item.bytes; const host = await open();
        for (const mode of [0o120777, 0o010777]) {
            item.bytes = patchCentral(original, 'tools.cjs', (copy, at) => copy.writeUInt32LE((mode << 16) >>> 0, at + 38));
            await expect(host.prepare(id, '1.0.0')).rejects.toThrow(/link|regular|type/i);
        }
        item.bytes = patchCentral(original, 'tools.cjs', (copy, at) => copy.writeUInt32LE((copy.readUInt32LE(at + 16) ^ 1) >>> 0, at + 16));
        await expect(host.prepare(id, '1.0.0')).rejects.toThrow(/CRC|checksum/i);
        expect(installed()).toBeUndefined();
    });

    it('refuses encrypted entries and oversized declared files before inflation', async () => {
        const item = await fixture(); const original = item.bytes; const host = await open();
        item.bytes = patchCentral(original, 'tools.cjs', (copy, at) => {
            copy.writeUInt16LE(copy.readUInt16LE(at + 8) | 1, at + 8);
            const local = copy.readUInt32LE(at + 42);
            copy.writeUInt16LE(copy.readUInt16LE(local + 6) | 1, local + 6);
        });
        await expect(host.prepare(id, '1.0.0')).rejects.toThrow(/encrypt/i);
        item.bytes = patchCentral(original, 'tools.cjs', (copy, at) => copy.writeUInt32LE(51 * 1024 * 1024, at + 24));
        await expect(host.prepare(id, '1.0.0')).rejects.toThrow(/limit|large|size/i);
        expect(installed()).toBeUndefined();
    });

    it('refuses declared expansion above the transport ratio budget before inflation', async () => {
        const item = await fixture(); const host = await open();
        const zeros = Buffer.alloc(2 * 1024 * 1024);
        item.bytes = await zip({ ...item.files, 'zeros.dat': zeros });
        item.package.version = { ...item.package.version, file_count: 3, uncompressed_size: item.package.version.uncompressed_size + zeros.length };
        await expect(host.prepare(id, '1.0.0')).rejects.toThrow(/ratio|expansion|compress/i);
        expect(installed()).toBeUndefined();
    });
});
