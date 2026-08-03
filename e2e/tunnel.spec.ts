import { expect, test } from '@playwright/test';
import { launchGenieTunnelE2E, readTunnelProbe } from './helpers/launch';

/**
 * Still current after the hosts-file `.gen` source was retired (#234).
 *
 * What went away was where a `.gen` row COMES FROM — the OS hosts file, parsed
 * for `*.test` vhosts — not what a row IS or who carries it. A row is now a
 * container the Dev Server started, and the fixture below builds exactly that
 * shape (`EnabledGenSite`) by hand: a loopback port plus an `upstreamHost`, the
 * Host header Genie sends the container. `app.test` is that header here, which
 * is the live host-allowlist escape hatch (`upstreamHostFallback`, see
 * main/dev-server/host-allowlist.ts) and no longer an OS-resolvable name — so
 * leaking it to the browser now strands EVERY client, not just a remote one.
 * The carrier, the session CA and the site shim under test are untouched by the
 * retirement, which is why this spec is corrected rather than replaced.
 */
test('Testing Browser preserves a hosted site origin across the tunnel', async () => {
    // The harness converges for up to 40s (READY_DEADLINE_MS) before publishing
    // whatever it has, so the poll must out-wait it and the test must out-wait
    // the poll — otherwise a genuine failure surfaces as a timeout instead of a
    // diff naming the leg that never came up.
    test.setTimeout(120_000);
    const { app } = await launchGenieTunnelE2E();
    try {
        // WAIT FOR THE READY-STATE, not for the probe script to finish (genie#80).
        // `ready` is now computed in MAIN from pendingTunnelLegs: it is true only
        // once EVERY capability has been observed working over the tunnel. The old
        // flag was set by the page unconditionally at the end of its single pass,
        // so a leg that lost the warm-up race — the first CONNECT + first session
        // leaf for a brand-new origin, while the main process is still finishing
        // boot — was frozen false and the assertion below read that one-shot
        // sample. CI saw `absoluteStyle: false` twice and `reverb: false` once,
        // across three different runners.
        await expect
            .poll(async () => (await readTunnelProbe(app))?.ready ?? false, {
                timeout: 60_000,
                intervals: [250, 500, 1000],
            })
            .toBe(true);

        // Main stops polling once ready, so this read is the settled snapshot.
        const probe = await readTunnelProbe(app);

        // NOT swallowed: a leg that needed a retry is reported. The test stays
        // deterministic, but a tunnel that is genuinely intermittent shows up
        // here instead of disappearing into a green run.
        if (probe?.recovered.length) {
            test.info().annotations.push({
                type: 'tunnel-warmup',
                description: `legs that needed a retry: ${probe.recovered.join(', ')}`,
            });
        }

        expect(probe).toMatchObject({
            // The browser must sit on the `.gen` origin even though the site's
            // upstream is dialled with `Host: app.test`. `.gen` is the only
            // name anything resolves; a `.test` origin reaching the page
            // strands the client entirely (genie#29).
            origin: 'https://app.gen',
            absoluteScript: true,
            absoluteStyle: true,
            bearer: {
                ok: true,
                authorization: 'Bearer fixture-application-token',
            },
            cookie: true,
            redirect: { ok: true },
            stream: true,
            websocket: true,
            vite: {
                manifest: true,
                module: true,
                sourceMap: true,
                hmr: true,
                debugger: true,
            },
            next: {
                module: true,
                sourceMap: true,
                fastRefresh: true,
            },
            reverb: true,
            errors: [],
        });
        // THE assertion that would have prevented genie#29: a redirect must land
        // BACK on `.gen`. The probe has ALWAYS captured `redirect.url` — nothing
        // ever checked it, so a leaked upstream `Location` sailed through CI.
        // Deliberately NOT part of the ready-state: a leaked origin would never
        // turn green on a re-run, so waiting on it would only delay this diff.
        const redirectUrl = probe?.redirect.url ?? '';
        expect(
            redirectUrl,
            'a redirect must not leak the upstream .test origin to the browser',
        ).toContain('.gen/');
        expect(redirectUrl).not.toContain('.test');
        if (process.env.GENIE_E2E_TAILSCALE_IP) {
            expect(probe?.transport).toBe('tailscale');
        }
    } finally {
        await app.close();
    }
});
