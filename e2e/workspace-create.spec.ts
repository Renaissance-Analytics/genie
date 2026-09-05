import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
    launchGenieE2E,
    readWorkspaceCreateSeed,
    type WorkspaceCreateSeed,
} from './helpers/launch';

/**
 * CREATING AN EMPTY WORKSPACE (genie#431).
 *
 * The owner: "I need to be able to create new empty Workspaces withotu having to
 * fucking convert anything into a .agi. It keeps forcing me to use the old
 * interactive wizard." Add workspace → New workspace opened the
 * inspect-and-convert wizard and asked which existing folder to upgrade. There
 * is no such folder when you are starting from nothing, so the empty case had
 * nowhere to go: every route demanded something that already existed.
 *
 * WHY E2E, when the routing is unit-tested. `workspaceWizardEntry('new')` is a
 * pure function asserted directly in renderer/lib/__tests__/workspace-onboarding
 * .test.ts, and it was WRONG there in a way a unit test caught the moment one
 * was written. What no unit test in this repo can answer is whether the create
 * route creates: there is no DOM harness (see vitest.config.ts), so "the form
 * appeared and a workspace landed on disk" is only observable here.
 *
 * NOT MOCKED: `agi:create` really scaffolds the folder and commits it, and
 * `workspaces:add` really registers the row. The fixture only sets the default
 * location and reports GitHub disconnected — which is also the state that proves
 * the second half of #431: the container repository is a consequence of being
 * connected, never a precondition for making a workspace.
 *
 * The negative assertion (the inspect wizard did not open) has its positive
 * control in tynn-import.spec.ts, which asserts the SAME heading is visible when
 * a route that should inspect does inspect. Without that pairing, "the wizard is
 * absent" would also pass on a screen that renders nothing at all.
 */

let app: ElectronApplication;
let page: Page;
let seed: WorkspaceCreateSeed;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('workspace-create'));
    const found = await readWorkspaceCreateSeed(app);
    expect(
        found,
        'the workspace-create fixture should have seeded before the window loaded',
    ).not.toBeNull();
    seed = found!;

    // The source card. Its own screen carries the same title, which is why this
    // click happens once, first, while only the picker is on screen.
    await page.getByRole('heading', { name: 'New workspace', exact: true }).click();
});

test.afterAll(async () => {
    await app?.close();
});

test('New workspace asks for a name, not for a folder to convert', async () => {
    // The form, not the wizard: one name field and a location, no Source →
    // Repos → Knowledge carousel over a folder that does not exist yet.
    await expect(page.getByLabel('Workspace name')).toBeVisible();
    await expect(
        page.getByRole('heading', { name: /Set up this (folder|repository)/ }),
        'genie#431: "New workspace" was routed into the inspect-and-convert wizard',
    ).toHaveCount(0);

    // And it says what happens with GitHub instead of asking. No "No remote /
    // Auto-create / Paste URL" mode picker: the account decides that.
    await expect(page.getByRole('button', { name: 'Auto-create' })).toHaveCount(0);
    await expect(page.getByText(/Kept on this machine/)).toBeVisible();
});

test('naming it and pressing create really makes the workspace', async () => {
    await page.getByLabel('Workspace name').fill(seed.workspaceName);

    // The location came from the primary workspace folder, so the only question
    // the form asks is already answered.
    await expect(page.getByText(`Lands at ${seed.expectedPath}`)).toBeVisible();

    await page.getByRole('button', { name: 'Create workspace' }).click();

    const added = page.locator('[data-testid="workspace-added"]');
    await expect(added).toBeVisible({ timeout: 40_000 });
    await expect(added).toHaveAttribute('data-path', seed.expectedPath);
    await expect(added).toHaveAttribute('data-name', seed.workspaceName);
});

test('the workspace it made is on disk, scaffolded and committed', async () => {
    // A registered row pointing at nothing would satisfy every DOM assertion
    // above. Playwright drives Electron on THIS machine, so the folder the form
    // created is right here to look at.
    expect({
        manifest: fs.existsSync(path.join(seed.expectedPath, 'project.json')),
        repos: fs.existsSync(path.join(seed.expectedPath, 'repos')),
        knowledge: fs.existsSync(path.join(seed.expectedPath, '.ai')),
        git: fs.existsSync(path.join(seed.expectedPath, '.git')),
    }).toEqual({ manifest: true, repos: true, knowledge: true, git: true });
});
