import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E, readHostingState } from './helpers/launch';

/**
 * Settings → **Toolchain**, proven against the REAL compiled app via the hosting
 * harness (which mounts the shipped `ToolchainSection`).
 *
 * The row models, the tab split and every sentence are unit-tested; this proves
 * the WIRING those units cannot reach:
 *
 *  - the three tabs really are three tabs, and a language never appears under
 *    Dev tools (the confusion the page was built to end);
 *  - a Genie-owned install offers Set default and Remove, and a HERD one offers
 *    neither while still being visible — the genie#206 machine, where the same
 *    `php` means two different directories;
 *  - a click reaches main's `toolchain:*` channel with the right tool + version
 *    and the row repaints.
 *
 * The harness fixtures `toolchain:updates` / `toolchain:installs` (the real ones
 * walk the disk and shell out to `<pm> outdated`) and records each action, so
 * nothing is installed or deleted on the runner.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('hosting'));
});

test.afterAll(async () => {
    await app?.close();
});

const section = () => page.locator('.set-section', { hasText: 'Toolchain' }).first();
const tab = (name: RegExp) => section().getByRole('tab', { name });
const gitRow = () => page.getByTestId('devtool-git');
const updateButton = (row: ReturnType<typeof gitRow>) =>
    row.getByRole('button', { name: /update/i });

const phpRow = (version: string) => page.getByTestId(`toolchain-install-php-${version}`);

test('opens on Languages and lists every version with its SOURCE and DIRECTORY', async () => {
    // "Which php is this?" is the actual question on a machine carrying three of
    // them, so the row has to answer it without a hover or a click.
    await expect(phpRow('8.3.33')).toContainText('Genie');
    await expect(phpRow('8.3.33')).toContainText(
        'AppData\\Roaming\\Genie\\toolchain\\php\\8.3.33',
    );
    await expect(phpRow('8.3.33')).toContainText('Default');

    // Herd's — the exact genie#206 layout, real binaries one level down.
    await expect(phpRow('8.4.1')).toContainText('Herd');
    await expect(phpRow('8.4.1')).toContainText('.config\\herd\\bin\\php84');
});

test('a foreign install is visible but offers nothing — it cannot be used or deleted', async () => {
    const herd = phpRow('8.4.1');
    await expect(herd).toContainText('Not managed');
    await expect(herd).toContainText(/not managed by Genie/i);
    await expect(herd.getByRole('button', { name: 'Set default' })).toHaveCount(0);
    await expect(herd.getByRole('button', { name: 'Remove' })).toHaveCount(0);
});

test('setting a default reaches main and NAMES the sites it moves', async () => {
    await phpRow('8.2.33').getByRole('button', { name: 'Set default' }).click();

    await expect
        .poll(async () => (await readHostingState(app))?.calls.toolchainSetDefault ?? [])
        .toContain('php:8.2.33');

    // The visible confirmation names the site that FOLLOWS the default, and not
    // the one that pinned 8.2.33 — "saved" would be a lie about what moved.
    const notice = page.getByTestId('toolchain-notice');
    await expect(notice).toContainText('web.hosting-e2e.gen');
    await expect(notice).toContainText('next start');
    await expect(notice).not.toContainText('api.hosting-e2e.gen');

    // …and the table repainted from main rather than from memory.
    await expect(phpRow('8.2.33')).toContainText('Default');
});

test('Remove asks first, names the cost, and then actually removes', async () => {
    await phpRow('8.3.33').getByRole('button', { name: 'Remove' }).click();

    // Not "are you sure": the sentence says WHERE it deletes from and how much
    // disk that reclaims, because owning the whole directory is what makes the
    // number honest.
    const risk = page.getByTestId('toolchain-remove-risk');
    await expect(risk).toContainText('toolchain\\php\\8.3.33');
    await expect(risk).toContainText('90 MB');

    // Scoped to the DIALOG, not the row that opened it — both say "Remove".
    await page.locator('.ws-confirm').getByRole('button', { name: 'Remove', exact: true }).click();

    await expect
        .poll(async () => (await readHostingState(app))?.calls.toolchainRemove ?? [])
        .toContain('php:8.3.33');
    await expect(phpRow('8.3.33')).toHaveCount(0);
    // The two that were not removed are untouched.
    await expect(phpRow('8.2.33')).toBeVisible();
    await expect(phpRow('8.4.1')).toBeVisible();
});

test('a language never appears under Dev tools', async () => {
    await tab(/Dev tools/).click();
    await expect(gitRow()).toBeVisible();
    // node and php are LANGUAGES — multi-version, on their own tab. A single
    // "Node.js — up to date" row here beside a Languages tab listing three node
    // versions is precisely the confusion this page exists to remove.
    await expect(page.getByTestId('devtool-node')).toHaveCount(0);
    await expect(page.getByTestId('devtool-php')).toHaveCount(0);
});

test('renders each tool-update tone honestly', async () => {
    await tab(/Dev tools/).click();
    await expect(gitRow()).toContainText('Update available');

    // docker is installed but no source could name its latest — it must read as
    // an honest "Installed", never a FALSE "Up to date", and offer no Update.
    const docker = page.getByTestId('devtool-docker');
    await expect(docker).not.toContainText('Up to date');
    await expect(docker).not.toContainText('Update available');
    await expect(updateButton(docker)).toHaveCount(0);
});

test('clicking Update reaches main with the tool and repaints the row', async () => {
    await tab(/Dev tools/).click();
    await updateButton(gitRow()).click();

    // The click reached main's toolchain:update for git (not an arbitrary command).
    await expect
        .poll(async () => (await readHostingState(app))?.calls.toolchainUpdate ?? [])
        .toContain('git');

    // ...and the row repainted from the refresh: git is now up to date, no button.
    await expect(gitRow()).toContainText('Up to date');
    await expect(updateButton(gitRow())).toHaveCount(0);
});

/**
 * A row that reports a problem and offers no way to fix it is a dead end — and
 * it is what the owner hit: "it seems i am missing install buttons for docker
 * and git and the agent clis" (genie#212). Both tabs, because the page owns
 * install now on both.
 */
