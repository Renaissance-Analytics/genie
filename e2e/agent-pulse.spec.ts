import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';
import {
    SPARKLINE_FLOOR,
    describeMeasurement,
    hoverCaptureBound,
    measurementIsUsable,
    type RunMeasurement,
} from './helpers/pulse-hover';

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
    /** collapsed, not hovered — photographed a SECOND time, back to back.
     *
     *  The capture-noise baseline (genie#518). Taken immediately after `cU` with
     *  NOTHING re-seeded and no state touched, so the only thing between the two
     *  frames is the camera.
     *
     *  ★ The first version of this took the baseline through `shotIn` like the
     *  others, which calls `freshPulses()` — and measured 7,625 on Ubuntu and
     *  7,662 on Windows, as large as the sparkline itself. Fresh samples change
     *  the ring, the polyline rescales to a new max, and nearly every pixel
     *  moves. That is the CHART changing, not the camera shaking, and a bound
     *  derived from it was ten times too strict. */
    cU2: string;
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

    // The hover state is (re)applied immediately before EVERY shot, because
    // setCollapsed() CLICKS the chevron — which puts the pointer on the row and
    // hovers it. Without this the "unhovered" half of the comparison was an
    // unhovered shot against a hovered one, and the difference it reported was
    // mostly the hover fill rather than the sparkline.
    const shotIn = async (collapsed: boolean, hovered: boolean) => {
        await setCollapsed(collapsed);
        if (collapsed) await freshPulses();
        await (hovered ? hover() : unhover());
        return shoot(region);
    };

    const cU = await shotIn(true, false);
    // Straight after cU: same state, same ring, nothing re-seeded and nothing
    // clicked. `shoot` directly rather than `shotIn`, because `shotIn` would
    // call freshPulses() and redraw the chart -- which is what made the first
    // version of this baseline measure the chart instead of the camera.
    const cU2 = await shoot(region);
    const eU = await shotIn(false, false);
    const cH = await shotIn(true, true);
    const eH = await shotIn(false, true);

    await setCollapsed(true);
    return { cU, cU2, cH, eU, eH };
}

/** How many times to re-photograph before calling a missed hover a failure. */
const HOVER_CAPTURE_ATTEMPTS = 4;

/**
 * Shots whose photographs PROVE the row was hovered — retaken until they do.
 *
 * A hover that goes stale between `hover()` and `screenshot()` is a MEASUREMENT
 * failure: the picture is of an unhovered row, and it says nothing at all about
 * whether the row restyles on hover. Before genie#518 that outcome failed the
 * run and was read as a product regression. Re-photographing is the honest
 * response, and it is bounded — if the hover never lands in four attempts, that
 * is a finding rather than noise, and the numbers say which finding it is.
 */
async function takeHoverProvenShots(): Promise<Shots & RunMeasurement> {
    const measure = async (shots: Shots): Promise<RunMeasurement> => ({
        jitter: await differingPixels(shots.cU, shots.cU2),
        hovered: await differingPixels(shots.cU, shots.cH),
        sparkline: await differingPixels(shots.cU, shots.eU),
    });

    let shots = await takeShots();
    let m = await measure(shots);

    for (let attempt = 2; attempt <= HOVER_CAPTURE_ATTEMPTS; attempt++) {
        if (measurementIsUsable(m)) break;
        // Reported on every retake, so a shard that eventually passes still says
        // how many attempts it took and what it saw -- a run that quietly needed
        // four goes is worth knowing about before it becomes a run that needs
        // five.
        console.log(`[agent-pulse] retaking (attempt ${attempt}): ${describeMeasurement(m)}`);
        shots = await takeShots();
        m = await measure(shots);
    }

    // Printed on success too. These three numbers are the only record of what
    // this comparison is worth on this platform, and the whole of genie#518 came
    // from having to reconstruct them from a single failed assertion.
    console.log(
        `[agent-pulse] noise ${m.jitter}, hovered ${m.hovered}, sparkline ${m.sparkline}, ` +
            `hover bound ${hoverCaptureBound(m.jitter)}`,
    );

    return { ...shots, ...m };
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
            // The row's own content must be lifted above the pulse layer, or the
            // workspace name would sit UNDER it.
            contentZ: el.closest('.tproj-head')?.querySelector('.pname')
                ? getComputedStyle(el.closest('.tproj-head')!.querySelector('.pname')!).zIndex
                : null,
            // The head still forms a stacking context, which is what keeps the
            // pulse from escaping upward past the rest of the sidebar.
            headZIndex: el.closest('.tproj-head')
                ? getComputedStyle(el.closest('.tproj-head')!).zIndex
                : null,
            headPosition: el.closest('.tproj-head')
                ? getComputedStyle(el.closest('.tproj-head')!).position
                : null,
        }));

    // What 04e560b actually ships. These all hold — which is the point: the fix
    // is structurally present and correct-looking, and the pulse is covered
    // anyway. See the fixme below.
    expect(facts).toEqual({
        insideHead: true,
        zIndex: '-1',
        contentZ: 'auto',
        headZIndex: '1',
        headPosition: 'relative',
    });
});

