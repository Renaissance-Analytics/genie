import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * The IssueWatch flyout's feedback notice must be a way IN to the entries, not
 * a number that names them and stops.
 *
 * The owner's complaint was exactly this: the panel told him five pieces of
 * feedback were waiting on triage and gave him no way to see what they were.
 * The count is server-sourced and correct; what was missing was the door.
 *
 * These drive the REAL IssueWatchFlyout (renderer/pages/e2e-issuewatch.tsx)
 * against the scriptable IPC mock, so they cover the wiring the unit tests
 * cannot: that the notice renders as a control at all, and that clicking it
 * asks to open the RESOLVED Tynn path.
 */
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E());
});

test.afterAll(async () => {
    await app?.close();
});

/** Script the mock: N open feedback, and the workspace row behind the notice. */
async function scriptFeedback(
    application: ElectronApplication,
    feedback: number,
    ws: { tynn_project_id: string; backend: 'tynn' | 'none' },
) {
    await application.evaluate(
        (
            {},
            args: {
                feedback: number;
                ws: { tynn_project_id: string; backend: 'tynn' | 'none' };
            },
        ) => {
            const state = (globalThis as Record<string, any>).__GENIE_E2E__.state;
            state.issueWatch.counts = {
                'e2e-workspace': { issue: 0, pr: 0, security: 0, feedback: args.feedback },
            };
            state.workspaces = [{ id: 'e2e-workspace', ...args.ws }];
            state.openedUrls.length = 0;
        },
        { feedback, ws },
    );
}

test('the feedback notice opens the project feedback in Tynn', async () => {
    await scriptFeedback(app, 5, { tynn_project_id: 'PRJ-E2E', backend: 'tynn' });
    await page.reload();

    const notice = page.getByRole('button', { name: /unresolved pieces of project feedback/i });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('5 unresolved pieces of project feedback');

    // POSITIVE CONTROL for the assertion below: nothing has been opened yet, so
    // the URL recorded after the click is one this click caused.
    expect(await app.evaluate(() => (globalThis as any).__GENIE_E2E__.state.openedUrls)).toEqual([]);

    await notice.click();

    await expect
        .poll(async () =>
            app.evaluate(() => (globalThis as any).__GENIE_E2E__.state.openedUrls),
        )
        .toEqual(['/p/PRJ-E2E/feedback']);
});

test('a workspace with no Tynn project shows the notice but offers no dead link', async () => {
    // Same count, but a workspace with no backend — its id is local, so there is
    // no Tynn project to open. The notice must still report the tally (it is
    // true, and it comes from the server) without presenting itself as a door.
    await scriptFeedback(app, 5, { tynn_project_id: '', backend: 'none' });
    await page.reload();

    await expect(page.getByText(/5 unresolved pieces of project feedback/i)).toBeVisible();
    await expect(
        page.getByRole('button', { name: /unresolved pieces of project feedback/i }),
    ).toHaveCount(0);
});

test('no feedback means no notice at all', async () => {
    await scriptFeedback(app, 0, { tynn_project_id: 'PRJ-E2E', backend: 'tynn' });
    await page.reload();

    await expect(page.getByText(/unresolved piece/i)).toHaveCount(0);
    // Positive control: the flyout really did render — the absence above is the
    // notice being absent, not the panel failing to mount.
    await expect(page.getByTestId('e2e-root')).toBeVisible();
});

/**
 * The entries BY NAME (owner: "Issue titles are supposed to be piped in with the
 * IssueWatch stream, not just a thing saying I have x amount of feedbacks").
 *
 * The stream carries a bounded list of the most recently moved open issues beside
 * the full count. The panel must name each one, open THAT issue when it is
 * clicked, and say how many more wait rather than let a short list pass for the
 * whole queue.
 */
test('the panel names the open issues, opens the one clicked, and says how many more wait', async () => {
    await scriptFeedback(app, 5, { tynn_project_id: 'PRJ-E2E', backend: 'tynn' });
    await app.evaluate(() => {
        const state = (globalThis as Record<string, any>).__GENIE_E2E__.state;
        state.issueWatch.feedbackItems = [
            {
                key: 'tynn-issue:A',
                number: 12,
                title: 'The billing screen loses my filter on refresh',
                source: 'feedback',
                url: 'https://tynn.ai/p/PRJ-E2E/issues?issue=A',
                createdAt: null,
                updatedAt: null,
            },
            {
                key: 'tynn-issue:B',
                number: 13,
                title: 'Add a keyboard shortcut for search',
                source: 'wish',
                url: 'https://tynn.ai/p/PRJ-E2E/issues?issue=B',
                createdAt: null,
                updatedAt: null,
            },
        ];
    });
    await page.reload();

    const list = page.getByRole('list', { name: 'Open issues in Tynn' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('button', { name: /#12\s*The billing screen loses my filter on refresh/ })).toBeVisible();
    await expect(list.getByRole('button', { name: /#13\s*Add a keyboard shortcut for search/ })).toBeVisible();
    // Five open, two named: the other three are said, not hidden.
    await expect(list).toContainText('and 3 more in Tynn');

    await list.getByRole('button', { name: /Add a keyboard shortcut for search/ }).click();
    await expect
        .poll(async () => app.evaluate(() => (globalThis as any).__GENIE_E2E__.state.openedUrls))
        .toEqual(['https://tynn.ai/p/PRJ-E2E/issues?issue=B']);

    // Leave the shared state as the other tests expect it.
    await app.evaluate(() => {
        (globalThis as Record<string, any>).__GENIE_E2E__.state.issueWatch.feedbackItems = [];
    });
});
