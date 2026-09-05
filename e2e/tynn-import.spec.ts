import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E, readTynnImportSeed, type TynnImportSeed } from './helpers/launch';

/**
 * IMPORTING FROM TYNN — the entry point that already knows which workspace you
 * mean.
 *
 * The owner set up a new machine, chose their Tynn project, and was made to go
 * and find a folder on disk. A project with no `.agi` repository fell through
 * `tynnImportRoute` to the scan-and-convert wizard in `mode: 'local'` — which
 * means *"pick a folder to convert"* — so the one route with nothing left to ask
 * asked the hardest question there is.
 *
 * The rule the rebuild follows: **all projects in Tynn are workspaces**, and a
 * workspace needs a name and a folder. Repositories are optional, so their
 * absence cannot be a precondition.
 *
 * WHY E2E, when the routing is unit-tested. The decision is a pure function,
 * asserted directly in `renderer/lib/__tests__/add-workspace.test.ts`. What no
 * unit test can answer is whether the modal READS it — the defect was never in a
 * rule, it was in a component going somewhere else. This drives the real modal
 * over the real IPC and looks at what lands on disk.
 *
 * THE POSITIVE CONTROLS ARE NOT OPTIONAL. "It asked nothing" is satisfied
 * perfectly by a flow that DOES nothing, so the same picker is watched carrying
 * a container through to a real clone, and a code repository through into
 * `repos/`, before the empty case is allowed to claim anything.
 *
 * Only the network is stood in for (see `main/e2e/tynn-import.ts`): the Tynn
 * project list. The repositories those projects declare are real git repos on
 * this disk, so the clone, the submodule and the registration are all the
 * shipped ones.
 */

let app: ElectronApplication;
let page: Page;
let seed: TynnImportSeed;

// One modal, walked three times — the harness reopens it after each import.
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

/** The inspection's own heading. No Tynn import may ever reach it. */
const INSPECTION = /Set up this (folder|repository)/;

/** Add workspace → Import from Tynn → choose a project → Continue. */
async function chooseProject(projectId: string): Promise<void> {
    // The source card. At this stage nothing else carries that heading; the
    // step it opens has one of its own, which is why this runs first.
    await page.getByRole('heading', { name: 'Import from Tynn', exact: true }).click();
    // react-fancy's Select defaults to a NATIVE <select> (`variant` unset and
    // not `multiple`), so it is driven by value, not by clicking an option.
    const select = page.locator('[data-react-fancy-select]');
    await expect(select).toBeVisible();
    await select.selectOption(projectId);
    await page.getByRole('button', { name: 'Continue' }).click();
}

/** Import the project the modal is currently showing, and read what landed. */
async function create(label: string, expectedPath: string, projectId: string): Promise<void> {
    await page.getByRole('button', { name: label }).click();
    const added = page.locator('[data-testid="workspace-added"]');
    await expect(added).toBeVisible({ timeout: 60_000 });
    await expect(added).toHaveAttribute('data-project', projectId);
    await expect(added).toHaveAttribute('data-path', expectedPath);
}

/** Back to a fresh modal for the next project. */
async function addAnother(): Promise<void> {
    await page.getByTestId('add-another').click();
}

test('a project that declares a container still has it CLONED', async () => {
    // POSITIVE CONTROL, first and deliberately: the import must be seen doing
    // real work before its restraint on the next test means anything.
    await chooseProject(seed.envelopeProjectId);

    await expect(page.getByRole('heading', { name: INSPECTION })).toHaveCount(0);
    await create('Clone & add workspace', seed.envelopePath, seed.envelopeProjectId);

    expect(
        {
            container: fs.existsSync(path.join(seed.envelopePath, 'project.json')),
            // A file that exists ONLY in the source container — proof this was
            // cloned rather than scaffolded fresh at the same path.
            broughtDown: fs.existsSync(path.join(seed.envelopePath, 'CONTAINER.md')),
        },
        'the declared container should be on disk, brought down whole',
    ).toEqual({ container: true, broughtDown: true });
});

test('a project that declares a code repository gets that repository', async () => {
    // SECOND POSITIVE CONTROL. Without it, "a project with no repos is fine"
    // and "repos are ignored" look identical from the outside.
    await addAnother();
    await chooseProject(seed.plainProjectId);

    await create('Create workspace', seed.plainPath, seed.plainProjectId);

    expect(
        fs.existsSync(path.join(seed.plainPath, 'repos', 'plain', 'README.md')),
        'the repository the project declares should be in the workspace',
    ).toBe(true);
});

test('a project with NO repositories asks for nothing — no folder, no conversion', async () => {
    await addAnother();
    await chooseProject(seed.bareProjectId);

    // THE ASSERTION THE BUG DESERVES. Tynn named the project and the machine has
    // a default location, so all three questions are answered: there is nothing
    // on screen to fill in and nowhere to browse to.
    await expect(
        page.getByRole('button', { name: 'Browse' }),
        'the import knows where the workspace goes — it must not ask for a folder',
    ).toHaveCount(0);
    await expect(
        page.getByRole('heading', { name: INSPECTION }),
        'there is nothing to inspect: the project has no repositories',
    ).toHaveCount(0);

    const createButton = page.getByRole('button', { name: 'Create workspace' });
    await expect(createButton, 'the only thing left to do is confirm').toBeEnabled();

    await create('Create workspace', seed.barePath, seed.bareProjectId);
});

test('the workspace it made for the empty project is a real one on disk', async () => {
    // A registered row pointing at nothing would satisfy every DOM assertion
    // above. Read from the spec process — Playwright drives Electron on THIS
    // machine, so the folder the import created is right here.
    expect({
        container: fs.existsSync(path.join(seed.barePath, 'project.json')),
        repos: fs.existsSync(path.join(seed.barePath, 'repos')),
        git: fs.existsSync(path.join(seed.barePath, '.git')),
    }).toEqual({ container: true, repos: true, git: true });
});
