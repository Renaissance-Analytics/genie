import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * THE SIGNALS THE TITLE-BAR ICONS CARRIED, ON THE DECK, IN A REAL WINDOW.
 *
 * P7 deleted the icon cluster. Its "8 icons → 0 icons, 0 features lost" was true of FEATURES —
 * every one has a ⌘K row and a CI guard — and not of SIGNALS: the Flows icon animated while a Flow
 * ran on this machine, AgentInbox badged mail nobody had collected, a glyph warned that GitHub
 * permissions were switching features off. A palette row says none of that.
 *
 * Owner decision, asked directly: *"move the signals to the Deck, then delete the icons."*
 *
 * `renderer/lib/station-signals.ts` decides which and in what order, and is unit-tested. This file
 * is the half a pure function cannot cover, and the half the deleted
 * `'the Flows icon is still while nothing runs, and animates while one does'` used to own: that a
 * REAL running Flow in a REAL window makes the signal appear, and stopping it makes it go.
 *
 * On the DECK, which means no `GENIE_E2E_VIEW` — the Deck is the default surface, and launching
 * without the override is also a check that it still is.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('master'));
});

test.afterAll(async () => {
    await app?.close();
});

/** Push a real flow-running set through the seeded fixture — the same path main broadcasts on. */
async function setFlowsRunning(running: string[]): Promise<void> {
    await app.evaluate(({}, ids) => {
        const fixture = (globalThis as Record<string, unknown>).__GENIE_E2E_FLOWS__ as
            | { emit: (running: string[]) => void }
            | undefined;
        if (!fixture) throw new Error('__GENIE_E2E_FLOWS__ missing — seed did not run');
        fixture.emit(ids);
    }, running);
}

const strip = () => page.getByTestId('deck-signals');
const signal = (text: string) => strip().getByText(text, { exact: false });

test('the Deck is what opens with no view asked for', async () => {
    // The floor of this file: every assertion below is about the Deck's strip, and a window that
    // opened the grid would report "no signal" for the happiest of reasons.
    await expect(page.locator('.deck')).toBeVisible();
});

test('SILENCE while nothing is happening — no strip at all', async () => {
    await setFlowsRunning([]);
    // Not a row of green ticks. A strip of reassurances is furniture, and furniture trains people
    // to stop reading the one line that will matter.
    await expect(strip()).toHaveCount(0);
});

test('a running Flow SAYS SO, and stops saying so when it ends', async () => {
    // This is what the Flows icon's animation meant, and the reason it could not simply become a
    // palette row. Measured through the real broadcast, not a prop.
    await setFlowsRunning(['e2e-flow-manual']);
    await expect(signal('A Flow is running')).toBeVisible();

    await setFlowsRunning([]);
    // A stuck signal is worse than no signal — it is the same failure as a badge that never
    // clears, and it is what makes people stop believing the strip.
    await expect(signal('A Flow is running')).toHaveCount(0);
});

test('a signal is still a DOOR — clicking it opens what the icon opened', async () => {
    await setFlowsRunning(['e2e-flow-manual']);
    const row = signal('A Flow is running');
    await expect(row).toBeVisible();
    await row.click();

    // The Flow Manager, reached from the signal rather than from a deleted icon. The root is the
    // shared `.docs-flyout-root` filtered by what it contains — the flyout has no class of its own,
    // which `master-window.spec.ts` records the hard way.
    const flowsRoot = page
        .locator('.docs-flyout-root')
        .filter({ has: page.locator('[aria-label="Flows"]') });
    await expect(flowsRoot).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await setFlowsRunning([]);
});

test('the signal carries the FEATURE it is about, so the route cannot drift', async () => {
    // `data-feature` is the id `activateFeature` dispatches on — the same one the palette uses.
    // If these ever diverge, a signal opens the wrong thing while both still "work".
    await setFlowsRunning(['e2e-flow-manual']);
    await expect(strip().locator('[data-feature="flows"]')).toHaveCount(1);
    await expect(strip().locator('[data-tone="busy"]')).toHaveCount(1);
    await setFlowsRunning([]);
});
