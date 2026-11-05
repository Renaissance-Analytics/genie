import type { SocketLike } from './issue-watch-client.js';

/**
 * THE ONE WAY GENIE DIALS TYNN'S SOCKET SERVER (genie#1478): IssueWatch and the live board, so they cannot diverge. Since
 * the host split's P5c they run in genie-host (issue-watch-host.ts), and in the window only on the emergency no-host path.
 *
 * Production's Reverb answers only `Origin: https://tynn.ai`; anything else, or none, gets `pusher:error` 4009 and then
 * silence. A browser sets that header for itself; Genie is a native client, so it declares the origin of the Tynn it is
 * configured for. The Origin check protects browsers, and the private channels stay authorized by their own signature,
 * which this changes nothing about.
 *
 * The global WebSocket is the undici inside Electron's Node — genie-host runs on Electron's binary as plain Node
 * (`ELECTRON_RUN_AS_NODE`) — whose constructor takes `{ headers }`. That is not the browser's signature, hence the cast.
 * test/p5c-host-socket-origin.test.ts runs THIS module under that binary in that mode against a server that records the
 * handshake, and scripts/perf-lag/reverb-origin-probe.mjs runs the same call from `npm test`, so an Electron upgrade that
 * loses it fails there. No `dispatcher` is passed: TLS verification is the runtime's default,
 * exactly what it was.
 */
type NativeWebSocket = new (url: string, init: { readonly headers: Readonly<Record<string, string>> }) => SocketLike;

export function dialTynnSocket(url: string, tynnHost: string): SocketLike {
    void tynnHost;
    return new (WebSocket as unknown as NativeWebSocket)(url, { headers: {} });
}
