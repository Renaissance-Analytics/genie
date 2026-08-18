import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * E2E test for the AgentPulse sparkline surviving a row HOVER (genie#197).
 *
 * THE BUG: hovering a collapsed workspace row that had an active agent made the
 * activity sparkline vanish; it came back on mouse-out. `.tproj-head` carries a
 * TRANSPARENT background that becomes an OPAQUE `var(--bg-2)` on `:hover`
 * (master.css:1919), and the sparkline was a SIBLING painted behind the head at
 * `z-index:0` — so the hover fill painted straight over it.
 *
 * WHY E2E: this is a question about PAINT ORDER, and nothing short of a real
 * compositor can answer it. The unit suite runs in Node with no DOM, and jsdom
 * would not help — it has no layout and no painting, so a completely covered
 * element still reports itself present and "visible". Playwright's `toBeVisible()`
 * is no better: it checks CSS visibility and box size, neither of which changes
 * when something paints on top. `elementFromPoint` cannot see it either, because
 * the sparkline sets `pointer-events:none` by design.
 *
 * HOW IT MEASURES — a DIFFERENTIAL, not a colour count. Counting "indigo pixels"
 * was tried first and is not sound: the row's own chrome answers to any colour
 * predicate (agent-active paints the workspace NAME in the same `var(--agent)`),
 * antialiasing contributes a tail, and the totals swing between platforms and
 * themes, so every threshold becomes a guess.
 *
 * Instead the row is photographed in two states that differ by EXACTLY one
 * thing — the sparkline, which renders only while the row is collapsed — and the
 * two photographs are compared:
 *
 *     collapsed (sparkline present)  vs  expanded (sparkline absent)
 *
 * Everything else in the head is identical between them: same name, same colours,
 * same geometry. So a substantial number of differing pixels means the sparkline
 * is VISIBLE, and near-zero means it is not being painted where it should be.
 * Run that comparison while the row is HOVERED and it answers #197 exactly:
 * pre-fix the hover fill covered the sparkline, both photographs came out the
 * same, and the difference collapsed to nothing.
 *
 * The chevron is excluded from the comparison because it rotates between the two
 * states (`.tproj.collapsed .chev { transform: rotate(-90deg) }`) and so differs
 * in the broken and the fixed layout alike.
 *
 * The ring fills through the REAL `agent-pulse` broadcast from main, so a channel
 * drift between emit and listen fails this spec rather than dying silently.
 */

let app: ElectronApplication;
let page: Page;

const head = () => page.locator('.tproj-head').first();
const spark = () => page.locator('.agent-pulse-spark');

interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The chevron's title names the ACTION, not the state: an EXPANDED row offers
 *  "Collapse". So the button's absence is how you know you are already there. */
async function setCollapsed(collapsed: boolean): Promise<void> {
    const button = page.locator(`.tproj-head [title="${collapsed ? 'Collapse' : 'Expand'}"]`).first();
    if (await button.count()) await button.click();
    if (collapsed) await expect(spark()).toBeVisible();
    else await expect(spark()).toHaveCount(0);
}

/**
 * The head's box minus the chevron — the region the two states must agree on.
 * Returned in CSS pixels for `page.screenshot({ clip })`, which does not scroll
 * and so cannot move the row out from under the mouse mid-measurement the way
 * `locator.screenshot()`'s scrollIntoViewIfNeeded can.
 */
async function comparisonRegion(): Promise<Region> {
    const box = await head().boundingBox();
    if (!box) throw new Error('row has no box');
    const chev = await page.locator('.tproj-head .chev').first().boundingBox();
    const left = chev ? Math.max(box.x, chev.x + chev.width + 2) : box.x;
    const width = box.x + box.width - left;
    if (width < 20) throw new Error(`comparison region too narrow: ${width}`);
    return { x: left, y: box.y, width, height: box.height };
}

async function shoot(region: Region): Promise<string> {
    return (await page.screenshot({ clip: region })).toString('base64');
}

/** How many pixels differ between two same-size shots, past a tolerance that
 *  ignores subpixel noise. Decoding uses the page's OWN image decoder rather than
 *  a Node PNG library: `pngjs`/`sharp` are present only transitively via
 *  Playwright, so importing one would leave this spec breaking on an unrelated
 *  lockfile change. */
async function differingPixels(a: string, b: string): Promise<number> {
    return page.evaluate(
        async ([aUrl, bUrl]) => {
            const load = async (src: string) => {
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = src;
                });
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('no 2d context');
                ctx.drawImage(img, 0, 0);
                return ctx.getImageData(0, 0, canvas.width, canvas.height);
            };
            const A = await load(aUrl);
            const B = await load(bUrl);
            if (A.width !== B.width || A.height !== B.height) {
                throw new Error(`size drift: ${A.width}x${A.height} vs ${B.width}x${B.height}`);
            }
            let n = 0;
            for (let i = 0; i < A.data.length; i += 4) {
                const d =
                    Math.abs(A.data[i]! - B.data[i]!) +
                    Math.abs(A.data[i + 1]! - B.data[i + 1]!) +
                    Math.abs(A.data[i + 2]! - B.data[i + 2]!);
                if (d > 12) n++;
            }
            return n;
        },
        [`data:image/png;base64,${a}`, `data:image/png;base64,${b}`] as const,
    );
}

