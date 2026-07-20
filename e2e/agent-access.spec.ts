import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E, readAgentAccessSeed } from './helpers/launch';

/**
 * E2E test for the per-workspace AGENT ACCESS control (Tynn story #218) — the
 * OUTER tier of AgentInbox access control, the workspace's front door.
 *
 * WHY THIS EXISTS: the unit suite covers the broker's two-tier predicates, but
 * nothing exercised the chain that actually delivers the setting to a user —
 * v27 migration → db accessors → IPC → preload → renderer → back. A green vitest
 * run says nothing about whether the control renders, persists, or round-trips.
 *
 * This drives the REAL AgentAccessPanel against the REAL workspaces IPC and the
 * REAL sqlite in a throwaway profile — no mock. That matters: the persistence
 * path is `UPDATE workspaces SET agent_access = ? WHERE id = ?`, so a bug that
 * writes to a missing row (or a migration that never added the column) shows up
 * here as a failed round-trip and nowhere else.
 *
 * The harness seeds two workspaces so the `specific` multi-select has a peer to
 * offer; their ids/names come back via `readAgentAccessSeed`.
 */

let app: ElectronApplication;
let page: Page;
let peerName: string;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('agent-access'));
    const seed = await readAgentAccessSeed(app);
    if (!seed) throw new Error('agent-access harness never published its seed');
    peerName = seed.peerName;
});

test.afterAll(async () => {
    await app?.close();
});

/** The panel's <select>; it renders only after the async load resolves. */
function accessSelect(p: Page) {
    return p.locator('[data-testid="agent-access-root"] select');
}

test('defaults to the permissive value, so upgrades do not sever open channels', async () => {
    // v27 ships `agent_access` DEFAULT 'all' deliberately — channels were
    // ungoverned before this feature, and failing closed would silently break
    // working cross-workspace setups. Assert the DEFAULT specifically, because
    // getting this wrong is invisible until someone upgrades.
    await expect(accessSelect(page)).toHaveValue('all');
    // The peer-workspace checkboxes belong to `specific` only.
    await expect(page.locator('.agent-form-ws-row')).toHaveCount(0);
});

test('`specific` reveals peer workspaces and round-trips through sqlite', async () => {
    await accessSelect(page).selectOption('specific');

    // The other seeded workspace is offered — and this workspace is NOT (a
    // workspace never admits itself; same-workspace access is implicit).
    const rows = page.locator('.agent-form-ws-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(peerName);

    await rows.first().locator('input[type="checkbox"]').check();
    await expect(rows.first().locator('input[type="checkbox"]')).toBeChecked();

    // Reload so the panel re-reads from the main process. This is the assertion
    // that actually proves persistence — the optimistic UI update would look
    // identical without a single byte reaching the database.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await expect(accessSelect(page)).toHaveValue('specific');
    const afterReload = page.locator('.agent-form-ws-row input[type="checkbox"]');
    await expect(afterReload).toHaveCount(1);
    await expect(afterReload.first()).toBeChecked();
});

test('narrowing away from `specific` clears the allow-list, not just hides it', async () => {
    // Guards a real trap: if the ACL were merely hidden while `access !== specific`,
    // a later widen back to `specific` would silently resurrect a stale allow-list
    // the user believed they had discarded. setWorkspaceAgentAccess stores NULL
    // unless access === 'specific'; this proves that end to end.
    await accessSelect(page).selectOption('specific');
    await page.locator('.agent-form-ws-row input[type="checkbox"]').first().check();

    await accessSelect(page).selectOption('self');
    await expect(page.locator('.agent-form-ws-row')).toHaveCount(0);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(accessSelect(page)).toHaveValue('self');

    // Widen back — the previously-checked peer must NOT come back checked.
    await accessSelect(page).selectOption('specific');
    const boxes = page.locator('.agent-form-ws-row input[type="checkbox"]');
    await expect(boxes).toHaveCount(1);
    await expect(boxes.first()).not.toBeChecked();
});
