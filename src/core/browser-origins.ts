import { normalizeHost, resolveRoute, type GenRoute } from './gen-router.js';

/**
 * EACH `.gen` SITE AT ITS OWN HTTPS ORIGIN IN THE GENIE BROWSER (S7) — the pure half.
 *
 * Before this, the pane loaded `http://127.0.0.1:<port>` with a `.gen` Host header, so every site shared the
 * 127.0.0.1 cookie jar (two Laravel apps' `laravel_session` overwrote each other) and ran over http. Now the pane loads
 * `https://<name>.gen/` itself, and three rules make that origin real without touching anything that is not `.gen`:
 *
 * 1. ROUTING — the pane's session (and only that session) gets a PAC script that sends `*.gen` to the in-app loopback
 *    front door as an HTTP proxy and every other host `DIRECT`. Chromium reaches `https://<name>.gen` with
 *    `CONNECT <name>.gen:443`; no hosts file, no DNS, no external Caddy are needed for the in-app browser.
 * 2. THE TUNNEL — the front door accepts `CONNECT` only for a `.gen` site it serves, only on 443, and terminates TLS
 *    there with Genie's own leaf (core/gen-ca.ts). It is never a general proxy: anything else is refused at CONNECT.
 * 3. TRUST — the session's certificate check accepts a `.gen` host's certificate only when it is a leaf SIGNED by
 *    Genie's CA, names that host and is in date; any other certificate for a `.gen` host is refused. Outside `.gen`
 *    Chromium's own verdict stands, except that Genie's CA never vouches for a name outside `.gen`.
 */

/** Any name under `.gen` (RFC 1123 labels). Wider than a site name on purpose: everything under `.gen` is Genie's. */
const GEN_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+gen$/;

export function isGenHost(host: string | undefined): boolean {
    const h = normalizeHost(host);
    return h !== null && GEN_NAME.test(h);
}

/** The origin a site opens at: `https://<name>.gen`. */
export function siteOrigin(host: string): string {
    const h = normalizeHost(host);
    if (h === null || !GEN_NAME.test(h)) throw new Error(`${JSON.stringify(host)} is not a .gen name`);
    return `https://${h}`;
}

const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535;

/**
 * The PAC script for the pane's session: `*.gen` → `PROXY 127.0.0.1:<front door>`, everything else `DIRECT`. The test
 * is the same expression `isGenHost` uses, inlined, so the script needs nothing from the PAC runtime (no dnsResolve:
 * a `.gen` name is never looked up in DNS).
 */
export function genProxyPac(frontDoorPort: number): string {
    if (!validPort(frontDoorPort)) throw new Error(`${frontDoorPort} is not a port the front door can listen on`);
    return [
        'function FindProxyForURL(url, host) {',
        `    if (/${GEN_NAME.source}/.test(String(host).toLowerCase().replace(/\\.$/, ''))) return "PROXY 127.0.0.1:${frontDoorPort}";`,
        '    return "DIRECT";',
        '}',
    ].join('\n');
}

/**
 * Electron's ProxyConfig for `session.setProxy` (electronjs.org/docs/latest/api/structures/proxy-config): `mode:
 * 'pac_script'` with the script as a base64 `data:` URL, so nothing has to serve it.
 */
export function genProxyConfig(frontDoorPort: number): { mode: 'pac_script'; pacScript: string } {
    return { mode: 'pac_script', pacScript: `data:application/x-ns-proxy-autoconfig;base64,${btoa(genProxyPac(frontDoorPort))}` };
}

/**
 * `session.setCertificateVerifyProc`'s answers (electronjs.org/docs/latest/api/session#sessetcertificateverifyprocproc):
 * 0 = trusted, -2 = refused, -3 = Chromium's own verification result.
 */
export const CERT_ACCEPT = 0;
export const CERT_REFUSE = -2;
export const CERT_USE_CHROMIUM = -3;
export type CertificateVerdict = typeof CERT_ACCEPT | typeof CERT_REFUSE | typeof CERT_USE_CHROMIUM;

/** What main/browser-trust.ts read from the presented certificate. `null` = it could not be read at all. */
export interface CertificateFacts {
    /** A leaf (not a CA) whose signature verifies against Genie's CA's public key. */
    readonly signedByGenieCa: boolean;
    /** Its subjectAltName names exactly the host being visited (no wildcards). */
    readonly namesHost: boolean;
    /** Now is within notBefore..notAfter. */
    readonly inDate: boolean;
}

export function certificateVerdict(hostname: string, facts: CertificateFacts | null): CertificateVerdict {
    if (isGenHost(hostname)) return facts !== null && facts.signedByGenieCa && facts.namesHost && facts.inDate ? CERT_ACCEPT : CERT_REFUSE;
    // Outside .gen nothing is loosened: Chromium decides, as before. Genie's CA only ever issues .gen names, so a
    // certificate it signed for any other name is refused outright, even where the OS store trusts Genie's root.
    return facts?.signedByGenieCa ? CERT_REFUSE : CERT_USE_CHROMIUM;
}

/** What the front door does with `CONNECT <authority>`. */
export type ConnectResolution =
    | { readonly kind: 'site'; readonly host: string; readonly target: string }
    | { readonly kind: 'refused'; readonly status: 400 | 404 | 421; readonly reason: string };

export function resolveConnect(authority: string | undefined, routes: readonly GenRoute[]): ConnectResolution {
    const m = /^([^\s:[\]/]+):(\d{1,5})$/.exec((authority ?? '').trim());
    if (!m) return { kind: 'refused', status: 400, reason: `${JSON.stringify(authority ?? '')} is not host:port` };
    const route = resolveRoute(m[1], routes);
    if (route.kind === 'not-gen') return { kind: 'refused', status: 421, reason: 'the front door tunnels .gen sites only' };
    if (Number(m[2]) !== 443) return { kind: 'refused', status: 421, reason: `${route.host} is served over https on 443 only` };
    if (route.kind === 'no-site') return { kind: 'refused', status: 404, reason: `nothing is serving ${route.host}` };
    return { kind: 'site', host: route.host, target: route.target };
}

/**
 * A proxied plain-http request (absolute-form, `GET http://<name>.gen/x`) — what the PAC sends for an `http://` `.gen`
 * URL. It is upgraded to the site's https origin, as the external front door's Caddy does; anything not under `.gen`
 * is refused, so the front door is not an http proxy either.
 */
export function absoluteFormAnswer(requestTarget: string): { kind: 'origin-form' } | { kind: 'upgrade'; location: string } | { kind: 'refused' } {
    if (requestTarget.startsWith('/') || requestTarget === '*') return { kind: 'origin-form' };
    let url: URL;
    try {
        url = new URL(requestTarget);
    } catch {
        return { kind: 'refused' };
    }
    if (url.protocol !== 'http:' || !isGenHost(url.hostname)) return { kind: 'refused' };
    return { kind: 'upgrade', location: `${siteOrigin(url.hostname)}${url.pathname}${url.search}` };
}
