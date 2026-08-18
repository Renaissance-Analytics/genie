import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * E2E test for the AgentPulse sparkline surviving a row HOVER (genie#197).
 *
 * THE BUG: hovering a collapsed workspace row that had an active agent made the
 * activity sparkline vanish; it came back on mouse-out. `.tproj-head` carries a
 * TRANSPARENT background that becomes an OPAQUE `var(--bg-2)` on `:hover`
 * (master.css:1919), and the sparkline was rendered as a SIBLING before the
 * head, at `z-index:0` — i.e. behind it. So the hover fill painted over it.
 *
 * WHY E2E: this is a question about PAINT ORDER, and nothing short of a real
 * compositor can answer it. The unit suite runs in Node with no DOM, and jsdom
 * would not help either — it has no layout and no painting, so a completely
 * covered element still reports itself present and "visible". Playwright's own
 * `toBeVisible()` is no better: it checks CSS visibility and box size, neither of
 * which changes when something paints on top. `elementFromPoint` cannot see it
 * either, because the sparkline sets `pointer-events:none` by design.
 *
 * So the assertion is made of PIXELS. Which puts the burden on the MEASUREMENT
 * being honest, and three things had to be fixed before it was — each of them
 * caught by a guard below rather than by luck:
 *
 *   - The row must not be the SELECTED one. `.tproj.is-active > .tproj-head`
 *     (0,3,0) sets its own background and beats `.tproj-head:hover` (0,2,0), so a
 *     selected row never takes the hover fill and cannot exhibit the bug.
 *   - The row must not be AGENT-ACTIVE while measuring. That class paints the
 *     workspace NAME in `var(--agent)` — the same indigo as the sparkline — and
 *     text is non-positioned content that paints ABOVE the head's background, so
 *     it survives any hover. Counting it made the broken layout look fixed.
 *   - The measurement must not scroll, and the hover must still be on when it
 *     finishes; see {@link pulsePixelsWhileHovered}.
 *
 * The ring fills through the REAL `agent-pulse` broadcast from main, so a channel
 * drift between emit and listen fails this spec rather than dying silently.
 */

let app: ElectronApplication;
let page: Page;

/** The sparkline is `--agent` (#818cf8) mixed over the row. Both the 55% stroke
 *  and the 14% fill land markedly blue-dominant against every row colour in play
 *  — the dark hover fill is `#27272a`, the light one `#f4f4f5`, both neutral — so
 *  "blue clearly beats red and green" finds pulse pixels without pinning a theme.
 *  `sparklineIsTheOnlyIndigo` proves nothing ELSE on the row answers to it. */
const PULSE_PIXEL = `(r, g, b) => b > r + 12 && b > g + 12 && b > 60`;

const head = () => page.locator('.tproj-head').first();

/** Put the row back in the state the sparkline renders in. Tests call this
 *  rather than assuming the previous one left it collapsed — a failure part-way
 *  through the metric guard would otherwise cascade into every test after it. */
async function ensureCollapsed(): Promise<void> {
    const expand = page.locator('.tproj-head [title="Expand"]').first();
    if (await expand.count()) await expand.click();
    await expect(page.locator('.agent-pulse-spark')).toBeVisible();
}

/**
 * Count the sparkline's pixels inside the row.
 *
 * A CLIP screenshot of the page, never `locator.screenshot()`: an element
 * screenshot calls scrollIntoViewIfNeeded first, and any scroll moves the row out
 * from under the mouse, which drops `:hover` and removes the very fill this spec
 * checks the pulse survives.
 *
 * The PNG is decoded by the page's OWN decoder — handed back as a data URL and
 * drawn to a canvas — rather than by a Node PNG library: `pngjs`/`sharp` are only
 * present transitively via Playwright, so importing one would leave this spec
 * breaking on an unrelated lockfile change.
 */
async function pulsePixels(): Promise<number> {
    const box = await head().boundingBox();
    if (!box) throw new Error('row has no box');
    const shot = await page.screenshot({ clip: box });
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
    return head().evaluate((el) => {
        const bg = getComputedStyle(el).backgroundColor;
        const m = /rgba?\(([^)]+)\)/.exec(bg);
        if (!m) return 0;
        const parts = m[1]!.split(',').map((s) => parseFloat(s));
        return parts.length < 4 ? 1 : parts[3]!;
    });
}

/**
 * Count the pulse with the row genuinely hovered THROUGHOUT the measurement.
 *
 * The row re-renders about once a second — the ring keeps shifting — and a
 * re-render can leave the browser's hover state stale until the pointer moves
 * again, which showed up on Windows as a fully opaque row before the screenshot
 * and a fading `alpha: 0.224` after it. A count taken across that gap is a count
 * of an UNHOVERED row, and it "survives" in the broken layout too.
 *
 * So the pointer is re-planted, the fill is confirmed opaque, the pixels are
 * counted, and the fill is confirmed opaque AGAIN. Only a measurement bracketed
 * by two opaque readings is returned; otherwise it retries, and having never
 * managed one it throws rather than quietly reporting a number.
 */
