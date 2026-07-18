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
            errors: [],
        });
    } finally {
        await app.close();
    }
});
