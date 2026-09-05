import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { killMasterTerminals, launchGenieE2E } from './helpers/launch';

/**
 * THE FLOW MANAGER, in the real master window (genie#394).
 *
 * `main/flows/` shipped a complete automation system with no surface at all —
 * no IPC, no UI, no way to see whether a Flow had ever run. This covers the
 * surface it now has, in the window it actually lives in: `launchGenieE2E`
 * loads `master.html`, so the header cluster and the flyout are the product's,
 * not a harness page's.
 *
 * ## What is here that a unit test cannot do
 *
 * Two things, and only two — the rest is covered in main, where it belongs:
 *
 *  1. **The header button animates.** `flows/__tests__/activity.test.ts` proves
 *     the running SET is right, and `run-announcement.test.ts` proves the
 *     runtime announces a start for exactly the bodies it executes. Neither can
 *     see a pixel. Whether that state crosses the preload bridge and actually
 *     moves the icon is a question about a live compositor.
 *  2. **The state clears.** A badge that gets stuck is worse than no badge, and
 *     "stuck" is invisible to a test that only ever looks once.
 *
 * ## How the animation is measured
 *
 * Not by reading the class back — asserting `.is-running` is present after
 * setting it is a test of the test. `getAnimations()` asks the COMPOSITOR what
 * is actually running on that element, so a rule the stylesheet never applied,
 * a keyframe name that does not resolve, or a selector that stopped matching all
 * come back as zero animations. The class assertion is kept beside it as the
 * cheap locator check, not as the evidence.
 *
 * Activity is pushed through the REAL `flows:activity` channel by the fixture
 * (`main/e2e/flows.ts`), which explains there why a genuine run is not used: every
 * built-in body finishes in milliseconds, so racing one would be timing a
 * flicker. Channel drift between the broadcast and the listener is caught
 * structurally by `main/__tests__/flow-ipc-channels.test.ts`.
 */

let app: ElectronApplication;
let page: Page;

const flowsButton = () => page.locator('.gicon.flows-button');
const flyout = () => page.locator('[role="dialog"][aria-label="Flows"]');

/** Ask the compositor what is animating — not the stylesheet, and not the class. */
async function runningAnimations(selector: string): Promise<number> {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return -1;
        return el.getAnimations().filter((a) => a.playState === 'running').length;
    }, selector);
}

/** Push run state from main, exactly as the runtime's callbacks do. */
async function setRunning(running: string[]): Promise<void> {
    await app.evaluate(({}, ids) => {
        const fixture = (globalThis as Record<string, unknown>).__GENIE_E2E_FLOWS__ as
            | { emit: (running: string[]) => void }
            | undefined;
        if (!fixture) throw new Error('__GENIE_E2E_FLOWS__ missing — seed did not run');
        fixture.emit(ids);
    }, running);
}

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('master'));

    // The throwaway profile starts without the first-run marker; dismiss
    // onboarding through the real path rather than poking localStorage.
    const onboarding = page
        .locator('[data-react-fancy-modal]')
        .filter({ hasText: 'Getting the Workstation Ready' });
    await onboarding.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    if (await onboarding.count()) {
        await page.keyboard.press('Escape');
        await expect(onboarding).toHaveCount(0);
    }
    await expect(flowsButton()).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
    // Kill the ptys BEFORE quitting. This spec loads the REAL master page, so a
    // quit with a live terminal raises the keep-or-shut-down confirmation for
    // real — and `app.close()` would then sit out its 30s decision timeout with
    // nobody there to answer. Same reason `master-window.spec.ts` does it.
    if (app) await killMasterTerminals(app).catch(() => {});
    await app?.close();
});

