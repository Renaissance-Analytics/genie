import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * E2E for the REPOSITORY PANEL — the first plugin-panel consumer of the generic
 * plugin-UI panel surface.
 *
 * WHY E2E: the unit suite pins the pure pieces red-first (manifest validation,
 * the panel registry, the porcelain/branch parsers, the RepoStatus→WorkingTree
 * mapping, the adapter-registry resolver), but none of that proves the PANEL
 * actually renders real git state through the whole stack. Only a real Electron
 * window can answer "does opening the panel show the repo's real changes, and
 * does a mutating git op round-trip?" — the panel resolves its declared
 * `RepoChangesPanel` export through the compile-time adapter registry, mounts the
 * vetted fancy-git-ui components (WorkingTree / DiffViewer / CommitComposer), and
 * drives the REAL `repo:*` host git binding against a REAL git repo (seeded by
 * main/e2e/repo.ts: an unstaged tracked modification + an untracked file).
 *
 * Nothing here is mocked; the assertions are about the real chain end to end.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('repo-panel'));
});

test.afterAll(async () => {
    await app.close();
});

test('shows real changes, renders a diff, and round-trips a stage on the host', async () => {
    // The seed must have resolved — a missing workspace surfaces as e2e-error.
    await expect(page.getByTestId('e2e-error')).toHaveCount(0);

    // WorkingTree rendered ⇒ repo:status ran against the real repo.
    const workingTree = page.locator('[data-git-working-tree]');
    await expect(workingTree).toBeVisible({ timeout: 15_000 });

    // The seeded branch is `main`.
    await expect(page.locator('[data-repo-branch]')).toContainText('main');

    // Both seeded changes appear: an unstaged tracked modification + an untracked file.
    const modified = page.locator('li[data-git-path="readme.md"]');
    await expect(modified).toBeVisible();
    await expect(page.locator('li[data-git-path="untracked.txt"]')).toBeVisible();

    // Selecting the modified file loads its unified diff (the vetted DiffViewer),
    // and the diff shows the line we changed in the fixture.
    await modified.getByRole('checkbox').click();
    const diff = page.locator('[data-git-diff]');
    await expect(diff).toBeVisible({ timeout: 15_000 });
    await expect(diff).toContainText('changed line');

    // Stage the selected file — a real `repo:stage` on the host. The panel
    // confirms the op completed (it refreshes status after every op).
    await page.getByRole('button', { name: 'Stage', exact: true }).click();
    await expect(page.locator('[data-repo-notice]')).toContainText('Staged', {
        timeout: 15_000,
    });
});
