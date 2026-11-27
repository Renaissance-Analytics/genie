/**
 * A LOCAL TRACK FEED (Tynn #1058 L6): GitHub's REST release list, served on 127.0.0.1 as `GET /repos/o/r/releases` answers
 * it, for the launcher's update rows. It is the Node twin of native/launcher/tests/common/feed.rs, the feed the launcher's
 * own Rust tests read, and answers the same way:
 *
 *   - each track's release on its own tag (`<track>-v<build>`), never a draft (GitHub lists drafts only to a token, and the
 *     launcher has none), with its package, manifest and signature as assets named exactly as scripts/pack-track.mjs and
 *     scripts/sign-manifest.mjs write them (`<track>-<build>-<platform>-<arch>.{manifest.json,manifest.json.sig,zip|tar.zst}`);
 *   - the list with an ETag, and `304 Not Modified` to a matching If-None-Match, so the launcher's cached copy is used;
 *   - each asset at `/download/<name>`, streamed from the folder it was published from.
 *
 * Plain http on 127.0.0.1 is the one plain address the launcher reads (feed.rs `url_allowed`). The feed only serves what a
 * row put in it: an asset name is a published file's name or it is 404, never a path.
 *
 *   import { startFeed } from './ci/local-track-feed.mjs';
 *   const feed = await startFeed();
 *   feed.publish({ track: 'client', build: '2026.11.27-2', dir: '<folder with the package>' });
 *   // GENIE_LAUNCHER_FEED=feed.url
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

/** This machine's platform and architecture as the manifests name them (pack-track.mjs PLATFORMS, ARCHES). */
export const PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';
export const ARCH = process.arch;

const etagOf = (body) => `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;

/** The feed, listening on a free port of 127.0.0.1: its url, publish, what it was asked for, and close. */
export async function startFeed() {
    const releases = [];
    /** Every published asset by name, and the file it is served from. */
    const files = new Map();
    const hits = { lists: 0, notModified: 0, assets: [] };
    const server = createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        const send = (status, headers, body) => {
            res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), Connection: 'close', ...headers });
            res.end(body);
        };
        if (path.startsWith('/repos/o/r/releases')) {
            hits.lists += 1;
            const body = JSON.stringify(releases);
            const etag = etagOf(body);
            if (req.headers['if-none-match'] === etag) {
                hits.notModified += 1;
                res.writeHead(304, { ETag: etag, 'Content-Length': 0, Connection: 'close' });
                res.end();
                return;
            }
            send(200, { ETag: etag, 'Content-Type': 'application/json' }, body);
            return;
        }
        if (path.startsWith('/download/')) {
            const name = decodeURIComponent(path.slice('/download/'.length));
            const file = files.get(name);
            if (!file || !existsSync(file)) { send(404, {}, 'not found'); return; }
            hits.assets.push(name);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(file).size, Connection: 'close' });
            createReadStream(file).pipe(res);
            return;
        }
        send(404, {}, 'not found');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    return {
        port,
        /** What the launcher is told to read (GENIE_LAUNCHER_FEED). */
        url: `http://127.0.0.1:${port}/repos/o/r/releases`,
        /**
         * The release of a package already in `dir` (its archive, manifest and signature), on the tag `<track>-v<build>`,
         * listed first (GitHub lists the newest first). Throws when the folder lacks any of the three.
         */
        publish({ track, build, dir, prerelease = false, notes = null }) {
            const stem = `${track}-${build}-${PLATFORM}-${ARCH}`;
            const assets = [];
            for (const ext of ['.manifest.json', '.manifest.json.sig', '.zip', '.tar.zst']) {
                const name = `${stem}${ext}`;
                const file = join(dir, name);
                if (!existsSync(file)) continue;
                files.set(name, file);
                assets.push({ name, size: statSync(file).size, browser_download_url: `http://127.0.0.1:${port}/download/${encodeURIComponent(name)}` });
            }
            if (assets.length < 3) throw new Error(`the feed cannot publish ${stem}: ${dir} does not hold its package, manifest and signature`);
            releases.unshift({ tag_name: `${track}-v${build}`, name: `${track} ${build}`, draft: false, prerelease, body: notes ?? `What is new in ${track} ${build}.`, assets });
            return stem;
        },
        hits: () => ({ lists: hits.lists, notModified: hits.notModified, assets: [...hits.assets] }),
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    };
}
