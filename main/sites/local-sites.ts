import { devServerGenSites } from '../dev-server/site-manager';
import { devServiceManager } from '../dev-server/services/service-manager';
import type { ResolvedSite } from '../mobile/site-proxy';
import type { EnabledGenSite } from '../remote';
import type { LocalTarget } from './local-carrier';

/**
 * THIS machine's `.gen` dev sites — the ones the container DEV SERVER (#234) is
 * serving right now, and nothing else.
 *
 * ## One source, on purpose
 *
 * There used to be a second: the OS hosts file, parsed for loopback `*.test`
 * vhosts and probed for a scheme/port, then tunnelled under a derived `.gen`
 * name. That is the "expose a site you are running elsewhere" model — it can
 * only DESCRIBE something Herd or a stray `npm run dev` happens to serve, so
 * Genie could not start it, restart it, log it, or say what it is. The
 * container Dev Server replaced it outright: a site is a container Genie
 * created, and its target is the loopback port the runtime published, read
 * back. `.gen` sites are not configured from what is found in the hosts file.
 *
 * ## What did NOT change
 *
 * The carrier. A running site is an ordinary {@link EnabledGenSite} whose
 * `port` is that published port, so `localTargetsBySiteId` → the local site
 * carrier (a local viewer) and `/api/sites/enabled` → the remote shim (a remote
 * one) both serve it with no code of their own, exactly as before. Retiring the
 * hosts file changed WHERE the rows come from, not what a row is or who carries
 * it — which is why the Testing Browser, the session CA and the site shim are
 * untouched.
 *
 * Synchronous underneath (the manager holds the live set in memory) but kept
 * `async` because every caller already awaits it, and because the host-sourced
 * sibling on the remote path genuinely is.
 */
export async function listLocalEnabledGenSites(): Promise<EnabledGenSite[]> {
    return [...devServerGenSites(), ...(devServiceManager()?.genSites() ?? [])];
}

/**
 * Resolve one opaque `siteId` to the loopback target the HOST site-proxy dials
 * for a remote viewer — from the SAME set {@link listLocalEnabledGenSites}
 * publishes.
 *
 * That shared source is the point. The listing and the resolver answer two
 * halves of one question ("which sites exist" / "where is this one"), and when
 * they read different sources they disagree: a remote's browser would offer a
 * site the host then 404'd, which is exactly what a hosts-file resolver did to
 * every Dev Server site. Anything that is not in the published set resolves to
 * `null` — which is also the SSRF floor, since a remote supplies nothing but
 * this id.
 */
export async function resolveEnabledSite(siteId: string): Promise<ResolvedSite | null> {
    if (!siteId) return null;
    const site = (await listLocalEnabledGenSites()).find((s) => s.siteId === siteId);
    if (!site) return null;
    return {
        workspaceId: site.workspaceId,
        hostname: site.hostname,
        scheme: site.scheme,
        port: site.port,
        ...(site.loopback ? { loopback: site.loopback } : {}),
        ...(site.allowedOrigins ? { allowedOrigins: site.allowedOrigins } : {}),
    };
}

/** The loopback-dial target for each enabled site, keyed by siteId — what the
 *  local Testing Browser's carrier resolves against. */
export function localTargetsBySiteId(sites: EnabledGenSite[]): Map<string, LocalTarget> {
    const m = new Map<string, LocalTarget>();
    for (const s of sites) {
        m.set(s.siteId, {
            scheme: s.scheme,
            hostname: s.hostname,
            port: s.port,
            loopback: s.loopback,
        });
    }
    return m;
}
