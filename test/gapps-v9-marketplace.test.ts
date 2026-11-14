import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_BRIDGE } from '../src/core/catalog.js';
import { PACKAGE_MANIFEST_FILE, PACKAGE_SIGNATURE_FILE } from '../src/core/plugin-integrity.js';
import { GAppMarketplace, type GAppDownload } from '../src/main/gapp-marketplace.js';
import { GAppBook } from '../src/main/gapps-host.js';
import { genieCatalog } from '../src/main/genie-catalog.js';
import type { PublisherKeyState } from '../src/main/marketplace-client.js';
import { signPackage } from './plugin-sign-helper.js';

/**
 * GAPPS V2, V9 (Tynn #574; spec .ai/plans/specs/gapps-v2.md, story V9): AN APP FROM THE MARKETPLACE. The registry's
 * genie-package/1 archive is downloaded by the host, refused past the format's limits before anything is unpacked or
 * hashed, and installed through the GApp book (V3) with the same checks, review, consent and grant as a folder. The
 * registry's keys verify it; a key the registry withdraws refuses the installed app at its next check, with the reason.
 */
const pair = generateKeyPairSync('ed25519');
const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
const PEM = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const ID = 'com.example.notes';

let root: string;
let book: GAppBook;
let state: PublisherKeyState;
let refreshes: number;
let market: GAppMarketplace;
let archives: Map<string, { bytes: Buffer; digest: string; files: number; size: number }>;

/** The fake registry: its keys, and what it says of each. Genie bundles none. */
const registry = {
    publisherKeys: (bundled: Readonly<Record<string, string>> = {}) => ({ ...bundled, ...(state === 'trusted' ? { [KEY_ID]: PEM } : {}) }),
    keyState: (id: string): PublisherKeyState => (id === KEY_ID ? state : 'unknown'),
    refresh: async () => { refreshes++; },
};

function zip(files: Record<string, Buffer>): Promise<Buffer> {
    const archive = new ZipFile();
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((ok, fail) => {
        archive.outputStream.on('data', (c: Buffer) => chunks.push(c));
        archive.outputStream.on('error', fail);
        archive.outputStream.on('end', () => ok(Buffer.concat(chunks)));
    });
    for (const [name, bytes] of Object.entries(files)) archive.addBuffer(bytes, name);
    archive.end();
    return done;
}

async function publish(version = '1.0.0'): Promise<void> {
    const folder = join(root, 'publish', version);
    await mkdir(join(folder, 'app'), { recursive: true });
    const manifest = Buffer.from(JSON.stringify({
        id: ID, name: 'Notes', version, publisher: { name: 'Example', keyId: KEY_ID },
        contributions: [{
            id: `${ID}.app`, kind: 'app', docs: { name: 'Notes', description: 'Notes.' },
            reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local', link: { calls: [...APP_BRIDGE.calls], events: [...APP_BRIDGE.events] } },
            permissions: { capabilities: [], network: ['api.example.com'] }, payload: { entry: 'app/index.html', uses: ['knowledge'] },
        }],
    }));
    const page = Buffer.from('<!doctype html><title>notes</title>');
    await writeFile(join(folder, PACKAGE_MANIFEST_FILE), manifest);
    await writeFile(join(folder, 'app', 'index.html'), page);
    const digest = await signPackage(folder, pair.privateKey);
    const files = { [PACKAGE_MANIFEST_FILE]: manifest, 'app/index.html': page, [PACKAGE_SIGNATURE_FILE]: await readFile(join(folder, PACKAGE_SIGNATURE_FILE)) };
    archives.set(version, { bytes: await zip(files), digest, files: 2, size: manifest.length + page.length });
}

/** What the host's download gives: the archive written where it was asked, and what the registry says of it. */
const download = vi.fn(async (id: string, version: string, archive: string): Promise<GAppDownload> => {
    const a = archives.get(version);
    if (id !== ID || !a) throw new Error(`the registry has no ${id} ${version}`);
    await writeFile(archive, a.bytes);
    return { keyId: KEY_ID, digest: a.digest, fileCount: a.files, uncompressedSize: a.size };
});

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-v9-'));
    state = 'trusted';
    refreshes = 0;
    archives = new Map();
    download.mockClear();
    book = await GAppBook.open({ dir: join(root, 'gapps'), keys: {}, registry, publisherChecksOff: () => false, catalog: () => genieCatalog() });
    market = new GAppMarketplace({ book, registry, download, stagingDir: join(root, 'staging') });
    await publish();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const staged = async () => { try { return await readdir(join(root, 'staging')); } catch { return []; } };

