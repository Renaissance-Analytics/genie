import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * The Tynn MCP health indicator on the sidebar logo, against the REAL compiled
 * app (harness page `e2e-tynn-health`, which mounts the shipped component and
 * the real classifier).
 *
 * The classifier's judgement and every sentence it writes are unit-tested. What
 * only a browser can prove is that those sentences REACH THE SCREEN: that the
 * Fancy Popover really opens on hover, that the tint really lands on the logo,
 * and that clicking really asks for a re-check. The bug this feature exists for
 * was invisible for exactly that kind of reason — the information existed, and
 * nothing surfaced it.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('tynn-health'));
});

test.afterAll(async () => {
    await app?.close();
});

const indicator = () => page.locator('.tynn-health');
const popover = () => page.locator('.tynn-health-pop');
const scenario = (name: string) => page.getByTestId(`scenario-${name}`);

test('a healthy workspace shows a green light and lists what the token may call', async () => {
    await scenario('healthy').click();
    await expect(indicator()).toHaveClass(/tynn-health-ok/);

    await indicator().hover();
    await expect(popover()).toBeVisible();
    // The permission surface IS the tool list — it has to be readable, not just counted.
    await expect(popover()).toContainText('3 tools available');
    await expect(popover()).toContainText('project, find, create');
    await expect(popover()).toContainText('https://tynn.ai/mcp/tynn');
});

test('the http:// redirect reads RED and the popover names the cause and the fix', async () => {
    // The incident: `http://` → 301 → the client follows it as a GET → laravel/mcp
    // answers 405 → every agent in the workspace is toolless, and all the user
    // ever saw was "error 405". If this assertion ever loosens, that returns.
    await scenario('redirect').click();
    await expect(indicator()).toHaveClass(/tynn-health-bad/);

    await indicator().hover();
    await expect(popover()).toBeVisible();
    await expect(popover()).toContainText('301');
    await expect(popover()).toContainText('405');
    await expect(popover()).toContainText('GET');
    // The FIX, spelled out — not a diagnosis the reader has to act on blind.
    await expect(popover()).toContainText('.mcp.json');
    await expect(popover()).toContainText('https://tynn.ai/mcp/tynn');
});

test('the tooltip alone diagnoses it, without opening anything', async () => {
    await scenario('redirect').click();
    // Hover is a mouse; a title carries the same diagnosis to anyone who cannot.
    await expect(indicator()).toHaveAttribute('title', /405/);
    await expect(indicator()).toHaveAttribute('aria-label', /405/);
});

test('a rejected token is its own state — the endpoint row stays green', async () => {
    await scenario('unauthorized').click();
    await expect(indicator()).toHaveClass(/tynn-health-bad/);

    await indicator().hover();
    await expect(popover()).toBeVisible();
    // Endpoint fine, token not: the whole reason these are separate rows.
    await expect(popover()).toContainText('Reached tynn.ai');
    await expect(popover()).toContainText('Token rejected (401)');
    await expect(popover()).toContainText(/reconnect/i);
});

test('clicking the logo asks for a re-check', async () => {
    await scenario('healthy').click();
    await expect(page.getByTestId('recheck-count')).toHaveText('0');
    await indicator().click();
    await expect(page.getByTestId('recheck-count')).toHaveText('1');
});
