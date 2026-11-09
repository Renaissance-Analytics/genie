import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_BRIDGE } from '../src/core/catalog.js';
import { GAPP_MANIFEST_FILE, GAppBook } from '../src/main/gapps-host.js';
import { genieCatalog, hostCatalog } from '../src/main/genie-catalog.js';
import { signPackage } from './plugin-sign-helper.js';

/**
 * GAPPS V2, V3 (Tynn #568; spec .ai/plans/specs/gapps-v2.md, approved 2026-11-08): THE GAPP BOOK IN GENIE-HOST. An app
 * is installed from a signed genie-package/1 folder whose manifest is `genie-package.json` (decision 1): its
 * contributions in the catalog's own envelope, one of them an `app`.
 *  - review first: B4's package check (digest, signature, limits) and B5's rule (unsigned only with publisher checks off,
 *    Unverified), then V2's review, by Genie's catalog names;
 *  - install with the person's consent to THAT review: the files copied into the book, the grant written, the package
 *    registered in the catalog (source `gapp`);
 *  - turn off unregisters and keeps grant and storage; turn on registers again; uninstall leaves nothing of the app;
 *  - an update asks again only for what is new; no workspace is ever made for an app (decision 2).
 */
const pair = generateKeyPairSync('ed25519');
const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
const keys = { [KEY_ID]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const ID = 'com.example.notesapp';

function manifest(over: { version?: string; uses?: string[]; network?: string[]; keyId?: string | null } = {}) {
    return {
        id: ID, name: 'Notes', version: over.version ?? '1.0.0',
        publisher: { name: 'Example Co', ...(over.keyId === null ? {} : { keyId: over.keyId ?? KEY_ID }) },
        contributions: [{
            id: `${ID}.app`, kind: 'app',
            docs: { name: 'Notes', description: 'Take notes.' },
            reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local', link: { calls: [...APP_BRIDGE.calls], events: [...APP_BRIDGE.events] } },
            permissions: { capabilities: [], network: over.network ?? ['api.example.com'] },
            payload: { entry: 'app/index.html', uses: over.uses ?? ['knowledge'], storage: 'app' },
        }],
    };
}

let root: string;
let gappsDir: string;
let checksOff: boolean;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-v3-'));
    gappsDir = join(root, 'home', 'gapps');
    checksOff = false;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function appFolder(name: string, over: Parameters<typeof manifest>[0] = {}, sign = true): Promise<string> {
    const dir = join(root, 'src', name);
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(join(dir, GAPP_MANIFEST_FILE), JSON.stringify(manifest(over), null, 2));
    await writeFile(join(dir, 'app', 'index.html'), `<!doctype html><title>Notes ${over.version ?? '1.0.0'}</title>`);
    if (sign) await signPackage(dir, pair.privateKey);
    return dir;
}
const open = () => GAppBook.open({ dir: gappsDir, keys, publisherChecksOff: () => checksOff, catalog: () => genieCatalog(), now: () => 1000 });
const exists = async (p: string) => stat(p).then(() => true, () => false);

/** Review, then install with consent to exactly that review. */
async function installReviewed(book: GAppBook, dir: string, scope: 'workstation' | string[] = ['ws-a']) {
    const review = await book.reviewInstall(dir);
    if (!review.ok) throw new Error(review.reason);
    return book.install(dir, { scope, consent: { digest: review.review.digest, items: review.review.items } });
}

describe('install', () => {
    it('the review is Genie\'s: the publisher, each element by its catalog name, each host', async () => {
        const book = await open();
        const review = await book.reviewInstall(await appFolder('v1'));
        expect(review.ok).toBe(true);
        if (!review.ok) return;
        expect(review.review).toMatchObject({ packageId: ID, name: 'Notes', version: '1.0.0', publisher: KEY_ID, update: false });
        const knowledge = genieCatalog().get('knowledge')!;
        expect(review.review.items).toEqual([
            { kind: 'element', id: 'knowledge', name: knowledge.docs.name, description: knowledge.docs.description },
            { kind: 'network', host: 'api.example.com' },
        ]);
    });

    it('installed with consent: its files, its grant and its catalog element; nothing else is made', async () => {
        const book = await open();
        const r = await installReviewed(book, await appFolder('v1'));
        expect(r).toMatchObject({ ok: true });
        expect(book.list()).toEqual([expect.objectContaining({
            packageId: ID, name: 'Notes', version: '1.0.0', state: 'installed', unverified: false,
            grant: expect.objectContaining({ uses: ['knowledge'], network: ['api.example.com'], scope: ['ws-a'], grantedBy: 'person', publisher: KEY_ID }),
        })]);
        expect(await readFile(join(gappsDir, ID, '1.0.0', 'app', 'index.html'), 'utf8')).toContain('Notes 1.0.0');
        const catalog = hostCatalog({ tools: () => [] }, book);
        expect(catalog.get(`${ID}.app`)).toMatchObject({ kind: 'app', source: 'gapp', packageId: ID, version: '1.0.0' });
        // Decision 2: no workspace for an app; the book writes inside its own folder only.
        expect((await readdir(join(root, 'home'))).sort()).toEqual(['gapps']);
    });

    it('kept across a reopen: the entry and its catalog element come back', async () => {
        await installReviewed(await open(), await appFolder('v1'));
        const again = await open();
        expect(again.list().map((e) => e.packageId)).toEqual([ID]);
        expect(hostCatalog({ tools: () => [] }, again).get(`${ID}.app`)).not.toBeNull();
    });

    it('consent to a different review installs nothing: the package changed since the person read it', async () => {
        const book = await open();
        const dir = await appFolder('v1');
        const review = await book.reviewInstall(dir);
        if (!review.ok) throw new Error(review.reason);
        await writeFile(join(dir, 'app', 'index.html'), 'changed');
        await signPackage(dir, pair.privateKey);
        const r = await book.install(dir, { scope: ['ws-a'], consent: { digest: review.review.digest, items: review.review.items } });
        expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/changed since .*reviewed/) });
        expect(book.list()).toEqual([]);
        expect(await exists(join(gappsDir, ID))).toBe(false);
    });

    it('an app that uses something only the person may do is refused at review, naming it', async () => {
        const book = await open();
        const review = await book.reviewInstall(await appFolder('greedy', { uses: ['knowledge', 'ForceTheQuestion'] }));
        expect(review).toMatchObject({ ok: false, reason: expect.stringMatching(/"ForceTheQuestion".*never granted to an app/) });
    });
});

