import { hostNativeRoute, type DevSiteConfig } from './sites-config';
import type { HostSiteRoute } from './host-reconcile';

/**
 * Select the live sites the host reconcile should serve to REAL external browsers
 * (story #238 P2): the ones that are HOST-NATIVE (run no container) AND the owner
 * opted in with `browserExposed`. Everything else — container sites, non-http
 * surfaces, sites not opted in — is left to the in-app Testing Browser, which
 * carries every `.gen` site itself and needs no host Caddy.
 *
 * Each entry pairs a site's config with the LIVE loopback port it is actually on
 * (the manager's `caddyHostPort`), which is authoritative for both the external-
 * `hostPort` form and a Genie-managed `runMode:'host'` site. The result is deduped
 * by name (last live entry wins) and sorted, so a no-op reconcile is a true no-op.
 */
export function hostBrowserRoutes(
    entries: ReadonlyArray<{ config: DevSiteConfig; port: number }>,
): HostSiteRoute[] {
    const byName = new Map<string, HostSiteRoute>();
    for (const { config, port } of entries) {
        if (config.kind !== 'http' || config.browserExposed !== true) continue;
        // Host-native = the external-hostPort form OR a Genie-managed host process.
        const isHostNative = hostNativeRoute(config) !== null || config.runMode === 'host';
        if (!isHostNative) continue;
        byName.set(config.genName, {
            genName: config.genName,
            port,
            ...(config.upstreamHost ? { upstreamHost: config.upstreamHost } : {}),
        });
    }
    return [...byName.values()].sort((a, b) => a.genName.localeCompare(b.genName));
}
