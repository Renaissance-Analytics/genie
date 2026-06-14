/**
 * OSC-7 cwd reporting (Tier 1.5).
 *
 * A shell that emits OSC-7 tells the terminal its current working directory on
 * every prompt:
 *
 *   ESC ] 7 ; file://HOST/PATH  (BEL | ESC \)
 *
 * We scan raw pty output for these and parse out an absolute filesystem path so
 * a fresh shell spawned on resume can start where the old one left off. The
 * sequence is terminated by either BEL (\x07) or ST (ESC \, i.e. \x1b\x5c).
 *
 * Path forms handled:
 *   file:///home/user/proj          → /home/user/proj
 *   file://hostname/home/user/proj  → /home/user/proj   (host ignored)
 *   file:///C:/Users/me/proj        → C:\Users\me\proj  (Windows drive)
 *   percent-encoded segments (%20)  → decoded
 */

const OSC7_RE = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * Parse a `file://...` URL from an OSC-7 payload into a local filesystem path.
 * Returns null when the payload isn't a usable file URL.
 */
export function parseFileUrl(payload: string): string | null {
    if (!payload.startsWith('file://')) return null;
    let rest = payload.slice('file://'.length);

    // Strip the authority (host) up to the first '/'. `file:///path` has an
    // empty authority; `file://host/path` carries one we don't need.
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    let pathPart = rest.slice(slash); // includes the leading '/'

    let decoded: string;
    try {
        decoded = decodeURIComponent(pathPart);
    } catch {
        decoded = pathPart; // malformed %-escape — use as-is rather than drop
    }

    // Windows drive paths arrive as "/C:/Users/...". Drop the leading slash and
    // flip to backslashes so the value matches what node-pty/Electron expect as
    // a cwd on Windows.
    const winDrive = /^\/([A-Za-z]):(.*)$/.exec(decoded);
    if (winDrive) {
        return `${winDrive[1]}:${winDrive[2]}`.replace(/\//g, '\\');
    }

    return decoded;
}

/**
 * Scan a chunk of pty output and return the LAST cwd reported via OSC-7, or
 * null when the chunk contains no (parseable) OSC-7 sequence. We take the last
 * one because a single chunk can carry several prompts; the most recent wins.
 */
export function scanOsc7Cwd(chunk: string): string | null {
    if (chunk.indexOf('\x1b]7;') === -1) return null; // fast bail
    let last: string | null = null;
    OSC7_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = OSC7_RE.exec(chunk))) {
        const cwd = parseFileUrl(m[1]);
        if (cwd) last = cwd;
    }
    return last;
}
