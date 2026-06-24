import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E, readMockState } from './helpers/launch';

/**
 * E2E test for the GitHub permissions RESOLVE flow's per-installation list +
 * App-settings deep-link.
 *
 * THE PROBLEM (field-confirmed): when a feature is gated on a permission the App
 * doesn't DECLARE (e.g. provisioning needs `contents:write`), the old resolve
 * flow deep-linked to the INSTALLATION page — but with nothing pending there to
 * approve (the App hadn't declared the perm), it dead-ended. And with multiple
 * installs (personal + orgs) there's no GitHub "approve for all", so the user
 * needs to know WHICH installs are missing it.
 *
 * THE FIX surfaced here:
 *   1. an "Open App permission settings…" button → the App permission-settings
 *      page (where the OWNER adds the permission first), and
 *   2. a per-install approval list showing the SPECIFIC installs missing each
 *      permission, each with a deep-link to ITS own review page.
 *
 * This test drives the REAL GithubCapabilitiesFlyout (the /e2e-ghcaps harness)
 * against the scriptable GENIE_E2E mock: it scripts `contents` missing on the
 * org install (one install granting, one not), reloads so the flyout re-reads,
 * and asserts the App-settings link + the non-granting install's review link
 * both render and open the right URLs.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('ghcaps'));
    // Script the missing-`contents` capability state (org install not granting),
    // then reload so the flyout's useGithubCapabilities hook re-reads it on mount.
    await app.evaluate(() => {
        const handle = (globalThis as Record<string, any>).__GENIE_E2E__;
        handle.state.github.capabilities = handle.missingContentsCapabilities();
    });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
    await app?.close();
});

test('resolve flow lists the non-granting install + the App-settings deep-link', async () => {
    // The intro + the "Missing permissions" chip name the gated permission.
    await expect(page.getByText('Missing permissions')).toBeVisible();
    await expect(page.locator('.ghcap-perm')).toContainText('Repository contents');

    // STEP 1: the App-permission-settings button is present (the real first
    // step — owner adds the perm). Clicking it opens the App settings page.
    const appSettingsBtn = page.getByRole('button', {
        name: 'Open App permission settings…',
    });
    await expect(appSettingsBtn).toBeVisible();

    // STEP 2: the per-install approval section lists the NON-granting install
    // (the org one) — NOT the personal install that grants contents.
    const installRow = page.locator('.ghcap-install-row');
    await expect(installRow).toHaveCount(1);
    await expect(installRow).toContainText('Renaissance-Analytics');
    await expect(installRow.locator('.ghcap-install-kind')).toContainText('org');

    // Clicking that install's "Review…" opens ITS own review page (org variant).
    await installRow.getByRole('button', { name: 'Review…' }).click();
    await expect
        .poll(async () => (await readMockState(app)).openedUrls)
        .toContain(
            'https://github.com/organizations/Renaissance-Analytics/settings/installations/2002',
        );

    // Clicking "Open App permission settings…" opens the App's permission page.
    await appSettingsBtn.click();
    await expect
        .poll(async () => (await readMockState(app)).openedUrls)
        .toContain('https://github.com/settings/apps/genie-ide/permissions');

    // The Reconnect + Re-check actions are still offered (not regressed).
    await expect(
        page.getByRole('button', { name: 'Reconnect GitHub…' }),
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: /Re-check now/ }),
    ).toBeVisible();
});
