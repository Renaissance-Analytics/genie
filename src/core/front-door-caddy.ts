import type { GenRoute } from './gen-router.js';

/**
 * THE EXTERNAL-BROWSER PATH (§6.6) — what Genie's bundled Caddy serves on 443 so Chrome/Edge reach
 * `https://<name>.gen`: one site block per route served with GENIE'S OWN leaf (`tls <leaf.crt> <leaf.key>`, issued by
 * Genie's local CA — core/gen-ca.ts — whose root the OS store trusts once, or already trusts when it was Genie 1's)
 * and a reverse_proxy to the site's loopback target; http redirects to https. Bound to loopback only. The in-app
 * browser does not need any of this — it goes through the loopback front door directly.
 *
 * Never `tls internal`: that is Caddy's own "Caddy Local Authority", a second root nobody trusted, and every site
 * behind it was a certificate error in the person's browser (2026-10-14).
 */

const LOOPBACK_TARGET = /^127\.0\.0\.1:\d{1,5}$/;

/** The leaf's files on disk. */
export interface FrontDoorTls {
    readonly certPath: string;
    readonly keyPath: string;
}

/** A path in the Caddyfile: quoted, `\` as `/` (Caddy reads either on Windows, and it dodges escaping), and nothing that could close the quote or open a block. */
function caddyPath(path: string, which: string): string {
    const p = path.replace(/\\/g, '/');
    if (p.length === 0 || /["\r\n{}]/.test(p)) throw new Error(`the ${which} path ${JSON.stringify(path)} cannot be written into a Caddyfile`);
    return `"${p}"`;
}

export function frontDoorCaddyfile(routes: readonly GenRoute[], tls: FrontDoorTls | null): string {
    for (const r of routes) if (!LOOPBACK_TARGET.test(r.target)) throw new Error(`${r.host} → ${r.target}: the front door proxies loopback targets only`);
    if (routes.length > 0 && tls === null) throw new Error('the front door serves its routes with Genie’s certificate, and there is none');
    // skip_install_trust: Caddy installs its local root into the OS trust store on start unless told not to, which put
    // an unasked Windows certificate prompt in front of the owner (2026-10-14). Only the person's Trust installs trust.
    const blocks: string[] = ['{\n\tdefault_bind 127.0.0.1\n\tskip_install_trust\n\tauto_https disable_redirects\n}'];
    if (tls !== null && routes.length > 0) {
        const line = `tls ${caddyPath(tls.certPath, 'certificate')} ${caddyPath(tls.keyPath, 'key')}`;
        for (const r of routes) blocks.push(`https://${r.host} {\n\t${line}\n\treverse_proxy ${r.target}\n}`);
        blocks.push(`${routes.map((r) => `http://${r.host}`).join(', ')} {\n\tredir https://{host}{uri} permanent\n}`);
    }
    return `${blocks.join('\n\n')}\n`;
}

export function hostsFilePath(platform: NodeJS.Platform): string {
    return platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
}