describe('the package checks (B4, B5)', () => {
    it('a tampered package is refused, with publisher checks on or off; nothing is written', async () => {
        const dir = await appFolder('v1');
        await writeFile(join(dir, 'app', 'index.html'), 'tampered after signing');
        for (const off of [false, true]) {
            checksOff = off;
            const book = await open();
            expect(await book.reviewInstall(dir), `checks off: ${off}`).toMatchObject({ ok: false, reason: expect.stringMatching(/tampered/) });
            expect(await book.install(dir, { scope: 'workstation', consent: { digest: 'x', items: [] } })).toMatchObject({ ok: false });
        }
        expect(await exists(join(gappsDir, ID))).toBe(false);
    });

    it('unsigned: refused with publisher checks on; with them off, installed as Unverified', async () => {
        const dir = await appFolder('local', { keyId: null }, false);
        expect(await (await open()).reviewInstall(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/unsigned/) });
        checksOff = true;
        const book = await open();
        const review = await book.reviewInstall(dir);
        expect(review).toMatchObject({ ok: true, review: { publisher: 'unverified' } });
        await installReviewed(book, dir);
        expect(book.list()[0]).toMatchObject({ unverified: true, grant: expect.objectContaining({ publisher: 'unverified' }) });
    });

    it('a package without an app, or with two, is not a GApp', async () => {
        const book = await open();
        const dir = await appFolder('noapp');
        const m = manifest();
        await writeFile(join(dir, GAPP_MANIFEST_FILE), JSON.stringify({ ...m, contributions: [] }));
        await signPackage(dir, pair.privateKey);
        expect(await book.reviewInstall(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/exactly one app/) });
    });
});

