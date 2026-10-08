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
 * ## A FRESH PROFILE IS NOT A QUIET ONE, which the first version of this file got wrong
 *
 * Two things measured on CI rather than assumed:
 *
 *  1. **The Genie OS layer opens over the Deck**, because a throwaway profile has
 *     `genieOsStatus().setup === false` and that is what first run does. Three specs here timed out
 *     at 15s against a Deck that was underneath it.
 *  2. **The strip is NOT empty on a fresh profile.** GitHub is not connected and IssueWatch cannot
 *     tell whether the workspace is tracked, so two signals are legitimately true — the product is
 *     right and the assertion was wrong. So nothing here asserts an EMPTY strip or a total count;
 *     every case is about the Flows signal, which `setFlowsRunning` controls.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('master'));

    // A throwaway profile has never seen this build's release notes. They load asynchronously, so
    // dismiss the real dialog before driving anything behind it.
    const whatsNew = page.locator('.whats-new-backdrop');
    await whatsNew.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    if (await whatsNew.count()) {
        await page.getByRole('button', { name: /Get started|Close/ }).first().click().catch(() => {});
    }

    // AND THE GENIE OS LAYER, which first run opens over the Deck. Its backdrop is the close
    // control — a real button with a real label, which is also why deleting the icon did not leave
    // the layer unclosable.
    const osLayer = page.locator('.genie-os-layer.is-open');
    if (await osLayer.count()) {
        await page.getByRole('button', { name: 'Close Genie OS' }).click();
        await expect(osLayer).toHaveCount(0);
    }
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
const flowSignal = () => strip().getByText('A Flow is running', { exact: false });

test('the Deck is what opens with no view asked for', async () => {
    // The floor of this file: every assertion below is about the Deck's strip, and a window that
    // opened the grid would report "no signal" for the happiest of reasons.
    await expect(page.locator('.deck')).toBeVisible();
});

test('a running Flow SAYS SO, and stops saying so when it ends', async () => {
    // This is what the Flows icon's animation meant, and the reason it could not simply become a
    // palette row. Measured through the real broadcast, not a prop.
    await setFlowsRunning([]);
    await expect(flowSignal()).toHaveCount(0);

    await setFlowsRunning(['e2e-flow-manual']);
    await expect(flowSignal()).toBeVisible();

    await setFlowsRunning([]);
    // A stuck signal is worse than no signal — the same failure as a badge that never clears, and
    // it is what makes people stop believing the strip.
    await expect(flowSignal()).toHaveCount(0);
});

test('a signal is still a DOOR — clicking it opens what the icon opened', async () => {
    await setFlowsRunning(['e2e-flow-manual']);
    await expect(flowSignal()).toBeVisible();
    await flowSignal().click();

    // The Flow Manager, reached from the signal rather than from a deleted icon. The root is the
    // shared `.docs-flyout-root` filtered by what it contains — the flyout has no class of its own,
    // which `master-window.spec.ts` records the hard way.
    const flowsRoot = page
        .locator('.docs-flyout-root')
        .filter({ has: page.locator('[aria-label="Flows"]') });
    await expect(flowsRoot).toHaveClass(/\bopen\b/);

    await page.keyboard.press('Escape');
    await setFlowsRunning([]);
});

test('the signal carries the FEATURE it is about, so the route cannot drift', async () => {
    // `data-feature` is the id `activateFeature` dispatches on — the same one the palette uses. If
    // these ever diverge, a signal opens the wrong thing while both still "work".
    //
    // Scoped to the Flows signal rather than counting the strip: a fresh profile legitimately shows
    // others, and a total would be asserting the fixture's GitHub state by accident.
    await setFlowsRunning(['e2e-flow-manual']);
    await expect(strip().locator('[data-feature="flows"]')).toHaveCount(1);
    await expect(strip().locator('[data-feature="flows"]')).toHaveAttribute('data-tone', 'busy');
    await setFlowsRunning([]);
});
