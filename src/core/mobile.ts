import { ATTACHMENT_LIMITS, isExecutableName } from './inbox.js';
import { REMOTE_PATH } from './tailscale.js';

/**
 * THE PHONE'S DOOR (§6.8 mobile UI) — the three pure decisions behind it.
 *
 * The host's Tailscale listener carries the remote socket at `/genie`; the same port serves the
 * built renderer at `/mobile`. A phone on the tailnet opens that page, pairs with the PIN the
 * desktop shows (typed, or carried in the QR as `#pin=`), and drives the host over a socket back
 * to the SAME origin. Nothing here touches the network or the disk: what the QR points at, when
 * the renderer is the phone's shell, and which files the port may hand out are each a function
 * of their inputs, and each is pinned by a test.
 */

/** The page path. The socket path is `REMOTE_PATH`; the two share the port and nothing else. */
export const MOBILE_PATH = '/mobile';

/**
 * The page a phone opens, derived from the socket URL Settings shows: `ws://h:p/genie` →
 * `http://h:p/mobile` (and `wss` → `https`). Null for anything that is not a Genie socket URL.
 */
export function mobilePageUrl(socketUrl: string | null): string | null {
    if (!socketUrl) return null;
    const m = /^(wss?):\/\/([^/?#]+)(\/genie)?\/?$/.exec(socketUrl);
    if (!m) return null;
    return `${m[1] === 'wss' ? 'https' : 'http'}://${m[2]}${MOBILE_PATH}`;
}

export type MobileEntry =
    | { kind: 'desktop' }
    /** The served page in a browser: dial the socket on the page's own origin; the PIN, when the QR carried one. */
    | { kind: 'mobile'; socketUrl: string; pin: string | null };

/** The slice of `window.location` the decision reads. */
export interface EntryLocation {
    protocol: string;
    host: string;
    pathname: string;
    hash: string;
}

const PIN = /^#pin=(\d{6})$/;

/**
 * The renderer is the phone's shell when it was SERVED (http/https) at the page path and no
 * desktop bridge is present. A `file://` load, any other path, or a preload-provided bridge is
 * the desktop, whatever the hash says. A PIN is six digits or it is not a PIN.
 */
export function mobileEntry(location: EntryLocation, hasBridge: boolean): MobileEntry {
    if (hasBridge) return { kind: 'desktop' };
    const secure = location.protocol === 'https:';
    if (!secure && location.protocol !== 'http:') return { kind: 'desktop' };
    const path = location.pathname.endsWith('/') && location.pathname.length > 1 ? location.pathname.slice(0, -1) : location.pathname;
    if (path !== MOBILE_PATH) return { kind: 'desktop' };
    const pin = PIN.exec(location.hash)?.[1] ?? null;
    return { kind: 'mobile', socketUrl: `${secure ? 'wss' : 'ws'}://${location.host}${REMOTE_PATH}`, pin };
}

export interface StaticFile {
    /** Relative to the built renderer directory, forward slashes. */
    relative: string;
    contentType: string;
    cache: string;
}

const HTML: StaticFile = { relative: 'index.html', contentType: 'text/html; charset=utf-8', cache: 'no-store' };
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Vite's output extensions, and only those. An unknown extension is not served, whatever the file is. */
const ASSET_TYPES: Readonly<Record<string, string>> = {
    js: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    map: 'application/json; charset=utf-8',
    woff2: 'font/woff2',
    wav: 'audio/wav',
    svg: 'image/svg+xml',
    png: 'image/png',
};
/** One path segment of safe characters. No slash of either kind, no dot-dot, nothing encoded. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Which file a request path maps to — an ALLOW-LIST, not a filesystem walk. The page routes serve
 * `index.html`; `/assets/<one safe segment>.<known ext>` serves that asset; everything else is
 * null. Traversal cannot be expressed: a name with a slash, a backslash, a percent-escape or a
 * `..` fails the segment pattern before any path is built.
 */
export function staticFile(urlPath: string): StaticFile | null {
    const path = urlPath.split(/[?#]/, 1)[0] ?? '';
    if (path === '/' || path === MOBILE_PATH || path === `${MOBILE_PATH}/`) return HTML;
    const m = /^\/assets\/([^/]+)$/.exec(path);
    if (!m) return null;
    const name = m[1]!;
    if (!ASSET_NAME.test(name) || name.includes('..')) return null;
    const ext = name.slice(name.lastIndexOf('.') + 1);
    const contentType = ASSET_TYPES[ext];
    if (!contentType || ext === name) return null;
    return { relative: `assets/${name}`, contentType, cache: IMMUTABLE };
}

export type Orientation = 'portrait' | 'landscape';

/**
 * THE TERMINAL IS LANDSCAPE-ONLY on a phone (§6.8): eighty columns are not readable sideways-less.
 * Portrait gets the sentence and no pane; a browser that cannot report its orientation gets no pane
 * either, with that said rather than guessed.
 */
export function mobileTerminal(orientation: Orientation | null): { allowed: true } | { allowed: false; reason: string } {
    if (orientation === 'landscape') return { allowed: true };
    if (orientation === 'portrait') return { allowed: false, reason: 'Rotate to landscape for the terminal.' };
    return { allowed: false, reason: 'This browser does not report its orientation, so the terminal stays closed.' };
}

const MB = 1024 * 1024;

/**
 * What the inbox would refuse (§6.4), said BEFORE the bytes leave the phone: a natively executable
 * name, a file over the per-file cap, no name, no bytes. `null` means the inbox gets to decide.
 */
export function uploadRefusal(name: string, bytes: number): string | null {
    if (name.trim().length === 0) return 'the file has no name';
    if (isExecutableName(name)) return `${name} is a natively executable file and is refused`;
    if (bytes === 0) return `${name} is empty`;
    if (bytes > ATTACHMENT_LIMITS.perFileBytes) return `${name} is ${Math.ceil(bytes / MB)} MB; the limit is ${ATTACHMENT_LIMITS.perFileBytes / MB} MB per file`;
    return null;
}

/** Base64 for the wire, in chunks — one `btoa` over a spread of a few MB blows the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return btoa(binary);
}
