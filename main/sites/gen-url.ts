/**
 * PURE URL + scheme vocabulary for the `.gen` sites feature. No Electron — unit
 * tested directly, and imported by both the local carrier and the host
 * site-proxy, which is why it lives here rather than in either of them.
 */

/** The scheme a site is served under at its loopback target. */
export type SiteScheme = 'http' | 'https';

/** The `https://<name>.gen` URL a Testing Browser tab opens for an enabled site
 *  (local via the loopback carrier, or remote via the tunnel). */
export function remoteGenUrl(genName: string): string {
    const bare = genName.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return `https://${bare}`;
}
