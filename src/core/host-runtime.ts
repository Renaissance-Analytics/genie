/**
 * WHAT GENIE-HOST RUNS ON (the host split, P10.1d). In the app it is Electron's binary as plain Node
 * (`ELECTRON_RUN_AS_NODE=1`): there is an Electron to start the Genie browser's process with, and a window to show pages
 * in. In genie-cloud's container it is plain Node (P10.3): neither exists, and what needs them says so instead of failing.
 */

/** What the Genie browser answers on a host with no Electron (`engine.browser` open, pop-out and page calls). */
export const NO_BROWSER_HERE = 'The Genie browser is not available on this host: it runs on plain Node, with no Electron to start the browser with.';

/** What an agent's `pages` call answers there. Nothing was done, and opening Genie on this machine would not change it. */
export const NO_PAGES_HERE = 'pages is not available on this host: it runs on plain Node, with no Electron for the Genie browser. Nothing was done.';

/** Whether this process is Electron's binary (as Node or not). `process.versions` by default. */
export function runsOnElectron(versions: Readonly<Record<string, string | undefined>> = process.versions): boolean {
    return versions['electron'] !== undefined;
}
