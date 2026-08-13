import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E, readHostingState } from './helpers/launch';

/**
 * The Dev Tools section of the Toolchain Manager (#242 P2), proven against the
 * REAL compiled app via the hosting harness (which mounts the shipped
 * `DevServerSection`).
 *
 * The row model + the single-tool update engine are unit-tested; this proves the
 * WIRING those units can't reach: the section renders a badge per tone, offers
 * Update only where a newer version exists, and a click reaches main's
 * `toolchain:update` with the right tool and repaints the row. The harness
 * fixtures `toolchain:updates` (the real one shells out to `<pm> outdated`) and
 * records the update, so nothing is installed on the runner.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('hosting'));
});

test.afterAll(async () => {
    await app?.close();
});

const gitRow = () => page.getByTestId('devtool-git');
const updateButton = (row: ReturnType<typeof gitRow>) => row.getByRole('button', { name: /update/i });

test('renders each tool-update tone honestly', async () => {
    await expect(gitRow()).toContainText('Update available');
    await expect(page.getByTestId('devtool-node')).toContainText('Up to date');

    // docker is installed but no source could name its latest — it must read as an
    // honest "Installed", never a FALSE "Up to date", and offer no Update.
    const docker = page.getByTestId('devtool-docker');
    await expect(docker).not.toContainText('Up to date');
    await expect(docker).not.toContainText('Update available');
    await expect(updateButton(docker)).toHaveCount(0);
});

test('offers Update only for the tool with a newer version', async () => {
    await expect(updateButton(gitRow())).toBeVisible();
    await expect(updateButton(page.getByTestId('devtool-node'))).toHaveCount(0);
});

test('clicking Update reaches main with the tool and repaints the row', async () => {
    await updateButton(gitRow()).click();

    // The click reached main's toolchain:update for git (not an arbitrary command).
    await expect
        .poll(async () => (await readHostingState(app))?.calls.toolchainUpdate ?? [])
        .toContain('git');

    // ...and the row repainted from the refresh: git is now up to date, no button.
    await expect(gitRow()).toContainText('Up to date');
    await expect(updateButton(gitRow())).toHaveCount(0);
});
