import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E, readTynnImportSeed, type TynnImportSeed } from './helpers/launch';

/**
 * IMPORTING A TYNN PROJECT THAT IS ALREADY AN ENVELOPE (genie#355).
 *
 * The owner set a new machine up, chose their Tynn project, and was made to pick
 * a repo, clone it, and then walk the whole scan-and-upgrade-to-`.agi` wizard —
 * for a project that was already a workspace, backed by a repo that was already
 * an envelope. The wizard had nothing to do. One unconditional
 * `setStage('agi-interactive')` in AddWorkspaceModal sent every Tynn import
 * there.
 *
 * WHY E2E, when the routing is unit-tested. The decision itself is a pure
 * function, asserted directly in renderer/lib/__tests__/tynn-import.test.ts. What
 * no unit test can answer is whether the modal READS that decision — the defect
 * was never in a rule, it was in a component going somewhere else. This drives
 * the real modal over the real IPC and looks at which screen appears.
 *
 * THE POSITIVE CONTROL IS THE FIRST TEST, deliberately: "the upgrade wizard did
 * not open" is satisfied just as well by an import that does nothing at all, so
 * the wizard is proven REACHABLE from this very picker before the envelope case
 * is allowed to claim it stayed away.
 *
 * Only the network is stood in for (see main/e2e/tynn-import.ts): the Tynn
 * project list, and the git clone — which materialises a real envelope on disk
 * instead of fetching one. The workspace that lands is registered by the REAL
 * `workspaces:add` into the real database, which is what the assertions read.
 */

let app: ElectronApplication;
let page: Page;
let seed: TynnImportSeed;

// One modal, walked in order: the control leaves the wizard open, and the
// envelope test cancels back out of it to prove the SAME picker routes elsewhere.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('tynn-import'));
    const found = await readTynnImportSeed(app);
    expect(
        found,
        'the tynn-import fixture should have seeded before the window loaded',
    ).not.toBeNull();
    seed = found!;
});

test.afterAll(async () => {
    await app?.close();
});

const WIZARD = /Upgrade to \.agi envelope/;

/** Add workspace → Import from Tynn → choose one of the fixture projects. */
async function chooseProject(label: string | RegExp): Promise<void> {
    // The source card. At this stage nothing else carries that heading; the
    // step it opens has one of its own, which is why this runs first.
    await page.getByRole('heading', { name: 'Import from Tynn', exact: true }).click();
    // react-fancy's Select is a combobox, not a native <select>.
    await page.locator('[data-react-fancy-select]').click();
    await page.getByRole('option', { name: label }).click();
}

test('a project with no envelope still reaches the upgrade wizard', async () => {
    await chooseProject('Plain Product');

    await page.getByRole('button', { name: 'Inspect workspace' }).click();

    await expect(
        page.getByRole('heading', { name: WIZARD }),
        'the scan-and-convert wizard must still be reachable — without this, the ' +
            'envelope assertion below would pass against an import that goes nowhere',
    ).toBeVisible();
});

test('an envelope-backed project never opens the wizard — it only asks where to put it', async () => {
    // Back to the picker from the wizard the control just opened.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: WIZARD })).toHaveCount(0);

    await chooseProject('Enveloped Product');
    // Its button says what happens next, and it is not "inspect".
    await page.getByRole('button', { name: 'Choose location' }).click();

    // ONE question, and it is where.
    await expect(
        page.getByRole('heading', { name: /Where should Enveloped Product live/ }),
    ).toBeVisible();
    await expect(
        page.getByRole('heading', { name: WIZARD }),
        'genie#355: an already-enveloped project was sent through the conversion wizard',
    ).toHaveCount(0);

    // The destination is pre-filled from the primary workspace folder, so the
    // single question is already answered and the import can proceed.
    await page.getByRole('button', { name: 'Clone & add workspace' }).click();

    // A workspace REALLY landed — through the real `workspaces:add` — at the
    // path the envelope was cloned to, linked to the Tynn project.
    const added = page.locator('[data-testid="workspace-added"]');
    await expect(added).toBeVisible({ timeout: 30_000 });
    await expect(added).toHaveAttribute('data-project', seed.envelopeProjectId);
    await expect(added).toHaveAttribute('data-path', seed.expectedPath);
});

test('the envelope it cloned is on disk, with its repos folder', async () => {
    // The clone is what makes the workspace usable; a registered row pointing at
    // nothing would satisfy every DOM assertion above.
    const present = await app.evaluate(async (_electron, dir) => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        return {
            envelope: fs.existsSync(path.join(dir, 'project.json')),
            repos: fs.existsSync(path.join(dir, 'repos')),
        };
    }, seed.expectedPath);

    expect(present).toEqual({ envelope: true, repos: true });
});
