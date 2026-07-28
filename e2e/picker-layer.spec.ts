import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * E2E test for the Add-workspace file picker's STACKING (genie #86).
 *
 * THE BUG: the in-app picker (`pickPath` → FilePickerModal) rode `.ctx-scrim` at
 * z-index 80, i.e. Genie's chrome rung. react-fancy's Modal portals to
 * `document.body` and — since genie #66 — is lifted to `--z-fancy-overlay` (900).
 * Add workspace is such a modal, so the picker it launched painted UNDERNEATH
 * the whole thing: dimmed by the modal's `bg-black/50 backdrop-blur-sm` backdrop
 * and covered by the Add-workspace form itself, which swallowed every click
 * aimed at the folder tree.
 *
 * WHY E2E: the unit suite runs in Node with no DOM, so it can only assert the
 * CSS ladder's numbers (see renderer/lib/__tests__/overlay-layers.test.ts). It
 * cannot answer the question the owner actually asked — "can I click the
 * folder?" That needs a real compositor and real hit-testing, which is what this
 * spec gets from the compiled Electron app.
 *
 * The two assertions that matter are both hit-tests, not appearances:
 *   1. `document.elementFromPoint` at the picker's centre lands INSIDE the
 *      picker. Pre-fix it landed on the Add-workspace form on every OS — a
 *      `<select>` on Windows, a flex row on macOS/Linux.
 *   2. Playwright's own actionability check on the picker's buttons — a click
 *      fails with "intercepts pointer events" if anything overlays the target.
 *
 * It also pins the layering's second-order rule: dismissing the picker (button
 * OR Escape) must leave the Add-workspace modal — and the user's input — intact.
 *
 * Each test opens its own picker and asserts against the modal independently, so
 * a failure reports its own cause instead of cascading into the next test.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('picker-layer'));
    // Walk the modal to the step that owns a folder picker — the reported repro
    // is Add workspace → Simple → Local folder → Browse. Done once: every test
    // below drives Browse from here.
    await page.getByRole('heading', { name: 'Simple', exact: true }).click();
    // `local` is already the default source mode; clicking it keeps the spec on
    // the documented path if that default ever changes.
    await page.getByRole('button', { name: 'Local folder' }).click();
});

test.afterAll(async () => {
    await app?.close();
});

const PICKER = '.file-picker-modal';
const MODAL = '[data-react-fancy-modal]';
const MODAL_CLOSED = '[data-testid="modal-closed"]';

/**
 * Ensure a picker is open, reusing one a previous test left behind. Reusing
 * matters: post-fix the picker covers the Browse button (that is the whole
 * point), so blindly clicking Browse again would be the thing under test.
 */
async function openPicker(p: Page): Promise<void> {
    if ((await p.locator(PICKER).count()) === 0) {
        await p.getByRole('button', { name: 'Browse' }).click();
    }
    await expect(p.locator(PICKER)).toBeVisible();
}

/** The launching modal is still mounted — nothing here may dismiss it. */
async function expectModalStanding(p: Page): Promise<void> {
    await expect(p.locator(MODAL)).toBeVisible();
    await expect(p.locator(MODAL_CLOSED)).toHaveCount(0);
}

test('the picker opened from the modal is the TOP layer at its own centre', async () => {
    await openPicker(page);
    // The modal that launched it is still mounted — otherwise "on top" would be
    // trivially true and this whole spec vacuous.
    await expectModalStanding(page);

    const hit = await page.evaluate((sel) => {
        const panel = document.querySelector(sel) as HTMLElement | null;
        const modalPanel = document.querySelector('[data-react-fancy-modal]');
        if (!panel || !modalPanel) return null;
        const r = panel.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        // The Fancy modal's POSITIONED element is the portal child wrapping the
        // panel — the thing master.css lifts to --z-fancy-overlay.
        const modalLayer = modalPanel.parentElement as HTMLElement;
        return {
            insidePicker: !!at && panel.contains(at),
            // What actually sat on top pre-fix, for a legible failure message.
            hitClass: at ? (at as HTMLElement).className.slice(0, 80) : '(nothing)',
            pickerZ: Number(getComputedStyle(panel.parentElement!).zIndex),
            modalZ: Number(getComputedStyle(modalLayer).zIndex),
        };
    }, PICKER);

    expect(hit, 'picker + modal should both be mounted').not.toBeNull();
    expect(
        hit!.insidePicker,
        `centre of the picker hit-tested to "${hit!.hitClass}" instead of the picker`,
    ).toBe(true);
    expect(hit!.pickerZ).toBeGreaterThan(hit!.modalZ);
});

test('the picker receives clicks — the folder tree is usable, not just visible', async () => {
    await openPicker(page);
    const picker = page.locator(PICKER);

    // Nothing is picked yet, so the primary is gated — proves this is a live
    // picker rather than a leftover shell.
    await expect(picker.getByRole('button', { name: 'Choose' })).toBeDisabled();
    // Playwright refuses to click an element that another element covers, so
    // this click IS the interactivity assertion: pre-fix the Add-workspace form
    // sat on top of it and the step times out.
    await picker.getByRole('button', { name: 'Cancel' }).click();

    await expect(picker).toHaveCount(0);
    // Dismissing a picker must not throw away the form behind it.
    await expectModalStanding(page);
});

test('Escape closes the top layer only, not the modal underneath', async () => {
    // react-fancy's Modal listens for Escape on `document`; the picker captures
    // it on `window` and stops it there. Without that, one keypress dismissed
    // both — the picker AND the Add-workspace modal behind it.
    await openPicker(page);

    await page.keyboard.press('Escape');

    await expect(page.locator(PICKER)).toHaveCount(0);
    await expectModalStanding(page);

    // And Escape with no picker open still closes the modal — the capture must
    // not have permanently stolen the key from the layer below it.
    await page.keyboard.press('Escape');
    await expect(page.locator(MODAL_CLOSED)).toBeVisible();
});
