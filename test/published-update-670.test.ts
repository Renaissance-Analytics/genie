import { describe, expect, it, vi } from 'vitest';
import { selectPublishedUpdate, type PublishedUpdateRelease } from '../src/main/published-update.js';

// Candidate policy only: no GitHub request, feed rewrite, updater process, download or installer.
// Provider integration must sort candidates and retain this release/manifest pair for the library's downloader.
const release = (version: string, overrides: Partial<PublishedUpdateRelease> = {}): PublishedUpdateRelease =>
    ({ tag_name: `v${version}`, draft: false, prerelease: version.includes('-'), ...overrides });
const manifest = (version: string) => ({ version, path: 'synthetic-installer.exe', sha512: 'synthetic-checksum' });
const NEW = '2.0.0-beta.62.1';
const OLD = '2.0.0-beta.62';

describe('the newest published update with a usable manifest (#670)', () => {
    it('a newer draft cannot hide the published release, even if its metadata is already uploaded', async () => {
        const draft = release(NEW, { draft: true }); const published = release(OLD);
        const read = vi.fn(async (candidate: PublishedUpdateRelease) => manifest(candidate.tag_name.slice(1)));
        const selected = await selectPublishedUpdate([draft, published], true, read);
        expect(selected.release).toBe(published);
        expect(selected.manifest.version).toBe(OLD);
        expect(read).toHaveBeenCalledExactlyOnceWith(published);
    });

    it('missing latest.yml on the newest published candidate falls back to the next published one', async () => {
        const newest = release(NEW); const previous = release(OLD); const olderManifest = manifest(OLD);
        const read = vi.fn(async (candidate: PublishedUpdateRelease) => candidate === newest ? null : olderManifest);
        await expect(selectPublishedUpdate([newest, previous], true, read)).resolves.toEqual({ release: previous, manifest: olderManifest });
        expect(read.mock.calls.map(([candidate]) => candidate)).toEqual([newest, previous]);
    });

    it('stable excludes prereleases before probing their manifests', async () => {
        const beta = release(NEW); const stable = release('1.9.0');
        const read = vi.fn(async (candidate: PublishedUpdateRelease) => manifest(candidate.tag_name.slice(1)));
        const selected = await selectPublishedUpdate([beta, stable], false, read);
        expect(selected.release).toBe(stable);
        expect(read).toHaveBeenCalledExactlyOnceWith(stable);
    });

    it('a manifest naming a different version is refused rather than paired with the wrong release', async () => {
        const newest = release(NEW); const previous = release(OLD);
        const read = vi.fn(async () => manifest(OLD));
        await expect(selectPublishedUpdate([newest, previous], true, read)).rejects.toThrow(/manifest version.*release/i);
        expect(read).toHaveBeenCalledExactlyOnceWith(newest);
    });

    it('CONTROL: the newest installable published candidate and its metadata are kept together unchanged', async () => {
        const newest = release(NEW); const previous = release(OLD); const offered = manifest(NEW);
        const read = vi.fn(async () => offered);
        const selected = await selectPublishedUpdate([newest, previous], true, read);
        expect(selected.release).toBe(newest); expect(selected.manifest).toBe(offered);
        expect(read).toHaveBeenCalledExactlyOnceWith(newest);
    });

    it('CONTROL: authentication/server/network failure propagates without being treated as a missing file', async () => {
        for (const reason of ['HTTP 401', 'HTTP 403', 'HTTP 500', 'connection timed out']) {
            const newest = release(NEW); const previous = release(OLD); const problem = new Error(reason);
            const read = vi.fn(async () => { throw problem; });
            await expect(selectPublishedUpdate([newest, previous], true, read)).rejects.toBe(problem);
            expect(read).toHaveBeenCalledExactlyOnceWith(newest);
        }
    });

    it('CONTROL: malformed metadata is an error, without silently selecting a different release', async () => {
        const newest = release(NEW); const previous = release(OLD); const problem = new Error('Invalid update metadata.');
        const read = vi.fn(async () => { throw problem; });
        await expect(selectPublishedUpdate([newest, previous], true, read)).rejects.toBe(problem);
        expect(read).toHaveBeenCalledExactlyOnceWith(newest);
    });

    it('CONTROL: an empty published list fails plainly without making a manifest request', async () => {
        const read = vi.fn(async () => manifest(OLD));
        await expect(selectPublishedUpdate([], true, read)).rejects.toThrow('No published release with update metadata was found.');
        expect(read).not.toHaveBeenCalled();
    });
});
