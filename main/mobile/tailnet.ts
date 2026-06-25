import os from 'node:os';

/**
 * Tailscale interface detection — the single security chokepoint for the mobile
 * remote-control server. The server binds ONLY to the address this returns; if
 * it returns null the server does not start (fail closed). We never bind
 * 0.0.0.0 / 127.0.0.1 / a LAN address — the phone reaches Genie exclusively over
 * the WireGuard-encrypted tailnet.
 *
 * Pure + dependency-free (os.networkInterfaces is injectable) so the detection
 * logic is unit-tested directly without a real tailnet.
 *
 * Resolution order, IPv4 only:
 *   1. An interface whose NAME matches /tailscale/i (the macOS `utun`/Windows
 *      `Tailscale`/Linux `tailscale0` adapter Tailscale creates) with a non-
 *      internal IPv4 in the CGNAT range.
 *   2. Otherwise, ANY non-internal IPv4 that falls inside Tailscale's CGNAT
 *      block 100.64.0.0/10 (100.64.0.0 – 100.127.255.255). Tailscale assigns
 *      every node a 100.x address from this block, so this catches the adapter
 *      even when its name doesn't match (renamed/uncommon platforms).
 *   3. null — no tailnet detected.
 */

/** The shape of one entry os.networkInterfaces() yields (the subset we use). */
export interface NetIface {
    address: string;
    family: string | number;
    internal: boolean;
}

/** True when `ip` is an IPv4 dotted-quad inside Tailscale's CGNAT 100.64.0.0/10. */
export function isCgnatIp(ip: string): boolean {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a !== 100) return false;
    // 100.64.0.0 – 100.127.255.255 → second octet 64..127.
    return b >= 64 && b <= 127;
}

/** True for the IPv4 family across Node versions (string 'IPv4' or numeric 4). */
function isV4(family: string | number): boolean {
    return family === 'IPv4' || family === 4;
}

/**
 * Resolve the local Tailscale IPv4, or null when no tailnet is present.
 *
 * @param ifaces  Injectable for tests; defaults to os.networkInterfaces().
 */
export function detectTailnetIp(
    ifaces?: NodeJS.Dict<NetIface[]>,
): string | null {
    const all = ifaces ?? (os.networkInterfaces() as NodeJS.Dict<NetIface[]>);

    // Pass 1: a tailscale-named interface with a usable CGNAT IPv4.
    for (const [name, addrs] of Object.entries(all)) {
        if (!addrs || !/tailscale/i.test(name)) continue;
        for (const a of addrs) {
            if (isV4(a.family) && !a.internal && isCgnatIp(a.address)) {
                return a.address;
            }
        }
    }

    // Pass 2: any non-internal CGNAT IPv4 on any interface.
    for (const addrs of Object.values(all)) {
        if (!addrs) continue;
        for (const a of addrs) {
            if (isV4(a.family) && !a.internal && isCgnatIp(a.address)) {
                return a.address;
            }
        }
    }

    return null;
}
