import { listWorkspaces, getWorkspaceTunnelSites } from '../db';
import { discoverSites } from '../mobile/hosts';
import type { EnabledGenSite } from '../remote';
import type { LocalTarget } from './local-carrier';

/**
 * THIS machine's ENABLED `.gen` dev sites, aggregated across every workspace's
 * tunnel config. The enable/`.gen`-name/scheme/port live per-workspace (the
 * serve-local allowlist), so a site is "on" if ANY workspace enabled it; we
 * dedupe by `.gen` name (first enable wins). This is the source of truth for
 * BOTH the header `.gen` popover (enabled-only — never the raw hosts file) and
 * the local Testing Browser's resolver map. Discovery is machine-wide and
 * probe-cached, so iterating workspaces is cheap.
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
                genName: v.genName,
                siteId: v.siteId,
                hostname: v.hostname,
                scheme: v.scheme,
                port: v.port,
            });
        }
    }
    return [...byGen.values()];
}

/** The loopback-dial target for each enabled site, keyed by siteId — what the
 *  local Testing Browser's carrier resolves against. */
export function localTargetsBySiteId(sites: EnabledGenSite[]): Map<string, LocalTarget> {
    const m = new Map<string, LocalTarget>();
    for (const s of sites) {
        m.set(s.siteId, { scheme: s.scheme, hostname: s.hostname, port: s.port });
    }
    return m;
}
