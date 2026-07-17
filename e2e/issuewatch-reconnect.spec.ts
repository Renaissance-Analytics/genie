import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * IssueWatch is exclusively Tynn-served. A stale or expired GitHub repository
 * token must not gate the feed or offer a GitHub reconnect action.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E());
});

test.afterAll(async () => {
    await app?.close();
});

test('expired GitHub repo session does not gate the Tynn IssueWatch feed', async () => {
    await app.evaluate(() => {
        const state = (globalThis as Record<string, any>).__GENIE_E2E__.state;
        // Preserve the mock's dead GitHub session. Only Tynn's pushed
        // IssueWatch state recovers.
        state.github.needsReauth = true;
        state.issueWatch.status = {
            connected: true,
            error: null,
            detail: null,
            needsReauth: false,
        };
        state.issueWatch.repos = [{
            owner: 'Renaissance-Analytics',
            repo: 'guardian',
            enabled: true,
            unread: 1,
            error: null,
            detail: null,
        }];
        state.issueWatch.feed = [{
            kind: 'issue',
            key: 'Renaissance-Analytics/guardian#7',
            number: 7,
            title: 'Tynn keeps IssueWatch live',
            url: 'https://github.com/Renaissance-Analytics/guardian/issues/7',
            updatedAt: new Date().toISOString(),
            owner: 'Renaissance-Analytics',
            repo: 'guardian',
            unread: true,
        }];
    });

    await page.reload();
    await expect(page.locator('.iw-reauth')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
    await expect(page.getByText('Tynn keeps IssueWatch live')).toBeVisible();
});
