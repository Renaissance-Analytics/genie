import { describe, expect, it } from 'vitest';
import {
    TUNNEL_LEGS,
    pendingTunnelLegs,
    type TunnelProbeShape,
} from '../tunnel-legs';

/**
 * THE READY-STATE the Testing Browser tunnel spec waits on (genie#80).
 *
 * The flake: the fixture probed every capability EXACTLY ONCE, at the earliest
 * instant of app boot, then set `ready = true` unconditionally — even for legs
 * that had failed. `ready` therefore meant "the probe script finished", not "the
 * tunnel is up", so `e2e/tunnel.spec.ts` polled a signal that told it nothing and
 * asserted against a one-shot sample. A leg that lost the warm-up race (first
 * CONNECT + first leaf for a brand-new origin, while the main process is still
 * finishing boot) failed PERMANENTLY: CI saw `absoluteStyle: false` twice and
 * `reverb: false` once, on three different runners.
 *
 * `pendingTunnelLegs` is the honest ready-state: the legs NOT yet observed
 * working. Empty ⇒ every capability has been seen working over the tunnel.
 */

/** A probe with every leg satisfied — the shape `ready` must require. */
function greenProbe(): TunnelProbeShape {
    return {
        running: false,
        origin: 'https://app.gen',
        absoluteScript: true,
        absoluteStyle: true,
        bearer: { ok: true, authorization: 'Bearer fixture-application-token' },
        cookie: true,
        redirect: { ok: true, url: 'https://app.gen/redirect-target' },
        stream: true,
        websocket: true,
        vite: { manifest: true, module: true, sourceMap: true, hmr: true, debugger: true },
        next: { module: true, sourceMap: true, fastRefresh: true },
        reverb: true,
        errors: [],
        recovered: [],
    };
}

describe('tunnel probe ready-state', () => {
    it('reports nothing pending once every leg has been observed working', () => {
        expect(pendingTunnelLegs(greenProbe())).toEqual([]);
    });

    it('treats a probe that has not published itself yet as fully pending', () => {
        // The page has not parsed the fixture script — every leg is outstanding,
        // which is what keeps the poll waiting instead of asserting on nothing.
        expect(pendingTunnelLegs(null)).toEqual([...TUNNEL_LEGS]);
    });

    it('keeps a leg pending while a pass is still in flight', () => {
        // Mid-pass the flags are a partial picture and `errors` is half-written.
        // Publishing ready here is how a torn sample reaches the assertion.
        const probe = { ...greenProbe(), running: true };
        expect(pendingTunnelLegs(probe)).toEqual([...TUNNEL_LEGS]);
    });

    // The three regressions CI actually reported.
    it('keeps the reverb leg pending when its socket failed', () => {
        const probe = greenProbe();
        probe.reverb = false;
        probe.errors = ['reverb: Error: failed'];
        expect(pendingTunnelLegs(probe)).toEqual(['reverb']);
    });

    it('keeps the stylesheet leg pending when the subresource never applied', () => {
        const probe = greenProbe();
        probe.absoluteStyle = false;
        expect(pendingTunnelLegs(probe)).toEqual(['absoluteStyle']);
    });

    it('keeps the debugger leg pending until the origin is confirmed over CDP', () => {
        const probe = greenProbe();
        probe.vite.debugger = false;
        expect(pendingTunnelLegs(probe)).toEqual(['debugger']);
    });

    it('reports every failed leg, not just the first', () => {
        const probe = greenProbe();
        probe.absoluteScript = false;
        probe.vite.hmr = false;
        probe.next.fastRefresh = false;
        expect(pendingTunnelLegs(probe)).toEqual(['absoluteScript', 'vite-hmr', 'next-fast-refresh']);
    });

    it('needs BOTH flags of a two-flag leg before it counts as working', () => {
        // `vite-module` proves the module loaded AND its source map resolved; one
        // without the other is not a working companion.
        const half = greenProbe();
        half.vite.sourceMap = false;
        expect(pendingTunnelLegs(half)).toEqual(['vite-module']);
        const other = greenProbe();
        other.next.module = false;
        expect(pendingTunnelLegs(other)).toEqual(['next-module']);
    });

    it('does not wait on the redirect ORIGIN — a leaked .test must fail, not retry', () => {
        // genie#29: a redirect leaking the upstream `.test` origin is a product
        // bug the spec asserts on. Retrying it would never turn green, so the
        // ready-state must not depend on it — it only requires the hop to work.
        const probe = greenProbe();
        probe.redirect = { ok: true, url: 'https://app.test/redirect-target' };
        expect(pendingTunnelLegs(probe)).toEqual([]);
    });
});