describe('installing an app from the registry', () => {
    it('an app signed by a registry key: reviewed by Genie\'s own names, then installed with the person\'s consent and grant', async () => {
        const { token, review } = await market.review(ID, '1.0.0');
        expect(refreshes).toBe(1);
        expect(review).toMatchObject({ packageId: ID, version: '1.0.0', publisher: KEY_ID, update: false, consent: true });
        expect(review.items.map((i) => (i.kind === 'element' ? i.name : i.kind === 'network' ? i.host : i.kind))).toEqual([genieCatalog().get('knowledge')!.docs.name, 'api.example.com']);
        expect(book.list()).toEqual([]);
        const entry = await market.install(token, { scope: ['w1'], consent: { digest: review.digest, items: review.items } });
        expect(entry).toMatchObject({ packageId: ID, version: '1.0.0', unverified: false, grant: { publisher: KEY_ID, scope: ['w1'], uses: ['knowledge'] } });
        expect(book.list().map((e) => e.packageId)).toEqual([ID]);
        expect(await staged()).toEqual([]);
    });

    it('without the person\'s consent nothing is installed, and the review can be tried again', async () => {
        const { token } = await market.review(ID, '1.0.0');
        await expect(market.install(token, { scope: 'workstation' })).rejects.toThrow(/consent/);
        expect(book.list()).toEqual([]);
    });

    it('a review is one-use, and a discarded one leaves nothing behind', async () => {
        const { token, review } = await market.review(ID, '1.0.0');
        await market.install(token, { scope: 'workstation', consent: { digest: review.digest, items: review.items } });
        await expect(market.install(token, { scope: 'workstation', consent: { digest: review.digest, items: review.items } })).rejects.toThrow(/review/);
        const other = await market.review(ID, '1.0.0');
        await market.discard(other.token);
        expect(await staged()).toEqual([]);
    });

    it('a key the registry does not trust is refused before anything is reviewed', async () => {
        state = 'unknown';
        await expect(market.review(ID, '1.0.0')).rejects.toThrow(/key/);
        expect(await staged()).toEqual([]);
    });

    it('a key withdrawn between the review and the install refuses the install', async () => {
        const { token, review } = await market.review(ID, '1.0.0');
        state = 'withdrawn';
        await expect(market.install(token, { scope: 'workstation', consent: { digest: review.digest, items: review.items } })).rejects.toThrow(/withdrawn/);
        expect(book.list()).toEqual([]);
    });

    it('an archive that is not what the registry says (its digest) is refused', async () => {
        download.mockImplementationOnce(async (_id, _v, archive) => { await writeFile(archive, archives.get('1.0.0')!.bytes); return { keyId: KEY_ID, digest: '0'.repeat(64), fileCount: 2, uncompressedSize: archives.get('1.0.0')!.size }; });
        await expect(market.review(ID, '1.0.0')).rejects.toThrow(/registry/);
        expect(await staged()).toEqual([]);
    });
});

describe('a withdrawn key', () => {
    it('refuses the installed app at its next check, with the reason', async () => {
        const { token, review } = await market.review(ID, '1.0.0');
        await market.install(token, { scope: 'workstation', consent: { digest: review.digest, items: review.items } });
        expect(await book.verifyInstalled(ID)).toBeNull(); // Control: it runs while its key is trusted.
        state = 'withdrawn';
        expect(await book.verifyInstalled(ID)).toMatch(/Notes is refused: its publisher's key was withdrawn/);
    });
});

describe('the format\'s limits', () => {
    it('an archive past genie-package/1\'s file count is refused before anything is unpacked or hashed', async () => {
        const many: Record<string, Buffer> = {};
        for (let i = 0; i < 10_001; i++) many[`f/${i}.txt`] = Buffer.from('x');
        const bytes = await zip(many);
        download.mockImplementationOnce(async (_id, _v, archive) => { await writeFile(archive, bytes); return { keyId: KEY_ID, digest: 'a'.repeat(64), fileCount: 10_001, uncompressedSize: 10_001 }; });
        const reviewing = vi.spyOn(book, 'reviewInstall');
        await expect(market.review(ID, '1.0.0')).rejects.toThrow(/limit/);
        expect(reviewing).not.toHaveBeenCalled();
        expect(await staged()).toEqual([]);
    }, 60_000);
});
