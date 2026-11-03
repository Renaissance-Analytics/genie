import type { SocketLike } from './issue-watch-client.js';

/**
 * THE ONE WAY MAIN DIALS TYNN'S SOCKET SERVER (genie#1478): IssueWatch and the live board, so they cannot diverge.
 */
export function dialTynnSocket(url: string, _tynnHost: string): SocketLike {
    return new WebSocket(url) as unknown as SocketLike;
}
