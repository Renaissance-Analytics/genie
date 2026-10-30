import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MOBILE_PATH, staticFile } from '../core/mobile.js';
import { MOBILE_SW, mobileHtml, mobileManifest } from '../core/mobile-pwa.js';

/** What the listener hands back for a GET it serves. */
export interface ServedFile {
    body: Uint8Array;
    contentType: string;
    cache: string;
    /** Extra response headers (the service worker's `Service-Worker-Allowed`). */
    headers?: Readonly<Record<string, string>>;
}

export type PageServer = (urlPath: string) => Promise<ServedFile | null>;

export interface StaticServerOptions {
    /** This host's name — what its installable app is called (genie#1346 PWA). Absent = no manifest, no worker. */
    readonly hostName?: () => string;
}

const text = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

/**
 * THE PHONE'S PAGE FROM DISK (§6.8). `staticFile` decides what a path may mean; this reads it from
 * the built renderer directory and nothing else. A file the allow-list names but the build did not
 * produce is null, the same as a path the list refuses — the listener turns both into a 404.
 *
 * THE INSTALLABLE APP (genie#1346): with a host name, `/mobile/manifest.webmanifest` is this host's manifest and
 * `/mobile/sw.js` the app-shell worker (allowed to scope `/mobile`), both generated, never cached by the browser's HTTP
 * cache; and the page at `/mobile` carries the manifest, the phone viewport and the home-screen tags. `/` — the page a
 * desktop window is — is served as it was built.
 */
export function staticServer(root: string, options: StaticServerOptions = {}): PageServer {
    return async (urlPath) => {
        const path = urlPath.split(/[?#]/, 1)[0] ?? '';
        const host = options.hostName;
        if (host && path === `${MOBILE_PATH}/manifest.webmanifest`) {
            return { body: text(JSON.stringify(mobileManifest(host()), null, 2)), contentType: 'application/manifest+json; charset=utf-8', cache: 'no-cache' };
        }
        if (host && path === `${MOBILE_PATH}/sw.js`) {
            return { body: text(MOBILE_SW), contentType: 'text/javascript; charset=utf-8', cache: 'no-cache', headers: { 'Service-Worker-Allowed': MOBILE_PATH } };
        }
        const file = staticFile(urlPath);
        if (!file) return null;
        try {
            const body = await readFile(join(root, file.relative));
            if (host && file.relative === 'index.html' && (path === MOBILE_PATH || path === `${MOBILE_PATH}/`)) {
                return { body: text(mobileHtml(body.toString('utf8'), host())), contentType: file.contentType, cache: file.cache };
            }
            return { body, contentType: file.contentType, cache: file.cache };
        } catch {
            return null;
        }
    };
}
