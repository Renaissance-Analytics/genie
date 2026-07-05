import type { SiteScheme } from '../mobile/hosts';

/**
 * PURE URL builders for the header `.gen` sites popover (serve-local-sites).
 * No Electron — unit-tested directly.
 */

/**
 * The REAL loopback URL a locally-served dev site answers on — what a Genie
 * browser window on THIS machine opens. Locally the machine already resolves
 * and trusts its own dev hostname (Herd/Valet/Caddy install their CA), so no
 * `.gen` remap or proxy is needed — that machinery exists only so a REMOTE
 * machine (which can't resolve `tynn.test`) can reach it. The default port for
 * the scheme is omitted so the URL reads clean.
 */
export function localSiteUrl(scheme: SiteScheme, hostname: string, port: number): string {
    const isDefault = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
    return isDefault ? `${scheme}://${hostname}` : `${scheme}://${hostname}:${port}`;
}

/** The remote-facing `https://<name>.gen` URL a host's Testing Browser opens. */
export function remoteGenUrl(genName: string): string {
    const bare = genName.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return `https://${bare}`;
}
