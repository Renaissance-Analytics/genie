/**
 * The Testing Browser tunnel probe's READY-STATE (genie#80).
 *
 * Kept dependency-free and separate from `tunnel.ts` so the ready decision is
 * unit-testable without Electron: `tunnel.ts` reaches for `electron`, the real
 * testing-browser, and the mobile server, none of which a unit test can boot.
 *
 * A "leg" is one capability the fixture page exercises over the tunnel (a
 * subresource, a fetch, an SSE stream, a WebSocket, a dev-server companion).
 * Each leg owns the probe flags it sets, and is DONE only when all of them are
 * true — so "ready" means every capability has actually been observed working,
 * not merely that the probe script reached its last line.
 */

/** Every capability leg, in the order the fixture runs them. */
export const TUNNEL_LEGS = [
    'absoluteScript',
    'absoluteStyle',
    'bearer',
    'cookie',
    'redirect',
    'stream',
    'websocket',
    'vite-manifest',
    'vite-module',
    'vite-hmr',
    'next-module',
    'next-fast-refresh',
    'reverb',
    'debugger',
] as const;

export type TunnelLeg = (typeof TUNNEL_LEGS)[number];

/** The probe object the fixture page publishes on `window.__tunnelProbe`. */
export interface TunnelProbeShape {
    /** True while a pass is mid-flight: the flags are partial and `errors` is
     *  half-written, so nothing may be concluded from them yet. */
    running: boolean;
    origin: string;
    absoluteScript: boolean;
    absoluteStyle: boolean;
    bearer: { ok: boolean; authorization: string | null };
    cookie: boolean;
    redirect: { ok: boolean; url: string };
    stream: boolean;
    websocket: boolean;
    vite: { manifest: boolean; module: boolean; sourceMap: boolean; hmr: boolean; debugger: boolean };
    next: { module: boolean; sourceMap: boolean; fastRefresh: boolean };
    reverb: boolean;
    /** Failures from the MOST RECENT pass only (a recovered leg clears its own). */
    errors: string[];
    /** Legs that failed at least once before succeeding. Never swallowed — the
     *  spec surfaces it, so a genuinely intermittent tunnel stays visible even
     *  though the test itself is deterministic. */
    recovered: string[];
}

/**
 * PURE. The legs a probe has NOT yet been observed completing.
 *
 * `redirect` deliberately checks only that the hop WORKED, never which origin it
 * landed on: a redirect leaking the upstream `.test` name is genie#29, a real
 * product bug the spec asserts on directly. Re-running it would never turn it
 * green, so making readiness depend on it would just trade a fast, legible
 * failure for a slow, opaque one.
 */
export function pendingTunnelLegs(probe: TunnelProbeShape | null | undefined): TunnelLeg[] {
    // No probe yet (page not parsed), or a pass in flight: everything is
    // outstanding. Reading a torn sample is exactly how the flake reached the
    // assertion.
    if (!probe || probe.running) return [...TUNNEL_LEGS];
    const done: Record<TunnelLeg, boolean> = {
        absoluteScript: probe.absoluteScript === true,
        absoluteStyle: probe.absoluteStyle === true,
        bearer: probe.bearer?.ok === true,
        cookie: probe.cookie === true,
        redirect: probe.redirect?.ok === true,
        stream: probe.stream === true,
        websocket: probe.websocket === true,
        'vite-manifest': probe.vite?.manifest === true,
        'vite-module': probe.vite?.module === true && probe.vite?.sourceMap === true,
        'vite-hmr': probe.vite?.hmr === true,
        'next-module': probe.next?.module === true && probe.next?.sourceMap === true,
        'next-fast-refresh': probe.next?.fastRefresh === true,
        reverb: probe.reverb === true,
        debugger: probe.vite?.debugger === true,
    };
    return TUNNEL_LEGS.filter((leg) => !done[leg]);
}
