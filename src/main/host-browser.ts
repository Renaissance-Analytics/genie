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

export function browserDoorOf(_facts: HostFrontDoorFacts): BrowserDoor {
    throw new Error('2g-4d D2: not built yet');
}

export interface HostOpensSitePorts {
    /** This host's browser's open, in the background (BrowserService `open`). */
    readonly open: (url: string) => Promise<unknown>;
    /** This host's sites, to find the opened one's workspace. */
    readonly sites: () => readonly { readonly host: string; readonly workspaceId: string }[];
    /** The tool signal to every window: which workspace to pulse. */
    readonly signal: (signal: { readonly kind: 'site-opened'; readonly workspaceId: string; readonly reason: string }) => void;
}

export function hostOpensSite(_ports: HostOpensSitePorts): OpenInBrowser {
    throw new Error('2g-4d D2: not built yet');
}
