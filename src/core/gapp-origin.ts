/**
 * WHERE A GAPP LIVES (GApps v2, V4, Tynn #569; spec .ai/plans/specs/gapps-v2.md, decision 4) — pure. Each app is served at
 * its own origin, `<app-slug>.apps.gen`, a preview at `<app-slug>.preview.apps.gen`, so no app shares a browser origin with
 * another, or with its own preview. `apps` is kept from sites (core/gen-name.ts).
 */
export const APPS_DOMAIN = 'apps.gen';
export const PREVIEW_DOMAIN = 'preview.apps.gen';

/** The path of an app's channel to the host, on its own origin. */
export const APP_CHANNEL_PATH = '/.genie/channel';

const MAX_LABEL = 63;

/** FNV-1a: enough to keep two long ids apart in one DNS label, with no Node import. */
function fnv(text: string, seed: number): string {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** A package id as one DNS label: `com.example.notes` → `com-example-notes`; a long one is cut and given a hash of the whole. */
export function appSlug(packageId: string): string {
    const plain = packageId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (plain.length <= MAX_LABEL) return plain;
    const tail = `${fnv(packageId, 0x811c9dc5)}${fnv(packageId, 0x1000193)}`;
    return `${plain.slice(0, MAX_LABEL - tail.length - 1).replace(/-+$/, '')}-${tail}`;
}

export const appHost = (packageId: string): string => `${appSlug(packageId)}.${APPS_DOMAIN}`;
export const previewHost = (packageId: string): string => `${appSlug(packageId)}.${PREVIEW_DOMAIN}`;

/** The page's CSP: its own origin, and for connections, only the hosts the person granted. */
export function appCsp(network: readonly string[]): string {
    const granted = network.flatMap((host) => [`https://${host}`, `wss://${host}`]);
    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src 'self'${granted.length > 0 ? ` ${granted.join(' ')}` : ''}`,
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
    ].join('; ') + ';';
}
