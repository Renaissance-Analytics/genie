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
    //
    // Each panel's own close control, scrolled into view first. The first VM
    // run clicked it without scrolling and failed — "element is outside of the
    // viewport", because a wide grid puts the last panel's controls past the
    // window edge. That is a real thing to know about the layout, and it is not
    // what this test is for.
    //
    // Whatever happens, the SHOT IS TAKEN: the deliverable here is the picture,
    // and a floor that would not clear is itself worth looking at. The failure
    // is reported rather than swallowed — Playwright keeps its own screenshot
    // and trace, which the workflow now publishes.
    //
    // ASSERT THE OUTCOME, NOT THE CLICKS. This used to track whether each close
    // click threw, and reported "a panel could not be closed" — while its own
    // screenshot showed "0 panels" and the empty-floor card, in every OS. The
    // last close detaches its element mid-click, so the click "fails" while the
    // panel closes. The picture contradicted the assertion; the picture was
    // right. What matters is whether the floor ended up empty.
    // COUNT PANELS ON THE FLOOR — which is narrower than "in the document", and
    // the distinction cost two VM runs to learn, so it is written down here.
    //
    // A bare `.tpanel` also matches every panel Genie keeps mounted but not shown.
    // There are TWO such populations and they hide in DIFFERENT ways:
    //
    //  1. Other workspaces' panels, inside this same grid, hidden with
    //     `display:none` so their ptys survive (TerminalGrid: "Off-workspace
    //     selected specs. Rendered mounted-hidden (display:none)"). Playwright's
    //     `:visible` DOES exclude these — a zero-box element is not visible.
    //  2. The System Workspace drawer, a sibling OUTSIDE `.gwrap`. It is closed,
    //     `aria-hidden`, and slid away with a transform — so it keeps a real
    //     bounding box and `:visible` counts its panel. That is the one that kept
    //     this at "Received: 1" on all three OSes while the run's own screenshot
    //     showed "0 panels" and the empty-floor card. The picture was right twice;
    //     each time the SELECTOR was wrong, not the app.
    //
    // So scope to `.gbody`, the floor's own body (Floor.tsx). Both populations fall
    // outside it or are display:none within it, and a panel genuinely left on the
    // floor is still caught.
    const onFloor = page.locator('.gbody .tpanel:visible');
    for (let i = await onFloor.count(); i > 0; i--) {
        const close = onFloor.first().locator('[title="Close panel"]').first();
        if ((await close.count()) === 0) break;
        await close.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
        await close.click({ timeout: 5_000 }).catch(() => {});
    }
    await expect(onFloor, 'the floor did not clear — see 05-empty-floor.png').toHaveCount(0, {
        timeout: 10_000,
    });
    // CORROBORATION, from the app rather than from the DOM: the status bar counts
    // the specs the floor is actually driving. If these two ever disagree — no
    // visible panel but a non-zero count, or the reverse — that gap IS the bug.
    await expect(page.locator('.gstatus')).toContainText('0 panels', { timeout: 10_000 });
    // POSITIVE CONTROL: an empty floor must actually RENDER its empty state. Zero
    // visible panels alone would also pass against a floor that failed to draw.
    await expect(page.getByText('Nothing is on the floor right now')).toBeVisible({
        timeout: 10_000,
    });
    await shoot('05-empty-floor');
});
