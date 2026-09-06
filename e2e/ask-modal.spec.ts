import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * E2E for the ForceTheQuestion modal's layout and its file drawer (Tynn #272).
 *
 * WHY E2E. Three of the four fixes are stylesheet facts, and those are pinned
 * without a browser in `renderer/lib/__tests__/ask-modal-chrome.test.ts`. One is
 * not: "the question content GROWS rather than scrolling" is a claim about
 * LAYOUT — what `scrollHeight` comes to next to `clientHeight` once the text has
 * actually been measured — and no stylesheet assertion can make it. The owner
 * wrote the trap into their own acceptance criteria: *"a long question and a
 * short one both render correctly — 'it grows' passes just as well against a
 * layout that only ever renders one size."* So the fixture raises TWO questions,
 * a long one and a short one, and both are measured in the same window.
 *
 * The window under test is the PRODUCT's. `main/e2e/ask.ts` raises real
 * questions through `forceQuestion`, so `createAskWindow` opens the modal with
 * its navigation guard, its queue and its drawer resize all live. Nothing here
 * mounts a stand-in.
 *
 * genie#196 is the regression this must not reintroduce: a link in the question
 * markdown used to navigate this frameless always-on-top window ITSELF, turning
 * it into a browser tab and stranding the question behind whatever loaded. The
 * file drawer adds a new thing to click, so every click here is followed by a
 * check that the page did not move.
 */

/**
 * Order matters here, and says so. The last test ANSWERS the long question to
 * advance the queue to the short one, so a failure earlier in the file leaves a
 * state the later tests would report against confusingly. Serial stops after the
 * first failure instead of reporting three.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;

const frame = () => page.locator('.ask-frame');
const body = () => page.locator('.ask-body');
const content = () => page.locator('.ask-q-content').first();
const chip = () => page.locator('.ask-file-chip').first();
const pane = () => page.locator('.ask-file-pane');

/** Does this element's own box overflow what it shows? */
async function overflows(locator: ReturnType<typeof page.locator>): Promise<boolean> {
    return locator.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
}

/**
 * Every element inside the question column that can actually be scrolled.
 *
 * Form controls are excluded: a `<textarea>` scrolls its own text by definition
 * and always has, and the complaint in #272 was two nested regions of the
 * QUESTION scrolling against each other.
 */
async function scrollableInColumn(): Promise<string[]> {
    return frame().evaluate((root) =>
        Array.from(root.querySelectorAll<HTMLElement>('*'))
            .filter((el) => !['TEXTAREA', 'INPUT', 'SELECT'].includes(el.tagName))
            .filter((el) => {
                const style = getComputedStyle(el);
                const scrolls = /auto|scroll/.test(style.overflowY + style.overflow);
                return scrolls && el.scrollHeight > el.clientHeight + 1;
            })
            .map((el) =>
                typeof el.className === 'string' && el.className
                    ? el.className
                    : el.tagName.toLowerCase(),
            ),
    );
}

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('ask'));
    await expect(frame()).toBeVisible();
    // The LONG question is raised first, so it is the head.
    await expect(page.locator('.ask-chip')).toHaveText('Long question');
});

test.afterAll(async () => {
    await app?.close();
});

test('a long question grows, and only the body scrolls', async () => {
    // The fixture question is long on purpose. If this is false the rest of the
    // test proves nothing — a question that fits cannot demonstrate growth.
    expect(await overflows(body())).toBe(true);

    // The question body is NOT clipped: it is as tall as its text, and the one
    // scrollbar in the column belongs to `.ask-body` around it. Before #272 this
    // element had `max-height: 40vh; overflow-y: auto` and reported the opposite.
    expect(await overflows(content())).toBe(false);
    await expect(content()).toHaveCSS('max-height', 'none');

    expect(await scrollableInColumn()).toEqual(['ask-body']);
});

