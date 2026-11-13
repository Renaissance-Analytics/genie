/**
 * GENIE'S MAIN WINDOW, AS A DEBUGGER TARGET (Tynn #692). Every CI row attaches to it through this, never to "the first
 * page": since #1867 the app can open "Starting Genie's host…" (host-wait.html, its own preload, no window.genie) before
 * or beside it, and a row that took the first page found no bridge or waited on a page that closed.
 *
 * The main window is the page that loads renderer/index.html on one of its own routes. index.html also serves the windows
 * bound to one thing (a Take Over terminal, a Flow editor, the Files pop-out), which are not the main window.
 * test/cdp-main-window.test.ts holds the rule.
 */
const BOUND = /#genie:\/\/(?:[^/?#]+\/)?(?:takeover|flow|files)\//;

/** The "Starting Genie's host…" window. */
export function isHostWaitWindow(target) {
    return target?.type === 'page' && /\/host-wait\.html(?:[?#]|$)/.test(String(target.url ?? ''));
}

export function isMainWindow(target) {
    if (target?.type !== 'page' || !target.webSocketDebuggerUrl) return false;
    const url = String(target.url ?? '');
    return /\/index\.html(?:[?#]|$)/.test(url) && !BOUND.test(url);
}

/** The main window among a debugger port's targets (its /json/list), or null. */
export function mainWindow(targets) {
    return (Array.isArray(targets) ? targets : []).find(isMainWindow) ?? null;
}

/**
 * WHETHER A URL IS ONE OF GENIE'S OWN PAGES (Tynn #683): `http://genie.localhost:<port>/<page>.html` now, or the built
 * file `.../renderer/<page>.html` it was loaded from before. One rule for every row; a script that runs it inside
 * Electron's main takes geniePageSource() and builds the same RegExp there.
 */
export function geniePageSource(page = 'index') {
    return String.raw`^(?:http://genie\.localhost:\d+/|file:.*[\\/]renderer[\\/])` + String(page).replace(/[^a-z-]/g, '') + String.raw`\.html(?:[?#]|$)`;
}
export function isGeniePage(url, page = 'index') {
    return new RegExp(geniePageSource(page)).test(String(url ?? ''));
}
