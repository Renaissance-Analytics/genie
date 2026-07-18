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

        expect(probe).toMatchObject({
            origin: 'https://app.test',
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
        if (process.env.GENIE_E2E_TAILSCALE_IP) {
            expect(probe?.transport).toBe('tailscale');
        }
    } finally {
        await app.close();
    }
});