test('the modal is the window, with no card inside it', async () => {
    // The frame used to draw its own border, a 20px radius and a drop shadow
    // while filling the whole window — a card inside a card, whose rounded
    // corners left the window's own background showing at every seam.
    await expect(frame()).toHaveCSS('border-top-width', '0px');
    await expect(frame()).toHaveCSS('border-top-left-radius', '0px');
    await expect(frame()).toHaveCSS('box-shadow', 'none');

    // Flush: the column reaches the window's edges with nothing showing around it.
    const flush = await page.evaluate(() => {
        const el = document.querySelector('.ask-frame') as HTMLElement;
        const r = el.getBoundingClientRect();
        return {
            left: Math.round(r.left),
            top: Math.round(r.top),
            right: Math.round(window.innerWidth - r.right),
            bottom: Math.round(window.innerHeight - r.bottom),
        };
    });
    expect(flush).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
});

test('a file path opens the file beside the question, without navigating', async () => {
    const before = page.url();
    const widthBefore = await page.evaluate(() => window.innerWidth);

    await expect(chip()).toBeVisible();
    await expect(chip()).toContainText('spec.md');
    await chip().click();

    await expect(pane()).toBeVisible();
    // The marker lives in §3 of the fixture file and nowhere else, so seeing it
    // means the drawer read the real file rather than echoing the question.
    await expect(pane()).toContainText('Bridges are named after the river they cross.');

    // The window itself grows — main resizes it over IPC, so WAIT for that
    // rather than reading the width straight after a DOM assertion and racing it.
    await page.waitForFunction((w) => window.innerWidth > w, widthBefore);

    // The drawer is BESIDE the question, not over it: the question column is
    // still fully on screen, to the left of the pane.
    const geometry = await page.evaluate(() => {
        const q = document.querySelector('.ask-frame')!.getBoundingClientRect();
        const f = document.querySelector('.ask-file-pane')!.getBoundingClientRect();
        return { qLeft: q.left, qWidth: q.width, qRight: q.right, fLeft: f.left, fWidth: f.width };
    });
    // The question column keeps exactly the width it had — which also catches the
    // one drift this layout can suffer: `.ask-shell.with-file .ask-frame` pins
    // 560px in CSS and `ASK_MODAL_WIDTH` pins it in TS, and the two must agree.
    expect(geometry.qLeft).toBe(0);
    expect(geometry.qWidth).toBe(widthBefore);
    expect(geometry.fLeft).toBeGreaterThanOrEqual(geometry.qRight - 1);
    expect(geometry.fWidth).toBeGreaterThan(100);

    // genie#196: the modal must still be the modal. A click that navigated it
    // would leave the question — and the agent waiting on it — behind.
    expect(page.url()).toBe(before);
    await expect(frame()).toBeVisible();

    // Closing it gives the width back.
    await page.locator('.ask-file-head .ask-x').click();
    await expect(pane()).toHaveCount(0);
    await page.waitForFunction((w) => window.innerWidth === w, widthBefore);
    expect(page.url()).toBe(before);
});

test('a short question renders correctly too', async () => {
    // Advance the queue to the SHORT question through the real UI. Without this
    // half of the suite, "the body grows" is a claim about one fixture: a layout
    // that only ever renders one size passes the long case just as well.
    await page.locator('.ask-foot').getByText('Cancel').click();
    await expect(page.locator('.ask-chip')).toHaveText('Short question');

    // Nothing overflows: no scrollbar anywhere in the column, and the question
    // is on screen in full.
    expect(await overflows(content())).toBe(false);
    expect(await overflows(body())).toBe(false);
    expect(await scrollableInColumn()).toEqual([]);
    await expect(content()).toContainText('One line, nothing more.');

    // The options and the submit are reachable, which is the whole job of the
    // window — a "grows" fix that pushed the footer off the bottom would be a
    // worse bug than the one it replaced.
    await expect(page.locator('.ask-opt').first()).toBeVisible();
    await expect(page.locator('.ask-foot')).toBeVisible();
});