async function pulsePixelsWhileHovered(): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
        // `hover()`, not `mouse.move()` to the same point: on Windows the raw
        // move did not register as a hover at all, while the actionability hover
        // did — it is the one the other tests here use successfully.
        await head().hover();
        await expect.poll(headBackgroundAlpha).toBe(1);

        const pixels = await pulsePixels();
        if ((await headBackgroundAlpha()) === 1) return pixels;
    }
    throw new Error('could not hold the hover across a measurement');
}

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('agent-pulse'));
    await expect(head()).toBeVisible();

    // The sparkline renders for COLLAPSED rows only — an expanded workspace shows
    // its terminals' own per-row lights instead. Collapse via the real chevron, so
    // the spec fails if that control regresses.
    await page.locator('.tproj-head [title="Collapse"]').first().click();

    // Fill the ring through the REAL broadcast, with `active: false` — the ring
    // fills from `bytes` either way, and leaving the row agent-active would paint
    // its NAME in the same indigo the pixel predicate looks for. Samples of
    // differing size so the polyline has actual shape: a flat ring maps every
    // point to one y and draws a single thin line.
    await app.evaluate(({}, samples) => {
        const fixture = (globalThis as Record<string, unknown>).__GENIE_E2E_PULSE__ as
            | { emit: (bytes: number, active: boolean) => void }
            | undefined;
        if (!fixture) throw new Error('__GENIE_E2E_PULSE__ missing — seed did not run');
        for (const s of samples) fixture.emit(s, false);
    }, [400, 1200, 300, 2400, 800, 1800, 200, 3000]);

    await expect(page.locator('.agent-pulse-spark')).toBeVisible();
});

test.afterAll(async () => {
    await app?.close();
});

test('the pulse is drawn on an idle row', async () => {
    await ensureCollapsed();
    // Guard 1. Everything below compares against this number, so a sparkline that
    // never painted would make the survival assertion vacuously true.
    expect(await pulsePixels()).toBeGreaterThan(0);
});

test('the counted pixels are the sparkline and nothing else', async () => {
    // Guard 2, and the one that matters most: it proves the METRIC is valid.
    //
    // Expanding the row removes the sparkline and changes nothing else about the
    // row's chrome. If the count does not collapse to nothing, then something
    // else on the row answers to the predicate — as the agent-active workspace
    // name did, in the same `var(--agent)` indigo — and every number here is
    // measuring that instead.
    await ensureCollapsed();
    const withSparkline = await pulsePixels();
    // A signal worth dividing into. If the sparkline only ever contributed a
    // handful of pixels, the ratio below would be noise comparing itself.
    expect(withSparkline).toBeGreaterThan(100);

    try {
        await page.locator('.tproj-head [title="Expand"]').first().click();
        await expect(page.locator('.agent-pulse-spark')).toHaveCount(0);

        // Not exactly zero: a few antialiased pixels on the row's own edges answer
        // to any colour predicate, and Windows reported 7 of them. The claim being
        // made is that the sparkline is where essentially ALL of this colour comes
        // from — so removing it must remove essentially all of the count.
        expect(await pulsePixels()).toBeLessThan(withSparkline * 0.05);
    } finally {
        // Restore, even on failure: leaving the row expanded would strand every
        // later test with no sparkline and report their cause as this one's.
        await ensureCollapsed();
    }
    expect(await pulsePixels()).toBeGreaterThan(withSparkline * 0.5);
});

test('hovering the row paints an opaque fill over it', async () => {
    // Guard 3. The bug was the hover fill covering the pulse; if that fill stops
    // applying there is no hazard left and the survival test proves nothing.
    await head().hover();
    await expect.poll(headBackgroundAlpha).toBe(1);
});

test('the pulse survives the hover — genie#197', async () => {
    await ensureCollapsed();
    await page.mouse.move(0, 0);
    await expect.poll(headBackgroundAlpha).not.toBe(1);
    const idle = await pulsePixels();

    const hovered = await pulsePixelsWhileHovered();

    // Pre-fix this was ~0: the opaque fill painted straight over the sparkline.
    // Not asserting equality — the fill changes what the semi-transparent pulse
    // composites against, so individual pixels legitimately shift. What must not
    // happen is the pulse DISAPPEARING.
    expect(hovered).toBeGreaterThan(idle * 0.5);
});

test('the pulse is painted by the hovered element itself, not behind it', async () => {
    await ensureCollapsed();
    // The structural invariant behind the fix, pinned so a refactor that moves the
    // sparkline back OUT of the head reads as the regression it is — and so the
    // suite says WHY the pixels survive, not just that they do.
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
