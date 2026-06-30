/**
 * Pure decision logic for the multi-host remote LINK: the bridge protocol
 * version handshake + the upgrade/limbo reconnect state machine. Electron-free
 * so it unit-tests directly; remote/index.ts drives the real bridge with it and
 * pushes the resulting LinkState to the host window.
 */

/**
 * The bridge PROTOCOL/schema version — an integer bumped ONLY when the `/api` +
 * `/ws` data shapes between a remote client and a host change INCOMPATIBLY.
 * Patch/feature betas keep the same number, so they interoperate; only a
 * genuinely-incompatible peer mismatches and is steered to upgrade. Bump this in
 * the SAME commit that changes a bridge wire shape incompatibly.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** How long the client stays in limbo (overlay + retry) before declaring the
 *  host lost. An upgrade download + install + restart fits comfortably inside. */
export const LIMBO_TIMEOUT_MS = 120_000;

export type LinkPhase = 'connected' | 'mismatch' | 'reconnecting' | 'lost';

export interface LinkState {
    phase: LinkPhase;
    /** mismatch: which side is behind (drives "upgrade host" vs "update this Genie"). */
    direction?: 'host-behind' | 'client-behind';
    /** mismatch: the two protocol versions, for a precise message. */
    hostVersion?: number;
    localVersion?: number;
    /** reconnecting: an upgrade WE triggered, or an unexpected drop. */
    reason?: 'upgrade' | 'dropped';
}

/** Compare the local bridge version against the host's. */
export function compareBridgeVersion(
    local: number,
    remote: number,
): 'match' | 'host-behind' | 'client-behind' {
    if (local === remote) return 'match';
    return remote < local ? 'host-behind' : 'client-behind';
}

/** The LinkState a freshly-validated connection should be in given the versions. */
export function linkStateForVersions(local: number, remote: number): LinkState {
    const cmp = compareBridgeVersion(local, remote);
    if (cmp === 'match') return { phase: 'connected' };
    return { phase: 'mismatch', direction: cmp, hostVersion: remote, localVersion: local };
}

/** Gentle reconnect backoff: 2s, 3s, then 5s capped — fast enough to catch a
 *  quick restart, slow enough not to hammer a still-down host. */
export function nextReconnectDelayMs(attempt: number): number {
    const ladder = [2000, 3000, 5000];
    return ladder[Math.min(Math.max(attempt, 0), ladder.length - 1)];
}

/** Whether the limbo window has elapsed (→ declare the host lost). */
export function limboExpired(sinceMs: number, nowMs: number, timeoutMs: number): boolean {
    return nowMs - sinceMs >= timeoutMs;
}

/**
 * What to do when the events bridge closes:
 *   - `ignore`              — a deliberate teardown (we're disconnecting),
 *   - `limbo`              — was healthy OR an upgrade is in flight → keep the
 *                            window open, show the reconnecting overlay, retry,
 *   - `retry-then-teardown` — never got healthy (dead token / unreachable host)
 *                            → the legacy give-up-after-N path (closes the window).
 */
export function decideOnDisconnect(opts: {
    deliberate: boolean;
    everConnected: boolean;
    upgrading: boolean;
}): 'ignore' | 'limbo' | 'retry-then-teardown' {
    if (opts.deliberate) return 'ignore';
    if (opts.everConnected || opts.upgrading) return 'limbo';
    return 'retry-then-teardown';
}
