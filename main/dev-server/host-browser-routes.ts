import { hostNativeRoute, type DevSiteConfig } from './sites-config';
import type { HostSiteRoute } from './host-reconcile';

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
 */
export function hostBrowserRoutes(
    entries: ReadonlyArray<{ config: DevSiteConfig; port: number }>,
): HostSiteRoute[] {
    const byName = new Map<string, HostSiteRoute>();
    for (const { config, port } of entries) {
        if (config.kind !== 'http' || config.browserExposed !== true) continue;
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
