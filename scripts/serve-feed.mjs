#!/usr/bin/env node
/**
 * A LOCAL UPDATE FEED — static files over HTTP, for the updater proof in the test VM.
 *
 *   node scripts/serve-feed.mjs <dir> [port]        (default port 8099, binds 127.0.0.1 only)
 *
 * electron-updater's `generic` provider wants exactly what electron-builder already wrote
 * into `release/`: `latest.yml` (version, file name, sha512, size) and the installer it names.
 * Serving that directory as-is IS the feed — no GitHub, no release, nothing published. The
 * only difference from the real channel is the URL in `app-update.yml`.
 *
 * Every request is logged with its status and byte count, because "the updater never
 * fetched" has to be distinguishable from "the feed never served".
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';

const dir = process.argv[2];
const port = Number(process.argv[3] ?? 8099);
if (!dir) {
    console.error('usage: serve-feed.mjs <dir> [port]');
    process.exit(2);
}

const server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '');
    const file = join(dir, rel);
    if (!file.startsWith(normalize(dir))) {
        res.writeHead(403).end();
        console.log(`[feed] 403 ${req.method} ${req.url}`);
        return;
    }
    let size;
    try {
        size = statSync(file).size;
    } catch {
        res.writeHead(404).end();
        console.log(`[feed] 404 ${req.method} ${req.url}`);
        return;
    }
    // Range requests: electron-updater's differential download asks for them against the
    // blockmap; answering 200 with the whole file is a valid, if un-clever, response.
    res.writeHead(200, {
        'content-length': size,
        'content-type': file.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
    });
    if (req.method === 'HEAD') { res.end(); console.log(`[feed] 200 HEAD ${req.url} ${size}`); return; }
    createReadStream(file).pipe(res);
    res.on('finish', () => console.log(`[feed] 200 GET ${req.url} ${size}`));
});

server.listen(port, '127.0.0.1', () => {
    console.log(`[feed] serving ${dir} on http://127.0.0.1:${port}/`);
});