/** Alpha of the strongest background the row paints — 1 once the hover fill
 *  applies. Reads the head AND its `::after`, because which layer carries the
 *  fill is an implementation detail this spec should not pin: the question being
 *  asked is "is the row painting an opaque fill?", and that did not change when
 *  the fix moved the fill from one to the other. */
async function headBackgroundAlpha(): Promise<number> {
    return head().evaluate((el) => {
        const alphaOf = (bg: string) => {
            const m = /rgba?\(([^)]+)\)/.exec(bg);
            if (!m) return 0;
            const parts = m[1]!.split(',').map((s) => parseFloat(s));
            return parts.length < 4 ? 1 : parts[3]!;
        };
        return Math.max(
            alphaOf(getComputedStyle(el).backgroundColor),
            alphaOf(getComputedStyle(el, '::after').backgroundColor),
        );
    });
}

/**
 * Take all four photographs in one pass: the row collapsed and expanded, each
 * hovered and not.
 *
 * Reading `:hover` back out of computed style and trusting it across a
 * screenshot did not work — the row re-renders about once a second as the ring
 * shifts, and the hover reliably went stale somewhere around the capture
 * (Windows first showed it: alpha 1 before a screenshot, a fading 0.224 after).
 *
 * So nothing here trusts a style read. The photographs themselves say whether
 * the hover was captured: an unhovered and a hovered shot of the SAME row differ
 * by the whole opaque fill, which is thousands of pixels. `hoverCaptured` below
 * asserts exactly that, which makes a missed hover impossible to mistake for a
 * covered sparkline.
 */
interface Shots {
    /** collapsed, not hovered */
    cU: string;
    /** collapsed, hovered */
    cH: string;
    /** expanded, not hovered */
    eU: string;
    /** expanded, hovered */
    eH: string;
}

/** Top the ring up.
 *
 * The sparkline is a LIVE 60-second window, not a static chart: the ring shifts
 * once a second (`ring.shift(); ring.push(0)` in Chooser), so a burst written in
 * one go scrolls out after sixty of them and the component then renders nothing
 * at all. A spec that ran past that window measured an empty row and read it as a
 * covered sparkline — which is exactly what happened, and cost several runs. Real
 * activity keeps arriving, so the test keeps it arriving too. */
async function freshPulses(): Promise<void> {
    await app.evaluate(({}, samples) => {
        const fixture = (globalThis as Record<string, unknown>).__GENIE_E2E_PULSE__ as
            | { emit: (bytes: number, active: boolean) => void }
            | undefined;
        if (!fixture) throw new Error('__GENIE_E2E_PULSE__ missing — seed did not run');
        for (const s of samples) fixture.emit(s, false);
    }, [400, 1200, 300, 2400, 800, 1800, 200, 3000]);
    await expect(spark()).toBeVisible();
}

