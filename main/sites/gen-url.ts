/**
 * PURE URL builder for the `.gen` sites feature (serve-local-sites). No Electron
 * — unit-tested directly.
 */

/** The `https://<name>.gen` URL a Testing Browser tab opens for an enabled site
 *  (local via the loopback carrier, or remote via the tunnel). */
export function remoteGenUrl(genName: string): string {
    const bare = genName.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return `https://${bare}`;
}
