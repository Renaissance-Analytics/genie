import { test, expect, type ElectronApplication } from '@playwright/test';
import { launchGenieE2E, closeGenieE2E } from './helpers/launch';

test('a running agent returns after Genie restarts without opening its workspace or panel', async ({}, testInfo) => {
    let app: ElectronApplication | undefined;
    const state = () => app!.evaluate(() => (globalThis as any).__GENIE_E2E_AGENT_REVIVAL__.state());
    try {
        ({ app } = await launchGenieE2E('issuewatch'));
        await app.evaluate(() => (globalThis as any).__GENIE_E2E_AGENT_REVIVAL__.start());
        await expect.poll(async () => (await state()).beat?.pid).toBeTruthy();
        const before = await state();
        expect(before.live).toBe(true);
        expect(before.attached).toBe(false);
        await closeGenieE2E(app);
        app = undefined;
        const relaunchedAt = Date.now();
        const relaunched = await launchGenieE2E('issuewatch');
        app = relaunched.app;
        await expect.poll(async () => (await state()).live, { timeout: 30_000 }).toBe(true);
        await expect.poll(async () => (await state()).beat?.at ?? 0).toBeGreaterThan(relaunchedAt);
        const after = await state();
        expect(after.beat.pid).not.toBe(before.beat.pid);
        expect(after.attached).toBe(false);
        expect(after.wasRunning).toBe(true);
        await testInfo.attach('host-side-agent-evidence', { body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json' });
        // Host liveness can settle before React mounts this unrelated harness.
        // Wait for visible content so the artifact records more than a blank window.
        await expect(relaunched.page.getByText('Issue Watch', { exact: true })).toBeVisible();
        await relaunched.page.screenshot({ path: testInfo.outputPath('revived-without-agent-panel.png') });
    } finally {
        if (app) await app.evaluate(() => (globalThis as any).__GENIE_E2E_AGENT_REVIVAL__.cleanup()).catch(() => {});
        await closeGenieE2E(app);
    }
});
