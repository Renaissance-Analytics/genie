import { expect, test } from '@playwright/test';
import { launchGenieTunnelE2E, readTunnelProbe } from './helpers/launch';

test('Testing Browser preserves a dev site origin across the tunnel', async () => {
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
            // The browser must sit on the `.gen` origin even though the harness
            // opened the real `app.test` name — the alias resolves TO `.gen`.
            // A `.test` origin only resolves on the HOST, so it strands every
            // remote client (genie#29).
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
