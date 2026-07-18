import { stripHostPort } from '../remote/site-proxy';

/**
 * Display-independent logic for the Testing Browser (serve-local-sites Phase D,
 * design §4). Split out from the Electron window/session wiring (index.ts) so the
 * URL/preset rules are unit-testable in plain Node — the `WebContentsView` +
 * `session` wiring itself needs the Electron runtime (the E2E gate).
 */

/** A device-emulation preset for the chrome's viewport selector. `width`/`height`
 *  are the CONTENT viewport (the WebContentsView bounds), not the OS window. */
export interface DevicePreset {
    id: string;
    label: string;
    /** Content width in px; null = "fit" (fill whatever the chrome reserves). */
    width: number | null;
    height: number | null;
}

/** Presets surfaced in the chrome. `fit` fills the reserved content area; the
 *  rest emulate common device widths for responsive dev-testing. */
export const DEVICE_PRESETS: DevicePreset[] = [
    { id: 'fit', label: 'Fit', width: null, height: null },
    { id: 'desktop', label: 'Desktop 1280', width: 1280, height: 800 },
    { id: 'laptop', label: 'Laptop 1024', width: 1024, height: 768 },
    { id: 'tablet', label: 'Tablet 768', width: 768, height: 1024 },
    { id: 'mobile', label: 'Mobile 390', width: 390, height: 844 },
];

/** Look up a preset by id (defaults to `fit`). */
export function devicePreset(id: string): DevicePreset {
    return DEVICE_PRESETS.find((p) => p.id === id) ?? DEVICE_PRESETS[0];
}

/**
 * PURE. Normalize a user's URL-bar input into a canonical `https://<name>.gen/…`
 * URL, ENFORCING the enabled-`.gen` allowlist (the same set the shim resolves).
 * Accepts `tynn.gen`, `https://tynn.gen/path`, `http://tynn.gen` (upgraded to
 * https — `.gen` is https-only), or a BARE repo label `tynn` when `tynn.gen` is
 * enabled. Anything that doesn't resolve to an enabled `.gen` name is rejected
 * (this is UX pre-validation; the shim is the authoritative gate).
 */
export function normalizeNavUrl(
    input: string,
    enabledHosts: ReadonlySet<string>,
    aliases: ReadonlyMap<string, string> = new Map(),
): { url: string } | { error: string } {
    const raw = (input ?? '').trim();
    if (!raw) return { error: 'Enter an enabled development address.' };
    const looksBare = /^[a-z0-9-]+$/i.test(raw);
    const aliasCandidate = looksBare ? `${raw.toLowerCase()}.gen` : raw;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(aliasCandidate)
        ? aliasCandidate
        : `https://${aliasCandidate}`;
    let u: URL;
    try {
        u = new URL(withScheme);
    } catch {
        return { error: 'That is not a valid address.' };
    }
    const inputHost = stripHostPort(u.hostname);
    const host = aliases.get(inputHost) ?? inputHost;
    if (!enabledHosts.has(host)) {
        return { error: `${host} is not an enabled tunnel on this host.` };
    }
    // Force https + the resolved host; keep path/query/hash.
    return { url: `https://${host}${u.pathname}${u.search}${u.hash}` };
}

/** PURE. The initial URL to open — the first enabled `.gen`, else null (the chrome
 *  then shows the empty-state with the enabled-site chips). */
export function initialGenUrl(enabledGenHosts: readonly string[]): string | null {
    const first = enabledGenHosts[0];
    return first ? `https://${first}/` : null;
}
