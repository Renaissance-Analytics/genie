import { test, expect, type ElectronApplication } from '@playwright/test';
import { launchGenieE2E, closeGenieE2E } from './helpers/launch';

test('a running agent returns after Genie restarts without opening its workspace or panel', async ({}, testInfo) => {
    let app: ElectronApplication | undefined;
    const state = () => app!.evaluate(() => (globalThis as any).__GENIE_E2E_AGENT_REVIVAL__.state());
    try {
        ({ app } = await launchGenieE2E('issuewatch'));
        // Launch-revival defaults to OFF (the owner's reboot ruling). This spec is about
        // whether revival WORKS when asked for, so it asks. The default has its own spec
        // below, which never opts in — two claims, two tests.
        await app.evaluate(() => (globalThis as any).__GENIE_E2E_AGENT_REVIVAL__.optIn());
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

/**
 * THE DEFAULT, end to end — the owner's reboot ruling, where it actually bit.
 *
 * The spec above proves revival WORKS when asked for. This proves it is not asked for by
 * default, which is a different claim and needs its own test: a unit test on
 * `agentsToRevive` cannot see that boot ran it, and the morning this came from was the whole
 * path — boot revived, agents started working, and no window was open to stop them.
 *
 * It deliberately does NOT call `optIn()`. Its positive control is the spec above: the same
 * fixture, the same restart, opted in, comes back live.
 */
test('an agent does NOT come back on its own after a restart', async ({}, testInfo) => {
    let app: ElectronApplication | undefined;
    const state = () => app!.evaluate(() => (globalThis as any).__GENIE_E2E_AGENT_REVIVAL__.state());
    try {
        ({ app } = await launchGenieE2E('issuewatch'));
        await app.evaluate(() => (globalThis as any).__GENIE_E2E_AGENT_REVIVAL__.start());
        await expect.poll(async () => (await state()).beat?.pid).toBeTruthy();
        const before = await state();
        expect(before.live).toBe(true);

        await closeGenieE2E(app);
        app = undefined;
        const relaunched = await launchGenieE2E('issuewatch');
        app = relaunched.app;

        // Give revival every chance to happen. Asserting "still false" immediately would
        // pass against a revival that is merely SLOW, which is not what is being claimed.
        await relaunched.page.waitForTimeout(5_000);
        const after = await state();
        expect(after.live).toBe(false);
        // The INTENT survives — the agent is still listed as one that was running, so it can
        // be started again. "Not revived" must not quietly mean "forgotten".
        expect(after.wasRunning).toBe(true);
        await testInfo.attach('not-revived-evidence', {
            body: JSON.stringify({ before, after }, null, 2),
            contentType: 'application/json',
        });
    } finally {
        if (app) await app.evaluate(() => (globalThis as any).__GENIE_E2E_AGENT_REVIVAL__.cleanup()).catch(() => {});
        await closeGenieE2E(app);
    }
});
