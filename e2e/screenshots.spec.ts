import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
    killMasterTerminals,
    launchGenieE2E,
    readMasterSeed,
    withTeardownBound,
    type MasterSeed,
} from './helpers/launch';

/**
 * EYEBALL ON THE BUILD — screenshots of the REAL window, from a clean VM.
 *
 * The owner, after the fourth control in one day that looked like it worked and
 * did not: *"are you not testing your ux at all? so many things you keep
 * shipping that just don't fucking work right or at all. you really need to fix
 * the review and testing workflows so you can get eyeball on the builds using
 * the test VM's."*
 *
 * They are right, and the suite proved it. Genie's E2E is thorough about
 * BEHAVIOUR and blind to APPEARANCE: nothing it produced was ever looked at.
 * There was no artifact upload in `e2e.yml` at all, so even a failing run's
 * `test-results/` died on the runner — a path in a log pointing at a VM that
 * had already been destroyed, which is a failure diagnosed by guessing.
 *
 * Behaviour coverage is not the gap. Four controls shipped this week that were
 * OFFERED, ran, and reported nothing: a restart that killed the agent it
 * started, an installer reading a table nobody wrote to, a refresh button
 * refused at 419, and an "Edit agent…" that silently declined for an agent
 * that was not running. Every one of them would be obvious in a picture.
 *
 * ## What this file is, and is not
 *
 * It is NOT a pixel-diff gate. A screenshot test that fails on a one-pixel
 * antialiasing change teaches everyone to re-baseline without looking, which is
 * the same disease as a green suite nobody reads.
 *
 * It is a CAPTURE pass: boot the real app, put each surface into the state a
 * person actually meets it in, and publish the images so a human can look at
 * the build in ten seconds. The assertions here are deliberately thin — that
 * the surface exists at all — because the DELIVERABLE is the artifact.
 *
 * Every shot is of the REAL master window. Nothing here renders a harness page;
 * that is the failure mode this exists to end.
 */

let app: ElectronApplication;
let page: Page;
let seed: MasterSeed;

/** Where the images land. `e2e.yml` uploads this directory per OS. */
const SHOT_DIR = path.join(process.cwd(), 'test-results', 'screenshots');

/**
 * Capture one surface.
 *
 * Failures are NOT swallowed — a shot that could not be taken is a surface that
 * did not render, which is exactly the thing worth knowing. But it does not
 * abort the pass: one broken surface must not cost the eyeball on the other
 * eight, so each is its own `test`.
 */
async function shoot(name: string): Promise<void> {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('master'));

    const whatsNew = page.locator('.whats-new-backdrop');
    await whatsNew.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    if (await whatsNew.count()) {
        // Shot BEFORE dismissing: the release popup is a surface too, and it is
        // the first thing every upgrading user sees.
        await shoot('00-whats-new');
        await page.getByRole('button', { name: 'Got it' }).click();
        await expect(whatsNew).toHaveCount(0);
    }

    const seeded = await readMasterSeed(app);
    if (!seeded) throw new Error('the master fixture never published its seed');
    seed = seeded;
});

test.afterAll(async () => {
    if (app) await killMasterTerminals(app).catch(() => {});
    if (app) await withTeardownBound(app.close(), 20_000, 'app.close()').catch(() => {});
});

test('the master window', async () => {
    await expect(page.locator('.ams-agent-grid').first()).toBeVisible({ timeout: 20_000 });
    await shoot('01-master-window');
});

test('an agent panel, opened the way a person opens one', async () => {
    // ONE click — the same gesture the owner counted three of. If this ever
    // needs two again, the shot shows an empty floor and says so.
    const square = page.locator('.ams-agent-grid button').filter({ hasText: seed.driverAgentName }).first();
    await square.click();
    await expect(page.locator('.tpanel').filter({ hasText: seed.terminalLabel })).toBeVisible({
        timeout: 20_000,
    });
    await shoot('02-agent-panel');
});

test('the agent menu — every item it offers', async () => {
    // THE SURFACE THAT KEPT SHIPPING BROKEN. "Edit agent…" silently did nothing
    // for a dormant agent; before that, Delete took two attempts and a
    // right-click did nothing at all. A picture of this menu beside the build is
    // the cheapest possible check that its items are the ones intended.
    const square = page.locator('.ams-agent-grid button').filter({ hasText: seed.driverAgentName }).first();
    await square.click({ button: 'right' });
    await expect(page.locator('.agent-ctx-menu')).toBeVisible({ timeout: 10_000 });
    await shoot('03-agent-menu');
    await page.keyboard.press('Escape');
});

test('a DORMANT agent’s menu — the one whose Edit did nothing', async () => {
    const peer = page.locator('.ams-agent-grid button').filter({ hasText: seed.sidecarAgentName }).first();
    if ((await peer.count()) === 0) {
        test.skip(true, 'fixture has no second agent square to photograph');
        return;
    }
    await peer.click({ button: 'right' });
    await expect(page.locator('.agent-ctx-menu')).toBeVisible({ timeout: 10_000 });
    await shoot('04-agent-menu-dormant');
    await page.keyboard.press('Escape');
});

test('the empty floor', async () => {
    // What a workspace with no open panels offers. It used to be two Add Panel
    // buttons; then a live-preview grid that killed the agent it previewed.
    // Worth a picture on every build.
    const panels = page.locator('.tpanel');
    const count = await panels.count();
    for (let i = 0; i < count; i++) {
        const close = panels.nth(0).locator('[title="Close panel"], [aria-label="Close panel"]').first();
        if ((await close.count()) === 0) break;
        await close.click();
    }
    await shoot('05-empty-floor');
});
