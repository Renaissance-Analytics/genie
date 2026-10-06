import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * THE AGENT VIEW, RENDERED IN A REAL WINDOW.
 *
 * This surface did not exist until today — `floor-surface.ts` said so in its own comment, so
 * `?agent=<id>` silently rendered the grid — and I had nevertheless reported the phases that
 * specify it as complete. These are the assertions that make the claim checkable.
 *
 * Two rules carry the design:
 *
 * **Absence of a tab, not a disabled tab.** An Observed agent has no Conversation tab AT
 * ALL, because Genie only sees bytes. A greyed-out one would tell the user they did
 * something wrong when the truth is their provider does not report a conversation.
 *
 * **Approvals are inline, and the turn visibly parks.** An `Edit` approval fires many times
 * per turn, so a modal per approval would make the modal the new TUI.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('agent-view'));
});

test.afterAll(async () => {
    await app?.close();
});

const clicks = () =>
    page.evaluate(() => (window as unknown as { __AGENT_CLICKS__?: string[] }).__AGENT_CLICKS__ ?? []);

test('the view renders, with the agent named and its fidelity declared', async () => {
    await expect(page.getByTestId('agent-view')).toBeVisible();
    await expect(page.getByTestId('agent-view')).toHaveAttribute('data-fidelity', 'declared');
    await expect(page.getByText('kai').first()).toBeVisible();
    await expect(page.getByText('repos/genie').first()).toBeVisible();
});

test('a DECLARED agent gets Conversation, and no Activity tab', async () => {
    await expect(page.getByRole('tab', { name: 'Conversation' })).toBeVisible();
    // Activity is a sparkline — a measurement, for when there are no declared facts.
    // Offering both would present a guess beside the truth as though they were peers.
    await expect(page.getByRole('tab', { name: 'Activity' })).toHaveCount(0);
});

test('the approval is INLINE with all three outcomes, and reports which was chosen', async () => {
    await expect(page.getByText('Write main/terminal/ipc.ts')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow for session' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Allow for session' }).click();
    // The exact decision, not merely that a button worked. Allow sending Deny would pass a
    // weaker assertion and be the worst possible bug in this surface.
    await expect.poll(clicks).toContain('approve:ap1:allow-always');
});

test('the turn is shown as PARKED, with how long', async () => {
    // The turn has stopped and the human is the bottleneck. Saying so is the whole reason
    // the approval is here rather than behind a modal.
    await expect(page.getByText(/turn parked/)).toBeVisible();
    await expect(page.getByText(/8s/).first()).toBeVisible();
});

test('the rails show context BEFORE cost, because context predicts getting worse', async () => {
    const rail = page.getByTestId('rail-usage');
    await expect(rail).toBeVisible();
    const text = (await rail.textContent()) ?? '';
    expect(text.indexOf('178000')).toBeLessThan(text.indexOf('1.84'));
});

test('the plan rail shows progress, since the agent reported a plan', async () => {
    await expect(page.getByTestId('rail-plan')).toBeVisible();
    await expect(page.getByText('1/2')).toBeVisible();
    await expect(page.getByText('patch feedTerminalData')).toBeVisible();
});

test('Take over is offered as a VERB, distinct from the Terminal tab', async () => {
    // The tab is a noun (a place); taking over is a transfer of control.
    await page.getByRole('button', { name: 'Take over' }).click();
    await expect.poll(clicks).toContain('takeover');
});

test('an OBSERVED agent has a DIFFERENT SHAPE — no Conversation at all, nothing disabled', async () => {
    const observed = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const url = win.webContents.getURL();
        await win.loadURL(`${url.split('?')[0]}?fidelity=observed`);
        return true;
    });
    expect(observed).toBe(true);

    await expect(page.getByTestId('agent-view')).toHaveAttribute('data-fidelity', 'observed');
    // The assertion this surface exists for.
    await expect(page.getByRole('tab', { name: 'Conversation' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Activity' })).toBeVisible();

    // And the rails that cannot be known are ABSENT, not empty or zeroed — a dash in a cost
    // cell reads as zero.
    await expect(page.getByTestId('rail-plan')).toHaveCount(0);
    await expect(page.getByTestId('rail-usage')).toHaveCount(0);
});
