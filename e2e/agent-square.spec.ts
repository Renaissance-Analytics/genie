import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
    killMasterTerminals,
    launchGenieE2E,
    readLiveTerminals,
    readMasterSeed,
    withTeardownBound,
    type MasterSeed,
} from './helpers/launch';

/**
 * THE AGENT SQUARE IS AN INTERACTIVE OBJECT (genie#727).
 *
 * The owner, in one sitting:
 *
 *   "I should not have to click the fucking agent square twice to get the panel
 *   to open. I should be able to delete the fucking agents by selecting delete 1
 *   time. Not two times and then only on the second time does it give me the
 *   proper delete agent UX."
 *
 *   "I can't even right click on the agent square to get a menu, nothing
 *   happens."
 *
 * Three symptoms, one cause: the square is drawn like a control but is not wired
 * like one. Its primary click does not do the primary action, its destructive
 * action does not reach its own confirmation on first ask, and it answers no
 * right-click at all — while every other object in this window does.
 *
 * WHY THIS IS AN E2E AND NOT A UNIT TEST. The handlers are already present in
 * `Chooser.tsx` and read as correct: `onOpen` toggles the spec, `onContextMenu`
 * calls `preventDefault` and routes by row kind, and the menu renders through a
 * portal. A unit test of any of those pieces passes today. What the owner is
 * hitting is what the assembled window actually does when a real person clicks
 * once — which is exactly what no unit test was asked, and why this bug survived
 * the surrounding coverage.
 *
 * These assertions are written from the owner's words, not from a diagnosis:
 * ONE click opens, ONE right-click shows a menu, ONE delete reaches the real
 * confirm. If a rewrite satisfies them by a different route than the one I would
 * have guessed, that is the test doing its job.
 */

let app: ElectronApplication;
let page: Page;
let seed: MasterSeed;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('master'));

    const whatsNew = page.locator('.whats-new-backdrop');
    await whatsNew.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    if (await whatsNew.count()) {
        await page.getByRole('button', { name: 'Got it' }).click();
        await expect(whatsNew).toHaveCount(0);
    }

    const seeded = await readMasterSeed(app);
    if (!seeded) {
        throw new Error(
            'the master fixture never published its seed — the window is showing whatever the profile already held, so nothing below would mean anything',
        );
    }
    seed = seeded;
});

test.afterAll(async () => {
    if (app) await killMasterTerminals(app).catch(() => {});
    if (app) await withTeardownBound(app.close(), 20_000, 'app.close()').catch(() => {});
});

/** The square for an agent, in the workspace rail's agent grid. */
const square = (name: string) =>
    page.locator('.ams-agent-grid button').filter({ hasText: name }).first();

const panel = (label: string) => page.locator('.tpanel').filter({ hasText: label });

/** The AGENT menu specifically. The terminal menu is also a `.proj-popover`, so
 *  a looser locator would pass against the very menu this bug was about. */
const agentMenu = () => page.locator('.agent-ctx-menu');

test('ONE click on an agent square opens its panel', async () => {
    const driver = square(seed.driverAgentName);
    await expect(driver).toBeVisible();

    // POSITIVE CONTROL — the panel is genuinely absent first, so "it appeared"
    // below cannot be a panel that was already there.
    const before = await panel(seed.terminalLabel).count();

    await driver.click();

    // ONE click. Not two. If this needs a second click the assertion fails here,
    // which is the whole report.
    await expect(panel(seed.terminalLabel)).toBeVisible({ timeout: 15_000 });
    expect(before).toBeLessThanOrEqual(1);
});

test('clicking a square whose panel is ALREADY open still brings it to the floor', async () => {
    // The guard reads `if (!selected.has(specId)) onToggleSpec(specId)`, so a
    // square whose spec is already selected does nothing at all when clicked.
    // A control that silently does nothing is indistinguishable from a broken
    // one — clicking an open agent must still land you on its panel.
    const driver = square(seed.driverAgentName);
    await driver.click();
    await expect(panel(seed.terminalLabel)).toBeVisible();

    await driver.click();
    await expect(panel(seed.terminalLabel)).toBeVisible();
});

