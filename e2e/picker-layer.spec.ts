import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * E2E test for the Add-workspace file picker's LAYER (genie #86, then #114).
 *
 * THE FIRST BUG (#86) was z-order: the in-app picker (`pickPath` →
 * FilePickerModal) rode `.ctx-scrim` at z-index 80, i.e. Genie's chrome rung.
 * react-fancy's Modal portals to `document.body` and — since genie #66 — is
 * lifted to `--z-fancy-overlay` (900). Add workspace is such a modal, so the
 * picker it launched painted UNDERNEATH the whole thing: dimmed by the modal's
 * `bg-black/50 backdrop-blur-sm` backdrop and covered by the Add-workspace form
 * itself, which swallowed every click aimed at the folder tree.
 *
 * THE SECOND BUG (#114) is why the owner still reported "renders behind the
 * modal" after #86 shipped, and it is the reason this spec grew an APPEARANCE
 * half. `.file-picker-modal` paints itself with `background: var(--shell)` and
 * `box-shadow: var(--shadow-xl)` — two tokens declared on `.gwrap`, the master
 * page's wrapper. The picker is mounted outside that wrapper, so both resolved
 * to nothing, the declarations went invalid-at-computed-value-time, and the
 * longhands fell back to `transparent` / `none`. The panel was on top, and
 * clickable, and completely see-through: the modal showed straight through it.
 * Every assertion #86 left behind passed the whole time.
 *
 * WHY E2E: the unit suite runs in Node with no DOM, so it can only assert what
 * the stylesheet SAYS (see renderer/lib/__tests__/overlay-layers.test.ts). Only
 * a real compositor can answer the two questions the owner actually asked —
 * "can I click the folder?" and "why can I see the modal through it?" — because
 * both are about computed style and hit-testing, not source.
 *
 * So the assertions come in two kinds, and neither is an appearance snapshot:
 *   1. HIT-TESTS. `document.elementFromPoint` at the picker's centre lands
 *      INSIDE the picker (pre-#86 it landed on the Add-workspace form on every
 *      OS — a `<select>` on Windows, a flex row on macOS/Linux), and
 *      Playwright's own actionability check, which fails a click with
 *      "intercepts pointer events" if anything overlays the target.
 *   2. COMPUTED PAINT. The panel's resolved `background-color` is fully opaque
 *      and its `box-shadow` is not `none` — i.e. the tokens actually resolved
 *      where the picker renders. That is the #114 regression in one number.
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
    // is now Add workspace → New workspace → Browse. Done once: every test below
    // drives Browse from here. Since genie#431 "New workspace" is a form, not a
    // wizard: it asks where the workspace should live, and that field's Browse
    // is the picker under test.
    await page.getByRole('heading', { name: 'New workspace', exact: true }).click();
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

test('the picker panel is OPAQUE — the modal behind it must not show through', async () => {
    await openPicker(page);
    // Same precondition as the hit-test above: the modal is still there, so
    // "you cannot see it through the picker" is a claim about the picker's
    // paint and not about an empty screen.
    await expectModalStanding(page);

    const paint = await page.evaluate((sel) => {
        const panel = document.querySelector(sel) as HTMLElement | null;
        if (!panel) return null;
        const cs = getComputedStyle(panel);
        // Chromium reports `rgba(0, 0, 0, 0)` for a background that never
        // resolved and `rgb(r, g, b)` for an opaque one, so the alpha channel
        // is the whole test: 3 components means opaque, 4 means read it.
        const parts = /^rgba?\(([^)]+)\)$/
            .exec(cs.backgroundColor)?.[1]
            .split(',')
            .map((s) => Number(s.trim()));
        return {
            backgroundColor: cs.backgroundColor,
            alpha: parts ? (parts.length === 4 ? parts[3] : 1) : 0,
            boxShadow: cs.boxShadow,
        };
    }, PICKER);

    expect(paint, 'picker should be mounted').not.toBeNull();
    expect(
        paint!.alpha,
        `the panel's computed background is "${paint!.backgroundColor}" — a see-through ` +
            `panel shows the Add-workspace modal straight through it, which is what ` +
            `"the picker renders behind the modal" actually looked like (genie #114). ` +
            `It means var(--shell) resolved to nothing where the picker renders.`,
    ).toBe(1);
    expect(
        paint!.boxShadow,
        'var(--shadow-xl) resolved to nothing too — the panel has no elevation at all',
    ).not.toBe('none');
});

test("the picker is portaled to Genie's overlay root — a direct child of <body>", async () => {
    // Being a body child is what makes the layer robust rather than lucky:
    // `--z-picker` only outranks the Fancy portal while nothing between the
    // picker and the root forms a stacking context. Rendered in place, that was
    // one `transform` on an ancestor away from silently breaking again — on
    // whichever screen grew the property, which is why this is asserted
    // structurally instead of trusted.
    await openPicker(page);

    const dom = await page.evaluate((sel) => {
        const panel = document.querySelector(sel);
        const host = panel?.parentElement?.parentElement ?? null;
        if (!host) return null;
        return {
            hostId: host.id,
            hostClass: host.className,
            parentIsBody: host.parentElement === document.body,
        };
    }, PICKER);

    expect(dom, 'picker should be mounted inside a host element').not.toBeNull();
    expect(dom!.hostId).toBe('genie-overlay-root');
    expect(dom!.parentIsBody, `overlay root sat inside "${dom!.hostId}", not <body>`).toBe(true);
    // The class is not decoration — it carries the surface tokens the panel
    // paints with, which is the other half of #114.
    expect(dom!.hostClass.split(/\s+/)).toContain('genie-overlay-root');
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

test('the folder tree itself takes the click — picking a row arms Choose', async () => {
    // The reported repro in one test: the owner's complaint was never about the
    // picker's own buttons, it was that the DRIVE LIST — the thing sitting in
    // the middle of the panel, right over the Add-workspace form — could not be
    // used. The previous test cancelled its picker, so this opens a fresh one
    // and nothing is selected yet.
    await openPicker(page);
    const picker = page.locator(PICKER);
    const choose = picker.getByRole('button', { name: 'Choose' });
    await expect(choose).toBeDisabled();

    // Windows lists drive letters here, macOS/Linux the root's children; either
    // way the first row is a directory and directories are selectable in this
    // mode, so the assertion is the same everywhere.
    const row = picker.locator('[data-react-fancy-file-browser-row]').first();
    await expect(row).toBeVisible();
    // If anything overlays the tree, this click fails the actionability check
    // with "intercepts pointer events" instead of selecting.
    await row.click();

    await expect(choose, 'clicking a folder should select it and arm Choose').toBeEnabled();
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