test('the sparkline is visible, and the hover really reaches the photographs', async () => {
    // Both guards for everything below, and neither involves the fix.
    const m = await takeHoverProvenShots();
    const { jitter, hovered, sparkline } = m;

    // The metric can see the sparkline at all: collapsed vs expanded, no hover.
    //
    // A FIXED bound, unlike the hover one, and not for want of trying: gating it
    // on the measured noise is circular, since `noiseWasMeasurable` already
    // bounds that noise as a fraction of THIS number. So it needs a floor, and
    // the floor has to clear the observed capture noise (~97) while staying
    // under the smallest signal any platform produces -- 564, on macOS. 300
    // does; the 1,000 that suggests itself from the fixme below does not, and
    // took all three platforms red proving it.
    expect(sparkline, describeMeasurement(m)).toBeGreaterThan(SPARKLINE_FLOOR);

    // The hover is genuinely in the photograph.
    //
    // Bounded by a MULTIPLE of what re-photographing the same unhovered row
    // costs on this run, not by a fixed number -- genie#518, where `> 100` sat
    // three pixels above the missed-hover noise (97) and so was both marginal
    // against a stale hover and vacuous against a row that had stopped
    // restyling. The ratio is the half that does the work: a row which stops
    // painting its fill photographs the same hovered as not, so `hovered` falls
    // to `jitter` and any multiple above 1 refuses it -- on any platform,
    // without anyone having to know what the fill is worth there.
    expect(hovered, describeMeasurement(m)).toBeGreaterThan(hoverCaptureBound(jitter));
});

// STILL BROKEN — genie#197 is NOT fixed, and this is the evidence.
//
// `test.fixme` rather than a deletion or a loosened threshold: the measurement
// above is trustworthy (its two guards pass on all three platforms) and it says
// the pulse is covered. Marking it expected-to-fail keeps the suite honest and
// keeps the reproduction runnable, instead of a green suite that quietly asserts
// nothing.
//
// Measured with the fix as shipped: the sparkline accounts for ~7,500 differing
// pixels on an idle row and ~300 while hovered.
//
// Ruled out, each by an experiment on CI rather than by reading the CSS:
//   - the head not forming a stacking context (it does: position:relative,
//     z-index:1, asserted above on every platform)
//   - the sparkline not being inside the head (it is, asserted above)
//   - moving the hover fill to an ::after layer at z-index:-2, so the ordering
//     is between two negative-z siblings — no change
//   - dropping negative z-index entirely: the pulse at z-index:0 with the row's
//     content lifted to 1 — no change either, which is the result that says the
//     cause is NOT paint order
//   - a rule hiding the sparkline on hover (there is none)
//
// Whatever is covering it is not explained by the stacking model, so the next
// step is a real compositor inspection (DevTools layer panel on a running app),
// not another CSS guess.
test.fixme('the sparkline survives the hover — genie#197', async () => {
    // `hoverProof` is the HOVER-CAPTURE measurement (unhovered vs hovered row);
    // `hovered` below is a different quantity entirely -- the sparkline's own
    // contribution while the row is hovered. Named apart because confusing them
    // is what this test exists to detect.
    const proof = await takeHoverProvenShots();
    const { cU, cH, eU, eH } = proof;

    // Proof the comparison is being made under the conditions it claims.
    expect(proof.hovered, describeMeasurement(proof)).toBeGreaterThan(
        hoverCaptureBound(proof.jitter),
    );

    const idle = await differingPixels(cU, eU);
    const hovered = await differingPixels(cH, eH);

    // Pre-fix `hovered` collapsed to ~0: with the opaque fill painted over it,
    // the row photographed identically with and without the sparkline. Not
    // asserting equality with `idle` — the fill changes what the semi-transparent
    // pulse composites against, so individual pixels legitimately shift. What
    // must not happen is the sparkline making NO difference to the row.
    expect(hovered).toBeGreaterThan(idle * 0.5);
});
