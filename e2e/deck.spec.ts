import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * THE DECK, RENDERED IN A REAL WINDOW.
 *
 * Genie 2's surfaces were unit-tested through `react-dom/server` and had never rendered in
 * a browser: 0 of 29 E2E specs touched the Deck, the Agent view or Needs-You. A green suite
 * that does not execute the new code was nevertheless used as evidence the work was
 * finished — which it is not evidence of. This is the first spec that executes it.
 *
 * The rule under test is the one the whole surface is built around:
 *
 * **A row may only offer inline answer buttons when answering inline is the WHOLE answer.**
 *
 * A ForceTheQuestion can carry up to four sub-questions. Rendering the first one's buttons
 * would submit a partial answer and tell the agent the human had decided everything, losing
 * the rest of the decision with nothing to say so. Those rows get "Open" instead — a
 * DIFFERENT affordance, not a disabled one.
 *
 * Unit tests already assert that in the abstract. What they cannot show is that the shipped
 * component, with real CSS and real event handling, does it too.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('deck'));
});

test.afterAll(async () => {
    await app?.close();
});

const clicks = () => page.evaluate(() => (window as unknown as { __DECK_CLICKS__?: string[] }).__DECK_CLICKS__ ?? []);

test('the Deck renders its bands, so the landing surface is not blank', async () => {
    // The floor of the whole thing: if this fails, nothing below means anything.
    await expect(page.getByText('Needs you', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/waiting/i).first()).toBeVisible();
});

test('a single-part question offers its REAL options, and answering reports the chosen one', async () => {
    const migrate = page.getByRole('button', { name: 'Migrate now' });
    await expect(migrate).toBeVisible();

    await migrate.click();

    // Not just "a click happened" — the exact option, against the exact question. A row
    // that submitted the wrong label would pass a weaker assertion.
    await expect.poll(clicks).toContain('answer:q-single:Migrate now');
});

test('a MULTI-PART question offers Open, and never the first part options', async () => {
    // The assertion this spec exists for. `yes` and `no` belong to sub-questions; showing
    // either means the surface can submit a partial answer.
    await expect(page.getByRole('button', { name: 'yes', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'no', exact: true })).toHaveCount(0);

    const open = page.getByRole('button', { name: 'Open', exact: true });
    await expect(open).toBeVisible();

    await open.click();
    await expect.poll(clicks).toContain('open:q-multi');
});

test('Open is a DIFFERENT affordance, not a disabled one', async () => {
    // "A disabled control is an accusation; a different shape is a fact." A greyed-out
    // Answer would tell the user they had done something wrong.
    const open = page.getByRole('button', { name: 'Open', exact: true });
    await expect(open).toBeEnabled();
});

test('a list item offers all three outcomes, and names the agent it throws back to', async () => {
    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    // Named after the agent, because resolving NUDGES it and the person should know who
    // hears about it.
    await expect(page.getByRole('button', { name: /Back to kai/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Won/ })).toBeVisible();
});

test('resolving a list item reports WHICH outcome, not merely that it was clicked', async () => {
    await page.getByRole('button', { name: /Back to kai/ }).click();
    await expect.poll(clicks).toContain('resolve:l1:thrown_back');
});

test('every row can be resolved without navigating away', async () => {
    // The acceptance test for the whole design: you can clear the band in place. If this
    // ever requires a navigation, the Deck has failed at the thing it is for.
    const before = page.url();
    await page.getByRole('button', { name: 'Dual-write' }).click();
    await expect.poll(clicks).toContain('answer:q-single:Dual-write');
    expect(page.url()).toBe(before);
});