describe('turn off, turn on, uninstall', () => {
    it('turned off: out of the catalog, grant and storage kept; turned on: back', async () => {
        const book = await open();
        await installReviewed(book, await appFolder('v1'));
        await writeFile(join(book.storageDir(ID), 'kept.json'), '{}');
        expect(await book.setOn(ID, false)).toBe(true);
        expect(book.list()[0]).toMatchObject({ state: 'off', grant: expect.objectContaining({ uses: ['knowledge'] }) });
        expect(hostCatalog({ tools: () => [] }, book).get(`${ID}.app`)).toBeNull();
        expect(await exists(join(book.storageDir(ID), 'kept.json'))).toBe(true);
        expect(await book.setOn(ID, true)).toBe(true);
        expect(hostCatalog({ tools: () => [] }, book).get(`${ID}.app`)).not.toBeNull();
    });

    it('uninstalled: files, grant, storage and catalog element all gone, and stay gone after a reopen', async () => {
        const book = await open();
        await installReviewed(book, await appFolder('v1'));
        await writeFile(join(book.storageDir(ID), 'data.json'), '{}');
        expect(await book.uninstall(ID)).toBe(true);
        expect(book.list()).toEqual([]);
        expect(await exists(join(gappsDir, ID))).toBe(false);
        expect(hostCatalog({ tools: () => [] }, book).get(`${ID}.app`)).toBeNull();
        expect((await open()).list()).toEqual([]);
        expect(await book.uninstall(ID)).toBe(false);
    });

    it('a change tells the host to rebuild its catalog', async () => {
        const book = await open();
        let told = 0;
        book.onChange(() => { told++; });
        await installReviewed(book, await appFolder('v1'));
        await book.setOn(ID, false);
        await book.uninstall(ID);
        expect(told).toBe(3);
    });
});

describe('an update asks again only for what is new', () => {
    it('nothing new: no consent needed; the new version replaces the old, grant and storage kept', async () => {
        const book = await open();
        await installReviewed(book, await appFolder('v1'));
        await writeFile(join(book.storageDir(ID), 'notes.json'), '[]');
        const dir2 = await appFolder('v1.1', { version: '1.1.0' });
        const review = await book.reviewInstall(dir2);
        expect(review).toMatchObject({ ok: true, review: { update: true, consent: false, items: [] } });
        expect(await book.install(dir2, { scope: ['ws-a'] })).toMatchObject({ ok: true });
        expect(book.list()[0]).toMatchObject({ version: '1.1.0' });
        expect(await exists(join(gappsDir, ID, '1.0.0'))).toBe(false);
        expect(await exists(join(book.storageDir(ID), 'notes.json'))).toBe(true);
    });

    it('a new element: consent again, for it alone; without consent nothing changes', async () => {
        const book = await open();
        await installReviewed(book, await appFolder('v1'));
        const dir2 = await appFolder('v1.2', { version: '1.2.0', uses: ['knowledge', 'mail'] });
        const review = await book.reviewInstall(dir2);
        expect(review).toMatchObject({ ok: true, review: { update: true, consent: true, items: [expect.objectContaining({ kind: 'element', id: 'mail' })] } });
        expect(await book.install(dir2, { scope: ['ws-a'] })).toMatchObject({ ok: false, reason: expect.stringMatching(/consent/) });
        expect(book.list()[0]).toMatchObject({ version: '1.0.0' });
        if (!review.ok) return;
        expect(await book.install(dir2, { scope: ['ws-a'], consent: { digest: review.review.digest, items: review.review.items } })).toMatchObject({ ok: true });
        expect(book.list()[0]).toMatchObject({ version: '1.2.0', grant: expect.objectContaining({ uses: ['knowledge', 'mail'] }) });
    });
});
