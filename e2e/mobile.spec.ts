import {
    test,
    expect,
    chromium,
    request as playwrightRequest,
    type Browser,
    type Page,
    type ElectronApplication,
} from '@playwright/test';
import { launchGenieMobileE2E } from './helpers/launch';

/**
 * E2E test for Genie's MOBILE remote-control feature — the LAST verification
 * layer: a real browser driving the ACTUALLY-SERVED mobile page against the live
 * in-process mobile server.
 *
 * Unlike the issuewatch/ghcaps specs (which drive an Electron harness window over
 * IPC), this one ignores the desktop window entirely. The Electron main process
 * brings the REAL mobile server up on 127.0.0.1 at a fixed port + PIN with mock
 * data deps (see main/e2e/mock.ts `startMobileE2EServer`, gated on
 * GENIE_E2E_MOBILE). We then point a PLAIN chromium browser at
 * `http://127.0.0.1:<port>/m/?pair=<pin>` — exactly what a paired phone loads
 * over Tailscale, with NO Electron preload — and drive the full flow:
 *
 *   Pair → Dashboard (workspace + process, start) → Questions (answer) →
 *   Terminal (attach + scrollback) → security (401 on unauthed + wrong-pin).
 *
 * The server, REST routing, token auth, kill-switch guard, WS upgrade + Origin/
 * token gate, static serving, and the served React UI are all the REAL code —
 * only the data deps (workspace/process/terminal/question) are mocked.
 */

let app: ElectronApplication;
let browser: Browser;
let page: Page;
let port: number;
let pin: string;
let scrollback: string;
let terminalId: string;
let baseUrl: string;

test.beforeAll(async () => {
    ({ app, port, pin, scrollback, terminalId } = await launchGenieMobileE2E());
    baseUrl = `http://127.0.0.1:${port}`;
    browser = await chromium.launch();
    page = await browser.newPage();
});

test.afterAll(async () => {
    await browser?.close();
    await app?.close();
});

test('mobile remote control: pair → dashboard → questions → terminal', async () => {
    // ---- PAIR -------------------------------------------------------------
    // Load the page the QR encodes: `/m/?pair=<pin>`. PairScreen auto-fills the
    // PIN from the query, so the input arrives pre-populated.
    await page.goto(`${baseUrl}/m/?pair=${pin}`);

    const pinInput = page.locator('.m-pin-input');
    await expect(pinInput).toHaveValue(pin);

    // Submit → POST /api/pair → the desktop auto-confirms (mock confirmPair) →
    // a token is minted + stored, and the shell advances past the pair screen.
    await page.getByRole('button', { name: 'Pair this device' }).click();

    // Past the pair screen: the bottom nav (Dashboard/Questions/Terminal) only
    // renders once booted against /api/state.
    await expect(page.locator('.m-nav')).toBeVisible();
    await expect(page.getByText('Pair with Genie')).toHaveCount(0);

    // ---- DASHBOARD --------------------------------------------------------
    // The seeded workspace + process render from the /api/state bootstrap.
    // (Exact match: the workspace name also appears inside the process subtitle
    // "Mobile E2E · stopped".)
    await expect(page.getByText('Mobile E2E', { exact: true })).toBeVisible();
    await expect(page.getByText('E2E dev server')).toBeVisible();

    // The process starts 'stopped' → a Start control is shown. Clicking it POSTs
    // /api/process/:id/start; the server flips status + pushes process:status,
    // so the row reconciles to a running state (Stop/Restart controls appear).
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();

    // ---- QUESTIONS --------------------------------------------------------
    // The Questions nav badge reflects the ONE seeded ForceTheQuestion.
    await page.getByRole('button', { name: /Questions/ }).click();

    // The seeded question renders exactly like ask.tsx — header chip + prompt +
    // option chips + a note field.
    await expect(
        page.getByText('Ship the mobile build to production?'),
    ).toBeVisible();

    // Pick an option, then Submit → POST /api/questions/:id/answer → the request
    // is removed and the empty state shows.
    await page.getByRole('button', { name: /Ship it/ }).click();
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByText('No questions waiting.')).toBeVisible();

    // ---- TERMINAL ---------------------------------------------------------
    // Open the Terminal tab → the seeded terminal is listed.
    await page.getByRole('button', { name: /Terminal/ }).click();
    const termRow = page.getByRole('button', { name: /E2E terminal/ });
    await expect(termRow).toBeVisible();

    // Pick it → MobileTerminalView mounts + opens /ws/term. Assert the WS upgrade
    // actually happened (the byte bridge connected). We DON'T assert xterm's
    // canvas contents (it renders the scrollback banner off-DOM) — just that the
    // viewer mounted and the socket connected, which is the integration point.
    const wsPromise = page.waitForEvent('websocket', {
        predicate: (ws) => ws.url().includes('/ws/term'),
        timeout: 10_000,
    });
    await termRow.click();

    const ws = await wsPromise;
    expect(ws.url()).toContain(`terminal=${terminalId}`);
    // The terminal viewer's header shows the terminal label once mounted.
    await expect(page.locator('.m-term-bar')).toContainText('E2E terminal');
    // The scrollback banner the server sends on attach is non-empty (sanity on
    // the fixture wiring; the bytes land in xterm's canvas, asserted indirectly).
    expect(scrollback.length).toBeGreaterThan(0);
});

test('mobile security surface: unauthed + wrong-PIN are rejected', async () => {
    const api = await playwrightRequest.newContext();

    // An UNPAIRED request (no Bearer token) to a protected route is 401.
    const state = await api.get(`${baseUrl}/api/state`);
    expect(state.status()).toBe(401);

    // /api/pair with the WRONG pin is 401 (incorrect PIN). A correct-shaped but
    // wrong 6-digit pin exercises the constant-time compare + rate limiter path.
    const wrongPin = pin === '000000' ? '111111' : '000000';
    const pair = await api.post(`${baseUrl}/api/pair`, {
        data: { pin: wrongPin },
    });
    expect(pair.status()).toBe(401);

    await api.dispose();
});
