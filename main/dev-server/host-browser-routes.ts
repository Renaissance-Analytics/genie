import { hostNativeRoute, type DevSiteConfig } from './sites-config';
import type { HostSiteRoute } from './host-reconcile';

/** Is this site one the owner asked to reach from a REAL browser? Shared by both
 *  selectors below so "browser-exposed" cannot come to mean two things. */
function browserExposedSite(config: DevSiteConfig): boolean {
    return config.kind === 'http' && config.browserExposed === true;
}

/**
 * The `.gen` names the OS HOSTS FILE should carry: every CONFIGURED browser-exposed
 * site, read from config alone — no port, no live entry, nothing about what is
 * running (genie#624).
 *
 * This is the half of the split that must hold still. The hosts file is the only
 * artifact in the host reconcile whose write needs Administrator/root, so building
 * it from the RUNNING set meant every start and every stop genuinely changed it and
 * genuinely prompted. A name here resolving to 127.0.0.1 with nothing listening is
 * a connection refused — a better error than a DNS failure, and never a claim that
 * the service was up.
 *
 * `enabled` belongs on this side and a stop does not: it is the CONFIGURED axis
 * (genie#407), persisted in the git-tracked envelope and explicitly not "running
 * right now". So a site nobody enabled is not named, and a site the user stopped
 * still is.
 */
export function hostBrowserNames(configs: ReadonlyArray<DevSiteConfig>): string[] {
    const names = new Set<string>();
    for (const config of configs) {
        if (!config.enabled || !browserExposedSite(config)) continue;
        names.add(config.genName);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Select the live sites the host reconcile should serve to REAL external browsers
 * (story #238 P2): every `http` site the owner opted in with `browserExposed` —
 * host-native AND container/image alike. A container site loaded fine in the in-app
 * Testing Browser but 502'd in the real browser because it was excluded here (no
 * hosts entry, no host-Caddy vhost); it is now included, reached through its
 * sandbox Caddy.
 *
 * Each entry pairs a site's config with the LIVE loopback port it is actually on
 * (the manager's `caddyHostPort`): a host-native site's plain-http dev-server port,
 * or a container site's published sandbox-Caddy port. The upstream SCHEME is set
 * per type — plain http for host-native, https-insecure for a container (its
 * sandbox Caddy serves a self-signed leaf and routes by Host). Deduped by name
 * (last live entry wins) and sorted, so a no-op reconcile is a true no-op.
 *
 * This is the RUNNING half, and it feeds the Caddyfile only. It does not filter on
 * `enabled`: every entry here is already a live site, and a site whose config was
 * disabled mid-run must keep its vhost for as long as its process is up.
 */
export function hostBrowserRoutes(
    entries: ReadonlyArray<{ config: DevSiteConfig; port: number }>,
): HostSiteRoute[] {
    const byName = new Map<string, HostSiteRoute>();
    for (const { config, port } of entries) {
        if (!browserExposedSite(config)) continue;
        // Host-native = the external-hostPort form OR a Genie-managed host process;
        // everything else browser-exposed is a container site reached via https-insecure.
        const isHostNative = hostNativeRoute(config) !== null || config.runMode === 'host';
        byName.set(config.genName, {
            genName: config.genName,
            port,
            ...(isHostNative
                ? config.upstreamHost
                    ? { upstreamHost: config.upstreamHost }
                    : {}
                : { upstreamScheme: 'https-insecure' as const }),
        });
    }
    return [...byName.values()].sort((a, b) => a.genName.localeCompare(b.genName));
}
