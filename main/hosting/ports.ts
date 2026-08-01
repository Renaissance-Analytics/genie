import crypto from 'node:crypto';

/**
 * PURE per-site port assignment.
 *
 * The whole point of hosting a site is a STABLE origin: a bookmark, a saved
 * Testing-Browser tab, a `<repo>.gen` mapping and a remote preview all break if
 * the port moves every restart. So the port is DERIVED from the site id rather
 * than handed out by the OS — same site, same port, forever, with no state file
 * to keep in sync.
 *
 * Collisions (two site ids hashing to the same slot, or another program already
 * on that port) are resolved by probing forward deterministically, so the
 * fallback is stable too.
 */

// --- range -----------------------------------------------------------------

/**
 * Registered-but-unassigned high range. Above the ephemeral floor Windows uses
 * for outbound sockets (49152) would risk colliding with the OS's own pool, and
 * below 1024 needs privileges, so we sit in a quiet band in between.
 */
export const HOSTED_PORT_MIN = 20_000;
export const HOSTED_PORT_MAX = 20_999;

/** How many slots the range holds. */
export const HOSTED_PORT_SLOTS = HOSTED_PORT_MAX - HOSTED_PORT_MIN + 1;

// --- derivation ------------------------------------------------------------

/**
 * The port a site WANTS: a stable hash of its id folded into the range.
 *
 * Uses the same sha256-of-the-identifier convention as `siteIdFor` in
 * `mobile/hosts.ts` so the mapping is reproducible across machines and across
 * Genie versions — never `Math.random`, never an incrementing counter.
 */
export function preferredPort(siteId: string): number {
    const digest = crypto.createHash('sha256').update(siteId).digest();
    // 32 bits is plenty of entropy for a 1000-slot range and avoids BigInt.
    const n = digest.readUInt32BE(0);
    return HOSTED_PORT_MIN + (n % HOSTED_PORT_SLOTS);
}

/**
 * The port a site GETS: its preferred port, or — if that slot is taken — the
 * next free slot, wrapping within the range.
 *
 * `taken` is supplied by the caller (the runtime's own live sites, optionally
 * union'd with a real liveness probe), which keeps this function pure.
 *
 * Throws when the range is exhausted rather than silently returning a port
 * someone else owns; 1000 concurrently hosted sites on one machine is a bug,
 * not a capacity limit to paper over.
 */
export function assignPort(siteId: string, taken: ReadonlySet<number>): number {
    const start = preferredPort(siteId);
    for (let i = 0; i < HOSTED_PORT_SLOTS; i += 1) {
        const port = HOSTED_PORT_MIN + ((start - HOSTED_PORT_MIN + i) % HOSTED_PORT_SLOTS);
        if (!taken.has(port)) return port;
    }
    throw new Error(`no free hosting port in ${HOSTED_PORT_MIN}-${HOSTED_PORT_MAX}`);
}

// --- origin ----------------------------------------------------------------

/**
 * The stable SAME-ORIGIN URL for a hosted site.
 *
 * One origin serves the app AND its built assets AND its API — that is the
 * whole fix for remote preview. There is deliberately no separate asset origin,
 * no companion port, and no HMR socket in this URL.
 */
export function hostedOrigin(hostname: string, port: number, scheme: 'http' | 'https'): string {
    return `${scheme}://${hostname.toLowerCase()}:${port}`;
}
