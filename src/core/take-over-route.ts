/**
 * THE TAKE OVER WINDOW'S ROUTE, MADE AND READ IN ONE PLACE (Tynn #529 part A; the Azure pair run, 2026-11-08).
 *
 * Main opens a Take Over window on `genie://takeover/<terminal>` (core/route.ts); the window then shows, and writes into its
 * own hash, the machine-qualified address `genie://<workstation>/takeover/<terminal>` (core/address.ts). App.tsx used to
 * tell a Take Over window by the prefix `#genie://takeover/` — so a window whose hash had been rewritten connected to
 * another machine as a plain remote window, without its ticket: the drone's Dashboard, "nobody is driving". The opener
 * makes the route with `takeOverRouteOf`; the window reads either form with `takeOverTerminalOf`.
 */

/** The route main opens a Take Over window on, for a terminal. */
export function takeOverRouteOf(terminalId: string): string {
    return `genie://takeover/${encodeURIComponent(terminalId)}`;
}

/**
 * The terminal a Take Over window's hash (or address) is on — `#genie://takeover/<id>` or the machine-qualified
 * `#genie://<workstation>/takeover/<id>`, a query after either — or `null` when it is not a Take Over window.
 */
export function takeOverTerminalOf(hash: string): string | null {
    const address = (hash.startsWith('#') ? hash.slice(1) : hash).split('?')[0] ?? '';
    const match = /^genie:\/\/(?:[^/]+\/)?takeover\/([^/]+)$/.exec(address);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]!);
    } catch {
        return null;
    }
}
