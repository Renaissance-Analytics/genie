import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
    launchGenieE2E,
    readAgentManagerPersonaFile,
    readAgentManagerSeed,
    type AgentManagerSeed,
} from './helpers/launch';

/**
 * E2E for the AGENT MANAGER — Tynn #709, story #263.
 *
 * WHY THIS EXISTS: the unit suite pins the pure decisions — `applyPersonaEdit`
 * carries an unknown header key, `agentMcpServers` reads the right file per TUI,
 * `mcpRemovalGuard` refuses `genie`. None of that says whether a person pressing
 * Save changes a single byte on disk. The chain in between — real `AGENT.md` →
 * `parseAgentFile` → IPC → preload → renderer → edit → IPC → `renderAgentFile` →
 * real file — is only exercised here.
 *
 * And the failure it guards against is specifically invisible: a renderer that
 * kept the edit in React state and never wrote it looks EXACTLY like one that
 * saved. So the load-bearing assertions read the FILE, not the DOM.
 *
 * Nothing is mocked. `seedAgentManagerE2E` (main/e2e/agent-manager.ts) writes a
 * real workspace with a real `AGENT.md` carrying `model: opus` — a header key
 * Genie has no field for — and a real `.mcp.json` with `genie` plus two
 * ordinary servers.
 */

let app: ElectronApplication;
let page: Page;
let seed: AgentManagerSeed;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('agent-manager'));
    const found = await readAgentManagerSeed(app);
    if (!found) throw new Error('agent-manager harness never published its seed');
    seed = found;
});

test.afterAll(async () => {
    await app?.close();
});

const tab = (p: Page, id: string) => p.locator(`[data-testid="agent-manager-tab-${id}"]`);
const body = (p: Page) => p.locator('[data-testid="agent-manager-body"]');
const purpose = (p: Page) => p.locator('[data-testid="agent-manager-purpose"]');
const save = (p: Page) => p.locator('[data-testid="agent-manager-save"]');
const mcpRows = (p: Page) => p.locator('[data-testid="agent-manager-mcp-row"]');

test('the surface the owner asked for is actually there', async () => {
    // The complaint: *Agent settings — moic* offered a driver picker, a purpose
    // field and two checkboxes. Prompt, MCP and sidecar were the gap.
    await expect(page.locator('[data-testid="e2e-error"]')).toHaveCount(0);
    await expect(tab(page, 'identity')).toBeVisible();
    await expect(tab(page, 'prompt')).toBeVisible();
    await expect(tab(page, 'mcp')).toBeVisible();
    await expect(tab(page, 'sidecar')).toBeVisible();
});

test('the prompt tab opens the agent’s real AGENT.md', async () => {
    await tab(page, 'prompt').click();
    await expect(body(page)).toHaveValue(/You are moic\. Original prompt\./);
    await expect(purpose(page)).toHaveValue('agent management');
    // Save is DISABLED until something is typed: opening a file must not offer
    // to rewrite it.
    await expect(save(page)).toBeDisabled();
});

test('★ an edit round-trips to disk WITHOUT mangling what it did not touch', async () => {
    await tab(page, 'prompt').click();

    await body(page).fill('You are moic. Edited by the manager.\n');
    await purpose(page).fill('the agent management surface');
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(page.locator('[data-testid="agent-manager-saved"]')).toBeVisible();
    await expect(page.locator('[data-testid="agent-manager-error"]')).toHaveCount(0);

    // THE assertion. Read the bytes, not the textarea — the textarea would show
    // the edit whether or not a single byte reached the filesystem.
    const onDisk = await readAgentManagerPersonaFile(app);
    expect(onDisk).toContain('You are moic. Edited by the manager.');
    expect(onDisk).toContain('purpose: the agent management surface');
    // The edit did not eat what it was not asked to change: the header key the
    // UI does not render, and the fields it does but nobody touched.
    expect(onDisk).toContain(seed.unrenderedLine);
    expect(onDisk).toContain(`name: ${seed.agentName}`);
    expect(onDisk).toContain('tuis: [claude, codex]');
    expect(onDisk).not.toContain('Original prompt');

    // And the surface re-reads it, so what is on screen is what is on disk.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await tab(page, 'prompt').click();
    await expect(body(page)).toHaveValue(/Edited by the manager/);
    await expect(purpose(page)).toHaveValue('the agent management surface');
    await expect(save(page)).toBeDisabled();
});

test('the MCP tab lists the servers this agent actually gets', async () => {
    await tab(page, 'mcp').click();
    // The seed writes exactly three, and this agent's TUI is claude → .mcp.json.
    await expect(mcpRows(page)).toHaveCount(3);
    await expect(mcpRows(page).filter({ hasText: 'genie' })).toHaveCount(1);
    await expect(mcpRows(page).filter({ hasText: 'playwright' })).toHaveCount(1);
    // A stdio server shows its command rather than an empty cell.
    await expect(mcpRows(page).filter({ hasText: 'playwright' })).toContainText(
        'npx @playwright/mcp',
    );
});

test('★ removing the genie server is REFUSED, and says why', async () => {
    await tab(page, 'mcp').click();
    const genieRow = mcpRows(page).filter({ hasText: 'genie' }).first();
    const remove = genieRow.locator('[data-testid="agent-manager-mcp-remove"]');
    await expect(remove).toBeDisabled();
    // Not a silent disable — the reason is on the control.
    await expect(remove).toHaveAttribute('title', /cannot reach you/i);
});

test('★ POSITIVE CONTROL: an ordinary server CAN be removed, and really goes', async () => {
    // Without this the test above passes on a surface where every Remove is
    // dead — which is a different bug wearing the same clothes.
    await tab(page, 'mcp').click();
    const fetchRow = mcpRows(page).filter({ hasText: 'fetch' }).first();
    await fetchRow.locator('[data-testid="agent-manager-mcp-remove"]').click();

    await expect(page.locator('[data-testid="agent-manager-error"]')).toHaveCount(0);
    // Re-read from main, which re-reads `.mcp.json`. An optimistic UI update
    // would look identical without a byte reaching the file.
    await expect(mcpRows(page)).toHaveCount(2);
    await expect(mcpRows(page).filter({ hasText: 'fetch' })).toHaveCount(0);
    await expect(mcpRows(page).filter({ hasText: 'genie' })).toHaveCount(1);
});

test('the sidecar tab finds the agent’s sidecar', async () => {
    await tab(page, 'sidecar').click();
    const summary = page.locator('[data-testid="agent-manager-sidecar-summary"]');
    await expect(summary).toContainText(seed.sidecarName);
    // Seeded dormant, so the only control is Start — a dormant sidecar must not
    // offer Stop, and a running one must not offer Start into a second copy.
    await expect(summary).toContainText(/not running/i);
    await expect(page.locator('button', { hasText: 'Start sidecar' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Stop sidecar' })).toHaveCount(0);
});
