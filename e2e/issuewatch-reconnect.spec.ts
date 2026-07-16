import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E, readMockState } from './helpers/launch';

/**
 * E2E regression test for the Issue Watch device-flow RECONNECT.
 *
 * THE BUG (shipped once): in IssueWatchFlyout's reconnect poll, the completion
 * condition keyed off `st.connected`. But a DEAD stored token still reads as
 * `connected: true` (it's present, just rejected), so the very FIRST
 * `github:status` poll satisfied the condition and cleared the device user code
 * before the user could type it at github.com. The flow could never complete.
 *
 * THE FIX: complete on the DEVICE FLOW'S OWN outcome — `st.flow.kind` flips to
 * 'success'/'error'. `connected` is ignored, so the user code SURVIVES across
 * polls while `flow.kind` stays 'pending'.
 *
 * This test drives the REAL flyout (via the e2e-issuewatch harness window)
 * against the scriptable GENIE_E2E mock, reproducing the dead-session start
 * state and a flow that stays pending across several polls. It asserts the user
 * code survives ≥2 polls, then flips the mock to success and asserts recovery.
 * It PASSES on the fixed code and FAILS on the reverted (buggy) code.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E());
});

test.afterAll(async () => {
    await app?.close();
});

test('dead session → reconnect: user code survives polls, then feed recovers', async () => {
    // 1) Dead-session banner. The default mock state is connected:true +
    //    needsReauth + a 401 read, so the flyout shows the Reconnect banner with
    //    the precise "GitHub returned 401: Bad credentials" line — NOT the plain
    //    "connect in Settings" copy. Scope to the flyout's own reauth banner
    //    (`.iw-reauth`); Next injects a hidden route-announcer with role=alert.
    const banner = page.locator('.iw-reauth');
    await expect(banner).toContainText('GitHub session expired');
    await expect(banner).toContainText('GitHub returned 401: Bad credentials');

    // 2) Start the reconnect device flow.
    await page.getByRole('button', { name: 'Reconnect' }).click();

    // The device user code is shown so the user can enter it at github.com.
    const code = page.getByText('WXYZ-1234');
    await expect(code).toBeVisible();
    // And the verification URL was opened in the (mocked, inert) browser.
    await expect
        .poll(async () => (await readMockState(app)).openedUrls.length)
        .toBeGreaterThan(0);

    // 3) THE REGRESSION GUARD. The flow stays flow.kind:'pending' with
    //    connected:true (dead token still stored). The poll fires every 1.5s.
    //    Capture the status-call count, wait long enough for ≥2 more polls, and
    //    assert (a) the poll actually ran ≥2 more times and (b) the user code is
    //    STILL visible. The old code cleared it on the first poll (because
    //    connected was true) → this is where the buggy build fails.
    const before = (await readMockState(app)).calls.githubStatus;
    await page.waitForTimeout(4000); // ≥2 poll intervals (1.5s each) + margin
    const after = (await readMockState(app)).calls.githubStatus;
    expect(after - before).toBeGreaterThanOrEqual(2);
    await expect(code).toBeVisible(); // survived multiple polls — the fix

    // 4) Flip the device flow to success AND heal the Issue Watch read, the way
    //    a real fresh-token grant would: status reports a healthy session and the
    //    feed has an item. The next poll sees flow.kind:'success' → the flyout
    //    clears reconnect, rechecks capabilities, and refreshes the feed.
    await app.evaluate(() => {
        const s = (globalThis as Record<string, any>).__GENIE_E2E__.state;
        s.github.flow = {
            kind: 'success',
            user: { login: 'wishborn', name: null, avatar_url: '' },
        };
        s.github.needsReauth = false;
        s.issueWatch.status = {
            connected: true,
            error: null,
            detail: null,
            needsReauth: false,
        };
        s.issueWatch.repos = [
            {
                owner: 'Renaissance-Analytics',
                repo: 'guardian',
                enabled: true,
                unread: 1,
                error: null,
                detail: null,
            },
        ];
        s.issueWatch.feed = [
            {
                kind: 'issue',
                key: 'Renaissance-Analytics/guardian#7',
                number: 7,
                title: 'Guardian should reconnect cleanly',
                url: 'https://github.com/Renaissance-Analytics/guardian/issues/7',
                updatedAt: new Date().toISOString(),
                owner: 'Renaissance-Analytics',
                repo: 'guardian',
                unread: true,
            },
        ];
    });

    // The reconnect banner clears and the feed recovers — no app restart.
    await expect(page.locator('.iw-reauth')).toHaveCount(0);
    await expect(
        page.getByText('Guardian should reconnect cleanly'),
    ).toBeVisible();
    // The device code is gone (flow completed → idle).
    await expect(page.getByText('WXYZ-1234')).toHaveCount(0);
});
