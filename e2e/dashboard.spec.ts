import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * THE WORKFLOW DASHBOARD, RENDERED IN A REAL WINDOW.
 *
 * `dashboard-view.ts` has 25 unit tests and they cover the decisions. What a unit test cannot
 * cover is whether a decision SURVIVES being rendered:
 *
 *  - that an Observed agent's context cell is genuinely **absent from the DOM**, not merely
 *    `null` in a projection that a component might still draw a box for;
 *  - that a declared agent below the context threshold draws **nothing**, not a `0`;
 *  - that the order a human reads is the order the comparator produced.
 *
 * This repository's own history is five defects past two thousand green unit tests, so "the
 * projection is right" and "the screen is right" are separate claims and this file is the
 * second one.
 *
 * The fixture (`renderer/pages/e2e-dashboard.tsx`) lists its agents in the OPPOSITE order to
 * the expected output, so the ordering assertion below cannot pass on the fixture's own layout.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('dashboard'));
});

test.afterAll(async () => {
    await app?.close();
});

/** The agent names in render order, read out of the rows themselves. */
const names = () =>
    page.locator('.dash-row:not(.dash-col-head) .dash-name').allTextContents();

test('the board renders, grouped by workspace', async () => {
    await expect(page.locator('.dashboard')).toBeVisible();
    await expect(page.locator('.dash-group-name')).toHaveText('tynn');
    // Six agents, which is also the control for every assertion below: a selector that
    // matched nothing would make them all vacuously true.
    expect((await names()).length).toBe(6);
});

test('rows that need a human come FIRST — waiting, broken, working, idle', async () => {
    // The board's order. The fixture is deliberately in the reverse, so this is asserting the
    // comparator rather than the fixture.
    expect(await names()).toEqual(['wren', 'tern', 'atlas', 'quill', 'moth', 'sable']);
});

test('an OBSERVED agent reads Quiet, not Idle — a measurement, not a claim', async () => {
    // "Working"/"Idle" state the agent's own position, which only a declaring agent can do.
    // Genie is watching a pty and inferring motion, and the words say so.
    const row = page.locator('.dash-row[data-fidelity="observed"]');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.dash-name')).toHaveText('moth');
    await expect(row.locator('.dash-status-word')).toHaveText('Quiet');
    // And it says WHY it is thinner, at the one place a reader asks.
    await expect(row.locator('.dash-prov')).toContainText('pty');
});

test('an Observed agent has NO context cell at all — absence, not an empty one', async () => {
    /**
     * §6.3 rather than §6.1. The cell is not drawn, because an Observed agent reports no usage
     * and never will — an empty cell would promise a reading it cannot give.
     *
     * Asserted on the DOM because this is exactly the kind of rule a component can get wrong
     * while the projection is right: `showsContextCell` is a separate field from `context`
     * precisely so the two cannot be conflated, and this is the check that they are not.
     */
    const row = page.locator('.dash-row[data-fidelity="observed"]');
    await expect(row.locator('.dash-ctx-bar')).toHaveCount(0);
    await expect(row.locator('.dash-ctx-label')).toHaveCount(0);
});

test('context is drawn only near compaction — and NEVER as a zero', async () => {
    // `atlas` sits at 40k of 200k: the cell exists and holds nothing. A column of comfortable
    // figures trains people to stop reading the one that matters.
    const atlas = page.locator('.dash-row', { has: page.locator('.dash-name', { hasText: 'atlas' }) });
    await expect(atlas.locator('.dash-ctx-label')).toHaveCount(0);

    // `quill` sits at 182k: label and bar appear, and the level is critical rather than warn.
    const quill = page.locator('.dash-row', { has: page.locator('.dash-name', { hasText: 'quill' }) });
    await expect(quill.locator('.dash-ctx-label')).toHaveText('182k');
    await expect(quill.locator('.dash-ctx-bar')).toHaveAttribute('data-level', 'critical');

    // THE ASSERTION THAT MATTERS MOST: nowhere on this board is a context figure of zero.
    // A confident zero about someone's context is the single most expensive mistake this UI
    // can make, and it has been made before.
    const labels = await page.locator('.dash-ctx-label').allTextContents();
    expect(labels).not.toContain('0k');
    expect(labels).not.toContain('0');
});

test('a WAITING row carries the question itself, and KEEPS its last delivery', async () => {
    /**
     * Two board rules in one row. The question is the status detail — not "1 question", because
     * a row you must open defeats a board you read. And the delivery is NOT replaced by it: a
     * question is not a delivery, and overwriting it would destroy the one piece of history
     * this surface exists to preserve.
     */
    const wren = page.locator('.dash-row', { has: page.locator('.dash-name', { hasText: 'wren' }) });
    await expect(wren.locator('.dash-status-word')).toHaveText('Waiting on you');
    await expect(wren.locator('.dash-status-detail')).toContainText('php artisan migrate');
    await expect(wren.locator('.dash-del-main')).toHaveText('sessions.php');
});

test('a BROKEN row shows the reason and loses its target entirely', async () => {
    // A stale target beside a dead agent reads as current work, which is the one thing the
    // cell must not imply. The fixture gives `tern` an in-progress plan step on purpose, so
    // this fails if the row renders it.
    const tern = page.locator('.dash-row', { has: page.locator('.dash-name', { hasText: 'tern' }) });
    await expect(tern.locator('.dash-status-word')).toHaveText('Broken');
    await expect(tern.locator('.dash-status-detail')).toContainText('sign-in expired');
    await expect(tern.locator('.dash-target-text')).toHaveCount(0);
    await expect(tern.locator('.dash-step')).toHaveCount(0);
});

test('latest delivery names the FILE, which the model could not do before', async () => {
    // `ToolCall.rawInput` (genie#843) is what makes this possible at all. Before it, the best
    // this cell could say was "Write".
    const atlas = page.locator('.dash-row', { has: page.locator('.dash-name', { hasText: 'atlas' }) });
    await expect(atlas.locator('.dash-del-main')).toHaveText('ChallengeStore.php');
    // And the current target is the agent's own in-progress plan step, with its position.
    await expect(atlas.locator('.dash-target-text')).toHaveText('Passkey enrolment endpoint');
    await expect(atlas.locator('.dash-step')).toHaveText('2/3');
});

test('the header strip is SILENT about states that are not happening', async () => {
    // §6.2: a strip that always reads "0 broken" trains people to stop reading it. Every
    // figure here is non-zero, and no figure appears for a state with no agents in it.
    const figures = await page.locator('.dash-figure').allTextContents();
    expect(figures.join(' ')).toContain('1 waiting on you');
    expect(figures.join(' ')).toContain('1 broken');
    for (const text of figures) {
        expect(text).not.toMatch(/\b0\s/);
    }
});

test('no collaborator count is shown, because none can be attributed yet', async () => {
    /**
     * The honest render of a designed feature whose data is not reachable: `whisper_messages`
     * keys on the terminal's own id rather than `workspace_agents.id`, and that join breaks for
     * a dormant agent. So the cell is EMPTY.
     *
     * Asserted rather than left implicit, because the failure mode here is a `0` — which would
     * claim every agent works alone. If the `inbox_agent_id` column lands and this goes red,
     * that is the fix arriving and this test should then assert the real counts.
     */
    await expect(page.locator('.dash-comms-count')).toHaveCount(0);
});
