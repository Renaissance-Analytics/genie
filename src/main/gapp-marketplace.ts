import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GrantScope, ReviewItem } from '../core/gapp-grants.js';
import type { GAppReview } from '../core/gapps.js';
import type { GAppBook, GAppEntry } from './gapps-host.js';
import { extractMarketplaceArchive } from './marketplace-archive.js';
import type { PublisherKeyRegistry } from './marketplace-client.js';

/**
 * AN APP FROM THE MARKETPLACE (GApps v2, V9, Tynn #574; spec .ai/plans/specs/gapps-v2.md). The host downloads the
 * registry's genie-package/1 archive into its own staging folder and installs it through the GApp book (V3): the same
 * checks, review, consent and grant as an app from a folder.
 *  - The archive is checked against the format's limits from its directory before anything is unpacked or hashed
 *    (marketplace-archive.ts, C3's).
 *  - Only a key the registry trusts now verifies it (the book takes the registry's keys), and the package must be what
 *    the registry says: its signing key and its digest. The registry is asked again before the review and the install.
 *  - A key the registry later withdraws refuses the installed app at its next check (GAppBook.verifyInstalled).
 * A review is one-use and held here; nothing it unpacked is left behind.
 */
export interface GAppDownload {
    /** What the registry says of this version. */
    readonly keyId: string;
    readonly digest: string;
    readonly fileCount: number;
    readonly uncompressedSize: number;
}

export interface GAppMarketplacePorts {
    readonly book: Pick<GAppBook, 'reviewInstall' | 'install'>;
    readonly registry: Pick<PublisherKeyRegistry, 'keyState' | 'refresh'>;
    /** The host's download of one version's archive, written to `archive`, and what the registry says of it. */
    readonly download: (id: string, version: string, archive: string, signal: AbortSignal) => Promise<GAppDownload>;
    readonly stagingDir: string;
}

export class GAppMarketplace {
    readonly #ports: GAppMarketplacePorts;
    readonly #reviews = new Map<string, { dir: string; keyId: string; digest: string }>();

    constructor(ports: GAppMarketplacePorts) {
        this.#ports = ports;
    }

    /** What installing this version would ask of the person. Rejects with the reason, leaving nothing staged. */
    async review(id: string, version: string): Promise<{ token: string; review: GAppReview }> {
        await this.#ports.registry.refresh();
        await mkdir(this.#ports.stagingDir, { recursive: true });
        const dir = await mkdtemp(join(this.#ports.stagingDir, 'gapp-'));
        try {
            const archive = join(dir, 'download.zip');
            const contents = join(dir, 'contents');
            await mkdir(contents);
            const said = await this.#ports.download(id, version, archive, new AbortController().signal);
            if (this.#ports.registry.keyState(said.keyId) !== 'trusted') throw new Error(`${id} ${version} is signed by a key the registry does not trust now; it is not installed`);
            const sizes = await extractMarketplaceArchive(archive, contents, new AbortController().signal);
            if (sizes.fileCount !== said.fileCount || sizes.uncompressedSize !== said.uncompressedSize) throw new Error(`${id} ${version}'s archive is not what the registry says it is (its files)`);
            const checked = await this.#ports.book.reviewInstall(contents);
            if (!checked.ok) throw new Error(checked.reason);
            const { review } = checked;
            if (review.packageId !== id || review.version !== version || review.publisher !== said.keyId || review.digest !== said.digest) {
                throw new Error(`${id} ${version} is not what the registry says it is (its id, version, signing key or digest)`);
            }
            const token = randomBytes(32).toString('hex');
            this.#reviews.set(token, { dir, keyId: said.keyId, digest: said.digest });
            return { token, review };
        } catch (error) {
            await rm(dir, { recursive: true, force: true });
            throw error;
        }
    }

    /** Install what was reviewed, with the person's consent to that review. One-use: the review goes either way. */
    async install(token: string, options: { scope: GrantScope; consent?: { digest: string; items: readonly ReviewItem[] } }): Promise<GAppEntry> {
        const staged = this.#reviews.get(token);
        if (!staged) throw new Error('This marketplace review is unknown or already used; review the app again');
        this.#reviews.delete(token);
        try {
            await this.#ports.registry.refresh();
            if (this.#ports.registry.keyState(staged.keyId) !== 'trusted') throw new Error('The publisher\'s key was withdrawn from the registry after the review; nothing was installed');
            const done = await this.#ports.book.install(join(staged.dir, 'contents'), options);
            if (!done.ok) throw new Error(done.reason);
            return done.entry;
        } finally {
            await rm(staged.dir, { recursive: true, force: true });
        }
    }

    async discard(token: string): Promise<void> {
        const staged = this.#reviews.get(token);
        this.#reviews.delete(token);
        if (staged) await rm(staged.dir, { recursive: true, force: true });
    }
}
