import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * E2E test for the AgentPulse sparkline surviving a row HOVER (genie#197).
 *
 * THE BUG: hovering a collapsed workspace row that had an active agent made the
 * activity sparkline vanish; it came back on mouse-out. `.tproj-head` carries a
 * TRANSPARENT background that becomes an OPAQUE `var(--bg-2)` on `:hover`
 * (master.css:1919), and the sparkline was rendered as a SIBLING before the
 * head, at `z-index:0` — i.e. behind it. So the hover fill painted straight over
 * the pulse.
 *
 * WHY E2E: this is a question about PAINT ORDER, and nothing short of a real
 * compositor can answer it. The unit suite runs in Node with no DOM. Even a
 * jsdom test could not help: jsdom has no layout and no painting, so an element
 * that is completely covered still reports itself as present and "visible".
 * Playwright's own `toBeVisible()` is no better here — it checks CSS visibility
 * and box size, neither of which changes when something paints on top. And
 * `elementFromPoint` cannot see it either, because the sparkline sets
 * `pointer-events:none` and hit-testing skips it by design.
 *
 * So the assertion is made of PIXELS: screenshot the row, count the pulse's own
 * indigo, and require it to still be there while the row is hovered.
 *
 * TWO GUARDS KEEP THIS FROM PASSING VACUOUSLY — the lesson of genie#114, where
 * every assertion left behind by the first fix passed while the bug was live:
 *
 *   1. The unhovered count must be > 0. Otherwise a sparkline that never drew at
 *      all — a broken fixture, an unresolved `--agent` token — would satisfy
 *      "still there when hovered" trivially, since 0 pixels survive 0 pixels.
 *   2. The hovered row's background must be fully OPAQUE. If the hover rule ever
 *      stops applying (renamed class, a Playwright hover that did not land),
 *      there is nothing to paint over the pulse and the test would pass while
 *      testing nothing. This asserts the hazard is actually present before
 *      asserting the pulse survived it.
 */

let app: ElectronApplication;
let page: Page;

/** The sparkline is `--agent` (#818cf8) mixed over the row. Both the 55% stroke
 *  and the 14% fill land markedly blue-dominant against every row colour in
 *  play — the dark hover fill is `#27272a` and the light one `#f4f4f5`, both
 *  neutral — so "blue clearly beats red and green" identifies pulse pixels
 *  without pinning a theme. */
const PULSE_PIXEL = `(r, g, b) => b > r + 12 && b > g + 12 && b > 60`;

/**
 * Count the sparkline's pixels inside the row.
 *
 * The PNG is decoded by the page's OWN image decoder — handed back as a data URL
 * and drawn to a canvas — rather than by a Node PNG library. `pngjs`/`sharp` are
 * only present transitively via Playwright, so importing one would leave this
 * spec breaking on an unrelated lockfile change.
 */
async function pulsePixels(): Promise<number> {
    const head = page.locator('.tproj-head').first();
    const shot = await head.screenshot();
    return page.evaluate(
        async ([dataUrl, predicateSrc]) => {
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = dataUrl;
            });
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('no 2d context');
            ctx.drawImage(img, 0, 0);
            const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const isPulse = eval(predicateSrc) as (r: number, g: number, b: number) => boolean;
            let n = 0;
            for (let i = 0; i < data.length; i += 4) {
                if (isPulse(data[i]!, data[i + 1]!, data[i + 2]!)) n++;
            }
            return n;
        },
        [`data:image/png;base64,${shot.toString('base64')}`, PULSE_PIXEL] as const,
    );
}

/** Alpha of the row's resolved background — 1 once the hover fill applies. */
async function headBackgroundAlpha(): Promise<number> {
    return page.locator('.tproj-head').first().evaluate((el) => {
        const bg = getComputedStyle(el).backgroundColor;
        const m = /rgba?\(([^)]+)\)/.exec(bg);
        if (!m) return 0;
        const parts = m[1]!.split(',').map((s) => parseFloat(s));
        return parts.length < 4 ? 1 : parts[3]!;
    });
}

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('agent-pulse'));
    await expect(page.locator('.tproj-head').first()).toBeVisible();

    // The sparkline renders for COLLAPSED rows only — an expanded workspace shows
    // its terminals' own per-row lights instead. Collapse by clicking the real
    // chevron rather than seeding the persisted set, so the spec fails if that
    // control regresses.
    await page.locator('.tproj-head [title="Collapse"]').first().click();

    // Fill the ring through the REAL `agent-pulse` broadcast. Several samples of
    // differing size so the polyline has actual shape: a flat ring maps every
    // point to the same y and draws a single thin line, which would make the
    // pixel counts needlessly small and brittle.
    await app.evaluate(({}, samples) => {
        const fixture = (globalThis as Record<string, unknown>).__GENIE_E2E_PULSE__ as
            | { emit: (bytes: number) => void }
            | undefined;
        if (!fixture) throw new Error('__GENIE_E2E_PULSE__ missing — seed did not run');
        for (const s of samples) fixture.emit(s);
    }, [400, 1200, 300, 2400, 800, 1800, 200, 3000]);

    await expect(page.locator('.agent-pulse-spark')).toBeVisible();
});

test.afterAll(async () => {
    await app?.close();
});

test('the pulse is drawn on an idle row', async () => {
    // Guard 1. Everything below compares against this number, so if the pulse
    // never painted, the survival assertion would be vacuously true.
    expect(await pulsePixels()).toBeGreaterThan(0);
});

test('hovering the row paints an opaque fill over it', async () => {
    // Guard 2. The bug was the hover fill covering the pulse; if the fill stops
    // applying there is no hazard left and the next test proves nothing.
    await page.locator('.tproj-head').first().hover();
    await expect.poll(headBackgroundAlpha).toBe(1);
});

test('the pulse survives the hover — genie#197', async () => {
    const idle = await pulsePixels();

    await page.locator('.tproj-head').first().hover();
    await expect.poll(headBackgroundAlpha).toBe(1);
    const hovered = await pulsePixels();

    // Pre-fix this was ~0: the opaque fill painted straight over the sparkline.
    // Not asserting equality — the fill changes what the semi-transparent pulse
    // composites against, so individual pixels legitimately shift. What must not
    // happen is the pulse DISAPPEARING, so the bar is a healthy fraction of the
    // idle count rather than an exact match.
    expect(hovered).toBeGreaterThan(idle * 0.5);
});

test('the pulse is painted by the hovered element itself, not behind it', async () => {
    // The structural invariant behind the fix, pinned so a future refactor that
    // moves the sparkline back OUT of the head reads as the regression it is —
    // the pixel tests above would still pass if the head merely stopped growing
    // an opaque fill, and this says WHY the pixels survive.
    const nested = await page
        .locator('.agent-pulse-spark')
        .first()
        .evaluate((el) => Boolean(el.closest('.tproj-head')));
    expect(nested).toBe(true);

    const z = await page
        .locator('.agent-pulse-spark')
        .first()
        .evaluate((el) => getComputedStyle(el).zIndex);
    expect(Number(z)).toBeLessThan(0);
});