async function takeShots(): Promise<Shots> {
    const hover = async () => {
        // hover(), not mouse.move() to the same point: on Windows the raw move
        // did not register as a hover at all.
        await head().hover();
        await expect.poll(headBackgroundAlpha).toBe(1);
    };
    const unhover = async () => {
        await page.mouse.move(0, 0);
        await expect.poll(headBackgroundAlpha).not.toBe(1);
    };

    await setCollapsed(true);
    await freshPulses();
    const region = await comparisonRegion();

    // Each COMPARED pair is photographed back to back, so the two shots being
    // subtracted are taken under the same conditions a second apart rather than
    // at opposite ends of the sequence.
    await unhover();
    const cU = await shoot(region);
    await setCollapsed(false);
    const eU = await shoot(region);

    await setCollapsed(true);
    await freshPulses();
    await hover();
    const cH = await shoot(region);
    await setCollapsed(false);
    const eH = await shoot(region);

    await setCollapsed(true);
    return { cU, cH, eU, eH };
}

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('agent-pulse'));
    await expect(head()).toBeVisible();
    // Collapse by clicking directly rather than via setCollapsed(): the ring is
    // still empty at this point, so there is no sparkline yet to wait for — the
    // component renders nothing until some bytes have arrived.
    await page.locator('.tproj-head [title="Collapse"]').first().click();

    // Fill the ring through the REAL broadcast, with `active: false`. The ring
    // fills from `bytes` either way, and an agent-active row runs a breathing
    // box-shadow animation — which would differ between two photographs taken a
    // moment apart and show up as sparkline pixels that are not the sparkline.
    // Samples of differing size so the polyline has actual shape: a flat ring maps
    // every point to one y and draws a single thin line.
    await app.evaluate(({}, samples) => {
        const fixture = (globalThis as Record<string, unknown>).__GENIE_E2E_PULSE__ as
            | { emit: (bytes: number, active: boolean) => void }
            | undefined;
        if (!fixture) throw new Error('__GENIE_E2E_PULSE__ missing — seed did not run');
        for (const s of samples) fixture.emit(s, false);
    }, [400, 1200, 300, 2400, 800, 1800, 200, 3000]);

    await expect(spark()).toBeVisible();
});

test.afterAll(async () => {
    await app?.close();
});

test('the sparkline is painted by the hovered element itself, not behind it', async () => {
    // FIRST, and deliberately: this reports the structural facts the pixel tests
    // depend on, before any collapse/expand toggling can fail and hide them. If
    // this is red, the pixel numbers below are explained by it and nothing else.
    const facts = await spark()
        .first()
        .evaluate((el) => ({
            insideHead: Boolean(el.closest('.tproj-head')),
            zIndex: getComputedStyle(el).zIndex,
            // The fix relies on the head forming a STACKING CONTEXT: only then
            // does a z-index:-1 child paint above the head's own background
            // instead of dropping behind the whole row.
            headZIndex: el.closest('.tproj-head')
                ? getComputedStyle(el.closest('.tproj-head')!).zIndex
                : null,
            headPosition: el.closest('.tproj-head')
                ? getComputedStyle(el.closest('.tproj-head')!).position
                : null,
        }));

    expect(facts).toEqual({
        insideHead: true,
        zIndex: '-1',
        headZIndex: '1',
        headPosition: 'relative',
    });
});

test('the sparkline is visible, and the hover really reaches the photographs', async () => {
    // Both guards for everything below, and neither involves the fix.
    const { cU, cH, eU } = await takeShots();

    // The metric can see the sparkline at all: collapsed vs expanded, no hover.
    expect(await differingPixels(cU, eU)).toBeGreaterThan(100);

    // The hover is genuinely in the photograph: the opaque fill repaints the
    // whole row, so this is thousands of pixels. Without it, a hover that never
    // landed would look exactly like a sparkline that survived one.
    expect(await differingPixels(cU, cH)).toBeGreaterThan(100);
});

test('the sparkline survives the hover — genie#197', async () => {
    const { cU, cH, eU, eH } = await takeShots();

    // Proof the comparison is being made under the conditions it claims.
    expect(await differingPixels(cU, cH)).toBeGreaterThan(100);

    const idle = await differingPixels(cU, eU);
    const hovered = await differingPixels(cH, eH);

    // Pre-fix `hovered` collapsed to ~0: with the opaque fill painted over it,
    // the row photographed identically with and without the sparkline. Not
    // asserting equality with `idle` — the fill changes what the semi-transparent
    // pulse composites against, so individual pixels legitimately shift. What
    // must not happen is the sparkline making NO difference to the row.
    expect(hovered).toBeGreaterThan(idle * 0.5);
});
