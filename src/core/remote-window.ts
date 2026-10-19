/**
 * A WINDOW PER REMOTE HOST (Genie 1's `remote.open`; the owner, 2026-10-19: "I need to be able to connect to remote genie
 * hosts and drive agents on those machines"; Tynn #819). A remote window is Genie's own window loaded with the host it is
 * bound to in its query (`?remote=<socket URL>`), so the local Genie stays open beside it. Main validates the URL with
 * the same rule before it opens anything: only `ws://` or `wss://` is a Genie host.
 */
export function remoteWindowSearch(url: string): string {
    return `?${new URLSearchParams({ remote: url }).toString()}`;
}

/** The host a window is bound to, or `null` — anything but `ws://` / `wss://` is not a host. */
export function remoteFromSearch(search: string): string | null {
    const url = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('remote');
    return url !== null && /^wss?:\/\/[^\s]+$/i.test(url) ? url : null;
}

/** `now`, `5m ago`, `3h ago`, `2d ago` — when a host was last connected. */
export function agoText(at: number, now: number): string {
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
