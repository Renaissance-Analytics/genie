import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * FIRST RUN, IN A REAL WINDOW, ON A WORKSTATION WITH NO WORKSPACES.
 *
 * ## Why this file is the whole point
 *
 * P7 asked for first run to go from seven gates to two steps. Measured while doing it,
 * **`FirstRunOnboarding` was not mounted anywhere** — the seven gates were true of a FILE and not
 * of the product, and an E2E comment recorded the swap as deliberate: *"`FirstRunOnboarding` has no
 * mount site; the Genie OS layer asserted on below replaced it."* A component with no mount site
 * passes every unit test it has forever.
 *
 * So the assertion that matters here is not what the flow looks like. It is **that it opens at
 * all**, on the one state it exists for, in the real window, through the real boot path. Owner
 * approved mounting it after reading how Paperclip onboards.
 *
 * ## `GENIE_E2E_EMPTY_WORKSTATION`
 *
 * First run is defined by `workspaces.length === 0`, and the master seed's whole job is to make
 * that false — so the rig skips the seed and clears the reused profile. A separate harness page
 * would have been easier and would have tested a different window: this needs the real master
 * route, because "is it mounted" is exactly the question.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('master', { GENIE_E2E_EMPTY_WORKSTATION: '1' }));

    // A throwaway profile has never seen this build's release notes, and they load asynchronously.
    const whatsNew = page.locator('.whats-new-backdrop');
    await whatsNew.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    if (await whatsNew.count()) {
        await page.getByRole('button', { name: /Get started|Close/ }).first().click().catch(() => {});
    }
});

test.afterAll(async () => {
    await app?.close();
});

test('the workstation really is empty, so this file is testing the state it claims', async () => {
    // POSITIVE CONTROL for the rig flag. Without it every assertion below could pass on a seeded
    // workstation for reasons that have nothing to do with first run.
    // Read from the RENDERER rather than from main: the rail lists one `.tproj` row per workspace,
    // so zero rows is the same fact seen through the surface that depends on it — and it needs no
    // dynamic import of a main module, which the e2e tsconfig cannot type.
    await expect(
        page.locator('.tproj'),
        'GENIE_E2E_EMPTY_WORKSTATION should have cleared the seed',
    ).toHaveCount(0);
});

test('STEP ONE opens by itself: pick a folder', async () => {
    // The thing that did not exist. A first run that never appears is indistinguishable from one
    // that was never built, which is where this component spent its whole life.
    await expect(page.getByRole('dialog').first()).toBeVisible({ timeout: 15_000 });
    // `AddWorkspaceModal` offers the ways a workspace can START — make one, or adopt one that
    // exists. The owner's framing: *"users can tell genie they want to start a new
    // project/workspace or import from tynn if tynn is connected."*
    await expect(page.getByText('New workspace', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Open existing folder', { exact: false }).first()).toBeVisible();
});

test('it is not a GATE — the app is reachable without answering it', async () => {
    // The whole correction to the seven gates: nothing blocks. Closing the folder step leaves a
    // usable window rather than a wall, which is also what makes Tynn optional meaningful.
    await page.keyboard.press('Escape');
    await expect(page.locator('.gwrap')).toBeVisible();
    // And the Deck is behind it, because that is the default surface.
    await expect(page.locator('.deck')).toBeVisible({ timeout: 10_000 });
});
