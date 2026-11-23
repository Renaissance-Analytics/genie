import { browserSiteLabels } from '../core/browser-sites.js';
import type { BrowserDoor } from './browser-service.js';
import type { OpenInBrowser } from './hosting-actions.js';

/**
 * GENIE-HOST'S BROWSER, SAID AND OPENED BY GENIE-HOST ITSELF (Tynn #1046 D2, client/host split step 2g-4d). What the Genie
 * browser needs of the front door (its port, Genie's CA, the hosts, each site's workspace and label) is the host's own:
 * genie-host says it from its own hosting, with or without a window, and the window says only how to start the browser
 * (its launch). An agent's `sites open` runs here too: the site opens in the background through this host's browser, and
 * the window is told only which workspace to pulse for the person (a `site-opened` tool signal).
 */

/** What genie-host's hosting says of its front door, and the names to label each site's chip with. */
export interface HostFrontDoorFacts {
    readonly port: number;
    readonly caPem: string | null;
    readonly routes: readonly { readonly host: string }[];
    readonly sites: readonly { readonly host: string; readonly workspaceId: string; readonly name: string }[];
    readonly workspaceNames: Readonly<Record<string, string>>;
}

export function browserDoorOf(facts: HostFrontDoorFacts): BrowserDoor {
    const hosts = facts.routes.map((r) => r.host);
    return {
        frontDoorPort: facts.port,
        caPem: facts.caPem,
        hosts,
        workspaceOf: Object.fromEntries(facts.sites.map((s) => [s.host.toLowerCase(), s.workspaceId])),
        siteLabels: browserSiteLabels(hosts, facts.sites, facts.workspaceNames),
    };
}

export interface HostOpensSitePorts {
    /** This host's browser's open, in the background (BrowserService `open`). */
    readonly open: (url: string) => Promise<unknown>;
    /** This host's sites, to find the opened one's workspace. */
    readonly sites: () => readonly { readonly host: string; readonly workspaceId: string }[];
    /** The tool signal to every window: which workspace to pulse. */
    readonly signal: (signal: { readonly kind: 'site-opened'; readonly workspaceId: string; readonly reason: string }) => void;
}

export function hostOpensSite(ports: HostOpensSitePorts): OpenInBrowser {
    return async (url) => {
        try { await ports.open(url); } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
        const host = ((): string | null => { try { return new URL(url).host.toLowerCase(); } catch { return null; } })();
        const site = host ? ports.sites().find((s) => s.host.toLowerCase() === host) : undefined;
        if (site) ports.signal({ kind: 'site-opened', workspaceId: site.workspaceId, reason: 'sites open' });
        return { ok: true };
    };
}
