import { expect, test } from '@playwright/test';
import {
    launchGenieTunnelE2E,
    readTunnelProbe,
    type TunnelProbe,
} from './helpers/launch';

test('Testing Browser preserves a dev site origin across the tunnel', async () => {
    const { app } = await launchGenieTunnelE2E();
    try {
        let probe: TunnelProbe | null = null;
        await expect
            .poll(async () => {
                probe = await readTunnelProbe(app);
                return probe?.ready ?? false;
            })
            .toBe(true);

        // Re-read rather than reuse the polled `probe` local (TS narrows it to
        // null at its declaration, since the assignment happens in a callback).
        const settled = await readTunnelProbe(app);
        const redirectUrl = settled?.redirect.url ?? '';

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