test.describe('the header button', () => {
    test('sits in the icon cluster and opens the manager', async () => {
        await expect(flowsButton()).toHaveAttribute('aria-label', 'Flow Manager');
        // Same treatment as its neighbours: it IS a `.gicon`, rather than
        // something that merely looks like one.
        await expect(flowsButton()).toHaveClass(/\bgicon\b/);

        await expect(flyout()).toHaveAttribute('aria-hidden', 'true');
        await flowsButton().click();
        await expect(flyout()).toHaveAttribute('aria-hidden', 'false');
        await page.keyboard.press('Escape');
        await expect(flyout()).toHaveAttribute('aria-hidden', 'true');
    });

    test('is STILL while nothing is running (control)', async () => {
        await setRunning([]);
        await expect(flowsButton()).not.toHaveClass(/is-running/);
        // The control for the test below: zero here and non-zero there is what
        // makes the animation assertion about the Flow state rather than about
        // some animation the header always has.
        expect(await runningAnimations('.gicon.flows-button')).toBe(0);
    });

    test('animates while a Flow is running, and stops when it ends', async () => {
        await setRunning(['e2e-flow-manual']);
        await expect(flowsButton()).toHaveClass(/is-running/);
        expect(await runningAnimations('.gicon.flows-button')).toBeGreaterThan(0);

        await setRunning([]);
        await expect(flowsButton()).not.toHaveClass(/is-running/);
        // A stuck badge is worse than no badge. This is the assertion that
        // catches one.
        expect(await runningAnimations('.gicon.flows-button')).toBe(0);
    });
});

test.describe('the manager', () => {
    test.beforeEach(async () => {
        await setRunning([]);
        if ((await flyout().getAttribute('aria-hidden')) === 'true') {
            await flowsButton().click();
        }
        await expect(flyout()).toHaveAttribute('aria-hidden', 'false');
    });

    test('lists the seeded Flows with their scope and trigger', async () => {
        const row = flyout().locator('.flowmgr-row', { hasText: 'Tidy the workspace' });
        await expect(row).toBeVisible();
        await expect(row).toContainText('Whole machine');
        await expect(row).toContainText('When you run it');
        // Never run, and it says so rather than showing an empty cell.
        await expect(row).toContainText('Never run');
    });

    test('warns that an armed Flow whose event nothing emits cannot fire', async () => {
        const row = flyout().locator('.flowmgr-row', { hasText: 'Watch a thing that left' });
        await expect(row).toBeVisible();
        // The whole reason this surface is worth opening: the row looks entirely
        // normal — titled, enabled — and can never run again.
        await expect(row.locator('.flowmgr-warn')).toContainText('nothing can start it');
        await expect(row.locator('.flowmgr-warn')).toContainText('ghost:vanished');
    });

    test('marks the running Flow, and only that one', async () => {
        await setRunning(['e2e-flow-manual']);
        const running = flyout().locator('.flowmgr-row', { hasText: 'Tidy the workspace' });
        const idle = flyout().locator('.flowmgr-row', { hasText: 'Watch a thing that left' });

        await expect(running).toHaveClass(/is-running/);
        // Both asserted: a row that lit up for every Flow would pass the first
        // check on its own.
        await expect(idle).not.toHaveClass(/is-running/);

        await setRunning([]);
        await expect(running).not.toHaveClass(/is-running/);
    });

    test('turns a Flow off and the change survives a re-read', async () => {
        const row = flyout().locator('.flowmgr-row', { hasText: 'Tidy the workspace' });
        const toggle = row.getByRole('switch');
        await expect(toggle).toBeVisible();

        await toggle.click();
        // Disarming goes through main and comes back on `flows:changed`, so the
        // Run button disappearing is evidence the STORE changed — not that the
        // renderer toggled a local boolean.
        await expect(row.getByRole('button', { name: /Run .* now/ })).toHaveCount(0);

        await toggle.click();
        await expect(row.getByRole('button', { name: /Run .* now/ })).toHaveCount(1);
    });

    test('shows a run history drawer, and says so when there is none', async () => {
        const row = flyout().locator('.flowmgr-row', { hasText: 'Tidy the workspace' });
        await row.locator('.flowmgr-disclose').click();
        await expect(row.locator('.flowmgr-history')).toContainText('Recent runs');
        await expect(row.locator('.flowmgr-history')).toContainText('never run');
    });
});
