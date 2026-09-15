import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
    killMasterTerminals,
    launchGenieE2E,
    readMasterSeed,
    withTeardownBound,
    type MasterSeed,
} from './helpers/launch';

/**
 * Ctrl+Shift+W opens FEEDBACK for the active workspace (genie#675).
 *
 * The owner: "the Wish window that opens when you hit the ctrl+shift+w key is
 * broken … Fix that. That should also be aware of what workspace is active so it
 * defaults to that tynn project."
 *
 * Drives the REAL master window. `press()` (main/e2e/feedback.ts) is what the
 * global hotkey does once it reaches main — `requestFeedback` on the window — so
 * everything from the IPC event to the modal, its picker and its send is the
 * shipped code. Only the Tynn project list and the send itself are stood in for,
 * and the send is RECORDED rather than filed into a real project.
 * `globalShortcut` itself is an OS registration a CI runner cannot press; its
 * wiring to `openFeedbackWindow` is unit-tested in main/__tests__/feedback-hotkey.
 */

let app: ElectronApplication;
let page: Page;
let seed: MasterSeed;

interface Submission {
    projectId: string;
    message: string;
    meta: Record<string, string>;
}

async function submissions(): Promise<Submission[]> {
    return app.evaluate(() => (globalThis as any).__GENIE_E2E_FEEDBACK__.submissions.slice());
}

async function dismissWhatsNew(): Promise<void> {
    const whatsNew = page.locator('.whats-new-backdrop');
    await whatsNew.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await whatsNew.count()) {
        await page.getByRole('button', { name: 'Got it' }).click();
        await expect(whatsNew).toHaveCount(0);
    }
}

/** Relink the active workspace, reload so the page reads the row, wait for the rail. */
async function withActiveLinkedTo(project: { id: string; name: string } | null): Promise<void> {
    await app.evaluate((_electron, p) => (globalThis as any).__GENIE_E2E_FEEDBACK__.linkActive(p), project);
    await page.reload();
    await dismissWhatsNew();
    await expect(page.locator('.tproj-head').filter({ hasText: seed.workspaceName })).toBeVisible({
        timeout: 20_000,
    });
}

async function pressHotkey(): Promise<void> {
    await app.evaluate(() => (globalThis as any).__GENIE_E2E_FEEDBACK__.press());
}

const modal = () => page.locator('[data-react-fancy-modal]').filter({ hasText: 'Send feedback' });

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('master', { GENIE_E2E_FEEDBACK: '1' }));
    await dismissWhatsNew();
    const seeded = await readMasterSeed(app);
    if (!seeded) throw new Error('the master fixture never published its seed');
    seed = seeded;
    const mocked = await app.evaluate(() => Boolean((globalThis as any).__GENIE_E2E_FEEDBACK__));
    if (!mocked) {
        throw new Error('the feedback mocks are not registered — a send here would reach a real Tynn');
    }
});

test.afterAll(async () => {
    if (app) await killMasterTerminals(app).catch(() => {});
    if (app) await withTeardownBound(app.close(), 20_000, 'app.close()').catch(() => {});
});

test("the hotkey opens Feedback with the active workspace's Tynn project selected", async () => {
    await withActiveLinkedTo({ id: 'PRJ-E2E-HOTKEY', name: 'Hotkey Project' });

    // Control: nothing has asked for Feedback yet.
    await expect(modal()).toHaveCount(0);

    await pressHotkey();

    await expect(modal()).toBeVisible();
    const project = modal().locator('select');
    await expect(project).toHaveValue('PRJ-E2E-HOTKEY');
    await expect(project.locator('option:checked')).toHaveText('Hotkey Project');

    await modal().locator('textarea').fill('The hotkey found the right project');
    await modal().getByRole('button', { name: 'Send feedback' }).click();

    await expect.poll(submissions).toEqual([
        {
            projectId: 'PRJ-E2E-HOTKEY',
            message: 'The hotkey found the right project',
            meta: { workspace: seed.workspaceName },
        },
    ]);
    await expect(modal()).toContainText('Hotkey Project');
});

test('a workspace with no Tynn project asks where to send, and sends where chosen', async () => {
    await withActiveLinkedTo(null);
    const before = (await submissions()).length;

    await pressHotkey();

    await expect(modal()).toBeVisible();
    await expect(modal()).toContainText('isn’t connected to a Tynn project');
    const project = modal().locator('select');
    await expect(project).toHaveValue('');

    await modal().locator('textarea').fill('Filed where I chose');
    const send = modal().getByRole('button', { name: 'Send feedback' });
    // Nothing is guessed: with no project chosen there is nothing to send to.
    await expect(send).toBeDisabled();

    await project.selectOption('PRJ-E2E-OTHER');
    await expect(send).toBeEnabled();
    await send.click();

    await expect
        .poll(async () => (await submissions()).slice(before))
        .toEqual([
            {
                projectId: 'PRJ-E2E-OTHER',
                message: 'Filed where I chose',
                meta: { workspace: seed.workspaceName },
            },
        ]);
});
