import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * THE STREAM AND ITS INSPECTOR, IN A REAL WINDOW.
 *
 * The Stream's central claim is STRUCTURAL, and therefore invisible to the 19 unit tests that
 * cover its projection:
 *
 *  - an EVENT row is exactly one line **whatever arrives**;
 *  - opening a row fills the Inspector and **the rows above it do not move**.
 *
 * The second is a layout fact. `agent-stream.ts` flattens the text — a unit test asserts that —
 * but nothing in a projection can show that the rendered rows hold still, and "the rows hold
 * still" is the entire reason an event row is made unable to grow. A stylesheet one careless
 * override away from losing `nowrap` would pass every unit test in that file.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('stream'));
});

test.afterAll(async () => {
    await app?.close();
});

test('the stream renders every row shape', async () => {
    await expect(page.locator('.agent-stream')).toBeVisible();
    // The control for everything below: a selector matching nothing would make the
    // assertions vacuous. Four tools + two settled thoughts + one live thought = 7 events.
    await expect(page.locator('.stream-event')).toHaveCount(7);
    await expect(page.locator('.stream-speech')).toHaveCount(3);
});

test('a MULTI-LINE thought still occupies ONE line on screen', async () => {
    /**
     * The fixture's first thought contains two newlines and a blank line. The projection
     * flattens it; this asserts the RENDERED row is one line high, which is the claim a unit
     * test cannot make.
     *
     * Measured against the row's own computed line-height rather than a magic number, so a
     * deliberate change to the type scale does not fail this for the wrong reason — the claim
     * is "one line", not "22 pixels".
     */
    const row = page.locator('.stream-event[data-kind="think"]').first();
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    expect(box).not.toBeNull();

    const lineHeight = await row.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 0);
    // One line of text plus the row's own padding — comfortably under two lines of it.
    expect(box!.height).toBeLessThan(lineHeight * 2);

    // And the text really was flattened: no newline survived into the DOM.
    const text = (await row.textContent()) ?? '';
    expect(text).not.toContain('\n');
    expect(text).toContain('No sign-count column. Either add a migration');
});

test('a LIVE thought shows that it is thinking and NEVER what it is thinking', async () => {
    // The fixture's live thought carries a sentinel. If it reaches the screen, the rule that
    // reasoning is withheld until it settles has been lost — and that rule is the only version
    // of "show me the reasoning" that does not reflow the page on every chunk.
    const live = page.locator('.stream-event[data-live]');
    await expect(live).toHaveCount(1);
    await expect(live).toContainText('Thinking');
    await expect(page.locator('.agent-stream')).not.toContainText('SECRETREASONING');
});

test('SPEECH wraps — the one place text is allowed to', async () => {
    // The other half of the rule. Flattening a reply would destroy paragraphs in the one place
    // a human is reading prose, so this row must be TALLER than a single line.
    const speech = page.locator('.stream-speech', { hasText: 'ChallengeStore is committed' });
    const box = await speech.boundingBox();
    const lineHeight = await speech.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 0);
    expect(box!.height).toBeGreaterThan(lineHeight * 1.5);
});

test('another agent is NAMED, not labelled like the owner', async () => {
    // Before authors existed every row read role-only, so a sibling agent's request said
    // "user" exactly like the owner's and became indistinguishable from an instruction from
    // the person in charge. The Stream inherited that distinction and must keep it.
    const peer = page.locator('.stream-speech', { hasText: 'sessions migration needs passkey_id' });
    await expect(peer.locator('.stream-who')).toHaveText('wren');
    const owner = page.locator('.stream-speech', { hasText: 'Keep the controller thin' });
    await expect(owner.locator('.stream-who')).toHaveText('you');
});

test('an edit is tinted and a read is not — the kinds are visibly different', async () => {
    // "What changed" is the question this surface is most often opened to answer, so an edit
    // is the one row kind that carries a background. The kind comes from the AGENT, never from
    // the tool's name — a provider may call its writer anything.
    await expect(page.locator('.stream-event[data-kind="edit"]')).toHaveCount(1);
    const edit = page.locator('.stream-event[data-kind="edit"]');
    await expect(edit).toContainText('ChallengeStore.php');
    const editBg = await edit.evaluate((el) => getComputedStyle(el).backgroundColor);
    const read = page.locator('.stream-event[data-kind="tool"]', { hasText: 'composer.json' });
    const readBg = await read.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(editBg).not.toBe(readBg);
});

test('a failed call is marked, and a RUNNING one is not marked as failed', async () => {
    const failed = page.locator('.stream-event[data-level="bad"]');
    await expect(failed).toHaveCount(1);
    await expect(failed).toContainText('php artisan test');
    // Pending is its own level. Conflating the two would report a working agent as broken.
    await expect(page.locator('.stream-event[data-level="pending"]')).toHaveCount(1);
});

test('OPENING A ROW DOES NOT MOVE THE ROWS ABOVE IT', async () => {
    /**
     * THE ASSERTION THIS WHOLE FILE EXISTS FOR, and the one no unit test can make.
     *
     * Expansion happens in a fixed pane outside the scroller precisely so that selecting a row
     * cannot displace its neighbours. The usual implementation — expanding in place — is what
     * makes agent UIs unreadable, and it would pass every projection test.
     */
    const firstThought = page.locator('.stream-event[data-kind="think"]').first();
    const before = await firstThought.boundingBox();
    expect(before).not.toBeNull();

    // The inspector is absent until something is selected — absence of a control, not an
    // empty pane taking up room for nothing.
    await expect(page.locator('.tool-inspector')).toHaveCount(0);

    await page.locator('.stream-event[data-kind="edit"]').click();
    await expect(page.locator('.tool-inspector')).toBeVisible();

    const after = await firstThought.boundingBox();
    expect(after).not.toBeNull();
    // SAME POSITION, to the pixel.
    expect(after!.y).toBeCloseTo(before!.y, 0);
    expect(after!.height).toBeCloseTo(before!.height, 0);
});

test('the Inspector shows the arguments AND the result', async () => {
    // §5.2's own words. Both were being discarded until genie#843 — the arguments were read
    // only to sniff for plan tools, and the result was never read at all.
    const inspector = page.locator('.tool-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('ChallengeStore.php');
    await expect(inspector).toContainText('File created successfully');
    // And the call's status, because arguments shown without it invite reading them as what
    // succeeded.
    await expect(inspector.locator('.tool-inspector-status')).toHaveText('success');
});

test('a row with nothing behind it is INERT, not a dead control', async () => {
    // Absence of a control rather than a disabled one. A thought has nothing to inspect, so
    // it is not a button — a keyboard user tabbing through must not land on it expecting
    // something to happen.
    const thought = page.locator('.stream-event[data-kind="think"]').first();
    expect(await thought.evaluate((el) => el.tagName)).toBe('DIV');
    const edit = page.locator('.stream-event[data-kind="edit"]');
    expect(await edit.evaluate((el) => el.tagName)).toBe('BUTTON');
});