test('right-clicking a RUNNING agent square opens the AGENT menu', async () => {
    const driver = square(seed.driverAgentName);
    await driver.click({ button: 'right' });

    // Scoped to the agent menu's own class, not to "any popover". A running
    // agent used to get the TERMINAL menu here — which is also a `.proj-popover`
    // and would satisfy a looser locator while being the wrong menu entirely.
    await expect(agentMenu()).toBeVisible({ timeout: 5_000 });
    // It names the agent, so a menu for the wrong object cannot pass.
    await expect(agentMenu().locator('.ctx-header-label')).toHaveText(seed.driverAgentName);

    await page.keyboard.press('Escape');
});

test('a DORMANT agent square answers a right-click too', async () => {
    // The kind with no terminal spec is the one most likely to be skipped by a
    // handler keyed on having one — and the owner was right-clicking exactly
    // these (burndown, genie-pet) when nothing happened.
    const peer = square(seed.sidecarAgentName);
    if ((await peer.count()) === 0) test.skip(true, 'fixture has no second agent square');

    await peer.click({ button: 'right' });
    await expect(agentMenu()).toBeVisible({ timeout: 5_000 });
    await expect(agentMenu().locator('.ctx-header-label')).toHaveText(seed.sidecarAgentName);

    await page.keyboard.press('Escape');
});

test('choosing Delete ONCE reaches the real delete confirmation', async () => {
    const driver = square(seed.driverAgentName);
    await driver.click({ button: 'right' });

    await expect(agentMenu()).toBeVisible({ timeout: 5_000 });

    // `menuitem`, which is what these are. Asking for `button` found nothing and
    // made a green app look red — the locator has to match the real markup or it
    // tests the test.
    const del = agentMenu().getByRole('menuitem', { name: /^delete/i }).first();
    await expect(del).toBeVisible();
    await del.click();

    // ONE selection. The owner's report is that the first does something else
    // and only the second raises the proper UX, so the confirm must be here now
    // — naming the agent, because a destructive confirm that does not say what
    // it destroys is how the wrong one goes.
    const confirm = page.locator('.prompt-card');
    await expect(confirm).toBeVisible({ timeout: 5_000 });
    await expect(confirm).toContainText(seed.driverAgentName);

    // Leave the fixture intact — this spec proves the confirm is REACHED, and
    // deleting the seeded agent would poison everything after it.
    const cancel = confirm.getByRole('button', { name: /cancel|no|keep/i }).first();
    if (await cancel.count()) await cancel.click();
    else await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
});

test('the panel × DISMISSES the panel and leaves the terminal running (genie#724)', async () => {
    // The owner: "The x button should not kill the terminal when I click it.
    // All that should do is remove it from the main panel display."
    //
    // It killed it, and by design: main/terminal/ipc.ts says "Explicit close
    // (the panel X) is a separate `terminal:kill`, unaffected". Meanwhile the
    // same header already carries a Pause button labelled "Suspend — keep
    // running, hide panel", which is what the owner expects × to be. So × was
    // the destructive one of two adjacent controls that look equally harmless.
    await square(seed.driverAgentName).click();
    const open = panel(seed.terminalLabel);
    await expect(open).toBeVisible({ timeout: 15_000 });

    // POSITIVE CONTROL — the pty is genuinely alive first, so "still alive"
    // below cannot pass against a terminal that was already gone.
    expect(await readLiveTerminals(app)).toContain(seed.terminalId);

    await open.locator('button.pctl[title="Close panel"]').click();

    // Gone from the floor: that part was always right.
    await expect(open).toHaveCount(0, { timeout: 10_000 });

    // STILL RUNNING. Read from main's own live-terminal list, not from the DOM —
    // a panel that stopped being rendered tells you nothing about the pty, which
    // is exactly how this went unnoticed.
    await expect
        .poll(async () => await readLiveTerminals(app), { timeout: 15_000 })
        .toContain(seed.terminalId);

    // And it can be brought back, because a dismissal you cannot undo is a kill
    // with extra steps.
    await square(seed.driverAgentName).click();
    await expect(panel(seed.terminalLabel)).toBeVisible({ timeout: 15_000 });
});
