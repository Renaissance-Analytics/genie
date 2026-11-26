import type { LauncherAnswer } from './launcher-control.js';

/**
 * HOW GENIE-HOST STARTS THE GENIE BROWSER (Tynn #1058 L4). "The launcher is what manages all genie executables" (the owner,
 * 2026-11-25): a host with a launcher asks it (`launcher.startBrowser`, which runs the browser track's verified build) and
 * starts no Electron itself, also when the launcher refuses. A host with no launcher (a dev run; the single-app install
 * until the bridge, L9) starts it here, as before. genie-cloud has no browser at all (BrowserService's `unavailable`).
 */
export interface HostBrowserPorts {
    readonly launcher: { readonly reachable: () => boolean; readonly call: (method: string) => Promise<LauncherAnswer> };
    /** Started by this host, the way it was before a launcher existed. */
    readonly here: (launch: { readonly file: string; readonly args: readonly string[] }) => void;
    readonly log: (line: string) => void;
}

export function hostBrowserStart(ports: HostBrowserPorts): (launch: { readonly file: string; readonly args: readonly string[] }) => Promise<void> {
    return async (launch) => {
        if (!ports.launcher.reachable()) { ports.here(launch); return; }
        const answer = await ports.launcher.call('launcher.startBrowser').catch((error: unknown): LauncherAnswer => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }));
        if (answer.ok) ports.log('genie browser: started by the launcher');
        else ports.log(`genie browser: the launcher did not start it: ${answer.reason}`);
    };
}