test('a NOT-INSTALLED tool offers Install, and installing it repaints the row', async () => {
    await tab(/Dev tools/).click();
    const composer = page.getByTestId('devtool-composer');
    await expect(composer).toContainText('Not installed');

    const install = composer.getByRole('button', { name: /^install$/i });
    await expect(install).toHaveCount(1);
    await install.click();

    // It reached main for composer specifically, and the row now names a version
    // rather than still claiming the tool is absent.
    await expect
        .poll(async () => (await readHostingState(app))?.calls.toolchainUpdate ?? [])
        .toContain('composer');
    await expect(composer).not.toContainText('Not installed');
});

test('the Agent CLIs tab offers Install too — the wizard is not the only way in', async () => {
    await tab(/Agent CLIs/).click();
    const claude = page.getByTestId('devtool-claude-code');
    await expect(claude).toContainText('Not installed');
    await expect(claude.getByRole('button', { name: /^install$/i })).toHaveCount(1);
});

test('the Agent CLIs tab states the mid-turn rule once, in its own place', async () => {
    await tab(/Agent CLIs/).click();
    await expect(section()).toContainText(/mid-turn/i);
    // The dev tools are NOT here — three management models, three tabs.
    await expect(gitRow()).toHaveCount(0);
});

test('the toolchain can be asked to check again', async () => {
    // The scan is CACHED (it queries winget/brew/npm), which is exactly why an
    // explicit re-check has to exist.
    await section().getByRole('button', { name: 'Check again' }).click();
    // It goes back to main rather than repainting from memory: the page survives
    // and is still readable afterwards.
    await tab(/Dev tools/).click();
    await expect(gitRow()).toBeVisible();
});

test('a tool row names WHO installed it and WHERE — genie#213', async () => {
    // The gap this closes: the Languages tab has always answered "which php is
    // this?" with a source and a directory, and the Dev tools tab answered
    // neither — so on a machine carrying more than one git, the row could not say
    // which one replied.
    await tab(/dev tools/i).click();

    // A winget git: visible, located, and explicitly NOT Genie's to update.
    await expect(gitRow()).toContainText('winget');
    await expect(gitRow()).toContainText(String.raw`WinGet\Links`);
    await expect(gitRow()).toContainText('Not managed');

    // A Genie-installed docker: located, and NOT carrying the foreign badge.
    // Asserted alongside the row above because the claim is that the page tells
    // the two apart — a page that labelled everything "Not managed" would pass
    // the half of this test that only looks at git.
    const dockerRow = page.getByTestId('devtool-docker');
    await expect(dockerRow).toContainText('Genie');
    await expect(dockerRow).toContainText(String.raw`toolchain\docker\bin`);
    await expect(dockerRow).not.toContainText('Not managed');
});

test('a tool whose path could not be resolved says nothing rather than guessing', async () => {
    // composer is not installed in the fixture and carries no origin. The row
    // must not invent a location, and must not read as managed — offering to
    // update something Genie does not own is the one wrong answer here.
    await tab(/dev tools/i).click();

    const composerRow = page.getByTestId('devtool-composer');
    await expect(composerRow).toBeVisible();
    await expect(composerRow).not.toContainText('Not managed');
    await expect(composerRow).not.toContainText('·');
});
