import type { SocketLike } from './issue-watch-client.js';

/**
 * THE ONE WAY MAIN DIALS TYNN'S SOCKET SERVER (genie#1478): IssueWatch and the live board, so they cannot diverge.
 *
 * Production's Reverb answers only `Origin: https://tynn.ai`; anything else, or none, gets `pusher:error` 4009 and then
 * silence. A browser sets that header for itself; Genie is a native client, so it declares the origin of the Tynn it is
 * configured for. The Origin check protects browsers, and the private channels stay authorized by their own signature,
 * which this changes nothing about.
 *
 * main's global WebSocket is the undici inside Electron, whose constructor takes `{ headers }`. That is not the browser's
 * signature, hence the cast, and scripts/perf-lag/reverb-origin-probe.mjs runs under Electron's binary from `npm test`, so
 * an Electron upgrade that loses it fails there. No `dispatcher` is passed: TLS verification is the runtime's default,
 * exactly what it was.
 */
type NativeWebSocket = new (url: string, init: { readonly headers: Readonly<Record<string, string>> }) => SocketLike;

export function dialTynnSocket(url: string, tynnHost: string): SocketLike {
    return new (WebSocket as unknown as NativeWebSocket)(url, { headers: { Origin: new URL(tynnHost).origin } });
}
