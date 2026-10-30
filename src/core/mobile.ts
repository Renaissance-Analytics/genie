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
    // The installed app's icons (genie#1346 PWA): the Genie logo, from the build's `mobile/` folder.
    const icon = /^\/mobile\/((?:icon-(?:192|512|maskable-512))|apple-touch-icon)\.png$/.exec(path);
    if (icon) return { relative: `mobile/${icon[1]}.png`, contentType: 'image/png', cache: 'public, max-age=86400' };
    // The page at `/mobile/` resolves its relative `./assets/…` under `/mobile/assets/` — the same files (genie#1346).
    const m = /^(?:\/mobile)?\/assets\/([^/]+)$/.exec(path);
    if (!m) return null;
    const name = m[1]!;
    if (!ASSET_NAME.test(name) || name.includes('..')) return null;
    const ext = name.slice(name.lastIndexOf('.') + 1);
    const contentType = ASSET_TYPES[ext];
    if (!contentType || ext === name) return null;
    return { relative: `assets/${name}`, contentType, cache: IMMUTABLE };
}

export type MobileViewState =
    | { kind: 'home'; workspaceId: string | null }
    | { kind: 'agent'; agentId: string }
    /** `file`: the path is a file open in the viewer; absent = a folder. */
    | { kind: 'files'; workspaceId: string; path: string; file?: true };

/**
 * WHAT THE PHONE SHOWS rides the hash, so the phone's back button leaves a screen the way it leaves a page:
 * `#ws=<id>` the dashboard narrowed to one workspace, `#agent=<id>` one agent's chat, `#files=<ws>&path=<p>` a workspace's
 * files (a folder, or a file open in the viewer); anything else is the whole dashboard. (The owner, 2026-10-11 and
 * 2026-10-30: the phone is for steering agents — workspaces, dashboard, chat, files — never terminals or panels.)
 */
export function mobileView(hash: string): MobileViewState {
    const agent = /^#agent=(.+)$/.exec(hash);
    if (agent && agent[1]) return { kind: 'agent', agentId: decodeURIComponent(agent[1]) };
    const files = /^#files=([^&]+)(?:&path=([^&]*))?(&file=1)?$/.exec(hash);
    if (files && files[1]) {
        const path = files[2] ? decodeURIComponent(files[2]) : '';
        return files[3] && path ? { kind: 'files', workspaceId: decodeURIComponent(files[1]), path, file: true } : { kind: 'files', workspaceId: decodeURIComponent(files[1]), path };
    }
    const ws = /^#ws=(.+)$/.exec(hash);
    return { kind: 'home', workspaceId: ws && ws[1] ? decodeURIComponent(ws[1]) : null };
}

/** The hash for a view — the one way the phone writes it. */
export function mobileHash(view: MobileViewState): string {
    if (view.kind === 'agent') return `#agent=${encodeURIComponent(view.agentId)}`;
    if (view.kind === 'files') return `#files=${encodeURIComponent(view.workspaceId)}${view.path ? `&path=${encodeURIComponent(view.path)}` : ''}${view.file && view.path ? '&file=1' : ''}`;
    return view.workspaceId ? `#ws=${encodeURIComponent(view.workspaceId)}` : '';
}

export type PreviewKind = 'markdown' | 'image' | 'pdf' | 'text' | 'other';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const OTHER_EXT = new Set(['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'exe', 'dll', 'so', 'dylib', 'bin', 'iso', 'dmg', 'mp4', 'mov', 'mp3', 'wav', 'ogg', 'woff', 'woff2', 'ttf', 'otf', 'xlsx', 'docx', 'pptx', 'sqlite', 'db', 'jar', 'class', 'o', 'pyc', 'wasm', 'ico', 'heic']);

/** How the phone previews a file, by its name: rendered markdown, an image, a PDF to open, text — or offered, not guessed. */
export function previewKind(path: string): PreviewKind {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
    if (IMAGE_EXT.has(ext)) return 'image';
    if (ext === 'pdf') return 'pdf';
    if (OTHER_EXT.has(ext)) return 'other';
    return 'text';
}

/** The MIME type an image or PDF is shown as, by its name. */
export function previewMime(path: string): string {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const map: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', pdf: 'application/pdf' };
    return map[ext] ?? 'application/octet-stream';
}

/** The size a photo is drawn at to fit inside `max` on its longest side — never larger than it was. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
    const longest = Math.max(width, height);
    if (longest <= max) return { width, height };
    const scale = max / longest;
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export type MobilePhase = 'pair' | 'reconnecting' | 'ready';

/**
 * Which screen the phone is on. A phone that was in, and still holds its token, RECONNECTS over the last screen — a
 * dropped socket (it slept, it changed networks) is not a reason to ask for a PIN. Only the host saying this device is
 * not paired (removed in Settings, or expired) sends it back to pairing.
 */
export function mobilePhase(input: { connected: boolean; everConnected: boolean; hasToken: boolean; refusal: string | null }): MobilePhase {
    if (input.connected) return 'ready';
    if (input.refusal && /not paired/i.test(input.refusal)) return 'pair';
    return input.everConnected && input.hasToken ? 'reconnecting' : 'pair';
}

/** How long to wait before redial `attempt` (0-based): quick at first, then backing off to a 15 s ceiling. */
export function reconnectDelay(attempt: number): number {
    return Math.min(15_000, Math.round(500 * 2 ** Math.max(0, Math.min(attempt, 10))));
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
