/**
 * WHAT GENIE-HOST RUNS ON (the host split, P10.1d). In the app it is Electron's binary as plain Node
 * (`ELECTRON_RUN_AS_NODE=1`): there is an Electron to start the Genie browser's process with, and a window to show pages
 * in. In genie-cloud's container it is plain Node (P10.3): neither exists, and what needs them says so instead of failing.
 */

/** What the Genie browser answers on a host with no Electron (`engine.browser` open, pop-out and page calls). */
export const NO_BROWSER_HERE = 'The Genie browser is not available on this host: it runs on plain Node, with no Electron to start the browser with.';

/**
 * What a tool or feature this host can never have answers: the one wording, for every one of them. Never "open Genie" —
 * on such a host there is no Genie to open.
 */
export function notAvailableHere(what: string, needs: string): string {
    return `${what} is not available on this host: it runs on plain Node, with no Electron for ${needs}. Nothing was done.`;
}

/** What an agent's `pages` call answers there. Nothing was done, and opening Genie on this machine would not change it. */
export const NO_PAGES_HERE = notAvailableHere('pages', 'the Genie browser');

/** What the updater answers there (check, download, install): the container's image is replaced by its deployment. */
export const NO_UPDATES_HERE = "Updates aren't available on this host: its image is updated by its deployment.";

/** Whether this process is Electron's binary (as Node or not). `process.versions` by default. */
export function runsOnElectron(versions: Readonly<Record<string, string | undefined>> = process.versions): boolean {
    return versions['electron'] !== undefined;
}

/** What this host can have: a Genie window to forward to, the Genie browser's process, an OS elevation asked in a window. */
export interface HostCapabilities {
    readonly window: boolean;
    readonly browser: boolean;
    readonly elevation: boolean;
}

/** THE ONE PLACE that decides what this host can have (P10.1d). */
export function hostCapabilities(_versions: Readonly<Record<string, string | undefined>> = process.versions): HostCapabilities {
    return { window: true, browser: true, elevation: true };
}
