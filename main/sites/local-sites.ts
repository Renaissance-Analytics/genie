import { listWorkspaces, getWorkspaceTunnelSites } from '../db';
import { devServerGenSites } from '../dev-server/site-manager';
import { discoverSites } from '../mobile/hosts';
import type { EnabledGenSite } from '../remote';
import type { LocalTarget } from './local-carrier';

/**
 * PURE. Overlay the sites GENIE HOSTS onto the ones it merely DISCOVERED.
 *
 * Two sources answer the same question here, and they answer it differently:
 *
 *   - DISCOVERY (hosts file + loopback probe) can only describe sites something
 *     ELSE serves — Herd, `artisan serve`, `npm run dev`. Those are the volatile
 *     origins (a second Vite port, an HMR socket, absolute asset URLs) that made
 *     remote preview unreliable.
 *   - HOSTING (Genie's own runtime, #232) serves a BUILT app at one stable
 *     same-origin port we chose.
 *
 * So when both describe a site, the hosted one wins — that is the entire point
 * of hosting it. A hosted entry displaces a discovered one on EITHER key: the
 * opaque `siteId` (same hostname, possibly a renamed `.gen`) or the `.gen` name
 * itself (a different hostname pointed at the same browser-facing name).
 * Matching on only one of them would leave two rows that
 * {@link localTargetsBySiteId} then resolves by iteration order.
 *
 * The replacement keeps the displaced entry's POSITION, so the header popover
 * and the Testing Browser's first tab do not reshuffle when a site starts.
 */
export function mergeHostedSites(
    discovered: EnabledGenSite[],
    hosted: EnabledGenSite[],
): EnabledGenSite[] {
    if (hosted.length === 0) return discovered;
    const merged = [...discovered];
    for (const site of hosted) {
        const at = merged.findIndex(
            (d) => d.siteId === site.siteId || d.genName === site.genName,
        );
        if (at === -1) {
            merged.push(site);
            continue;
        }
        merged[at] = site;
        // A hosted site can displace TWO discovered rows (one sharing its
        // siteId, another squatting its `.gen`); drop any further duplicates.
        for (let i = merged.length - 1; i > at; i -= 1) {
            const other = merged[i]!;
            if (other.siteId === site.siteId || other.genName === site.genName) {
                merged.splice(i, 1);
            }
        }
    }
    return merged;
}

/**
 * THIS machine's ENABLED `.gen` dev sites, aggregated across every workspace's
 * tunnel config. The enable/`.gen`-name/scheme/port live per-workspace (the
 * serve-local allowlist), so a site is "on" if ANY workspace enabled it; we
 * dedupe by `.gen` name (first enable wins). This is the source of truth for
 * BOTH the header `.gen` popover (enabled-only — never the raw hosts file) and
 * the local Testing Browser's resolver map. Discovery is machine-wide and
 * probe-cached, so iterating workspaces is cheap.
 *
 * Sites Genie HOSTS itself are overlaid on top — see {@link mergeHostedSites}.
 * That is the whole integration: `HostedStatus.target` already IS a
 * {@link LocalTarget}, so the local carrier, the site shim, the session CA and
 * the browser chrome need no change, because none of them ever learns where a
 * target came from.
 */
export async function listLocalEnabledGenSites(): Promise<EnabledGenSite[]> {
    const byGen = new Map<string, EnabledGenSite>();
    for (const ws of listWorkspaces()) {
        const cfg = getWorkspaceTunnelSites(ws.id);
        if (Object.keys(cfg).length === 0) continue;
        let views;
        try {
            views = await discoverSites(cfg);
        } catch {
            continue;
        }
        for (const v of views) {
            if (!v.enabled || byGen.has(v.genName)) continue;
            byGen.set(v.genName, {
                workspaceId: ws.id,
                genName: v.genName,
                siteId: v.siteId,
                hostname: v.hostname,
                scheme: v.scheme,
                port: v.port,
            });
            for (const endpoint of v.companions ?? []) {
                // Companion domains are exact session-local origins. Their
                // opaque siteId resolves only to the stored loopback target.
                if (byGen.has(endpoint.hostname)) continue;
                byGen.set(endpoint.hostname, {
                    workspaceId: ws.id,
                    genName: endpoint.hostname,
                    siteId: endpoint.siteId,
                    hostname: endpoint.hostname,
                    scheme: endpoint.scheme,
                    port: endpoint.port,
                    loopback: endpoint.loopback,
                    allowedOrigins: [v.hostname, endpoint.hostname],
                });
            }
        }
    }
    // DEV-SERVER sites (#234) are emitted OUTSIDE the discovery loop on purpose:
    // they need no hosts-file entry (Genie is the server, so there is nothing for
    // the OS to resolve) and they must survive a discovery failure — an
    // unreadable hosts file should not hide a site Genie is serving right now.
    //
    // This is the entire routing story for the container Dev Server: a running
    // container's PUBLISHED LOOPBACK PORT arrives here as an ordinary
    // `EnabledGenSite`, so `localTargetsBySiteId` → the local carrier (local)
    // and `/api/sites/enabled` → the remote shim (remote) both serve it with no
    // code of their own. Overlaid LAST, so a container that is actually running
    // wins over a hosts-file entry claiming the same name.
    return mergeHostedSites([...byGen.values()], devServerGenSites());
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
