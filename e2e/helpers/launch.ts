import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * Boot the compiled Genie Electron app in E2E mode and return the app handle +
 * its first window (the harness window opened by background.ts when GENIE_E2E=1).
 *
 * Launch invocation (the working one for this Nextron app):
 *
 *   electron.launch({
 *     args: ['<repo>/app/background.js'],      // the built main entry (package.json "main")
 *     env: { ...process.env, NODE_ENV: 'production', GENIE_E2E: '1' },
 *   })
 *
 * NODE_ENV=production makes the main process load the renderer from the static
 * export (app/*.html via file://) rather than http://localhost:8888 — so no dev
 * server is required. GENIE_E2E=1 (a) overrides the GitHub + Issue Watch IPC
 * with the scriptable mock and (b) opens the e2e-issuewatch harness window.
 *
 * Prereq: the app must be built first (`npm run build:e2e`, which the
 * `test:e2e` script runs ahead of `playwright test`).
 */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const MAIN_ENTRY = path.join(REPO_ROOT, 'app', 'background.js');

/**
 * Which harness window to open. `issuewatch` mounts the IssueWatchFlyout (the
 * default — back-compat with the existing spec); `ghcaps` mounts the
 * GithubCapabilitiesFlyout (per-install resolve flow). Maps to `GENIE_E2E_PAGE`,
 * which `showE2EWindow` (background.ts) reads to pick the route.
 */
export type E2EHarnessPage = 'issuewatch' | 'ghcaps';

export async function launchGenieE2E(
    harness: E2EHarnessPage = 'issuewatch',
): Promise<{
    app: ElectronApplication;
    page: Page;
}> {
    const app = await electron.launch({
        args: [MAIN_ENTRY],
        env: {
            ...process.env,
            NODE_ENV: 'production',
            GENIE_E2E: '1',
            GENIE_E2E_PAGE:
                harness === 'ghcaps' ? 'e2e-ghcaps' : 'e2e-issuewatch',
        },
    });
    // The harness window is opened on app.whenReady(); wait for it.
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    return { app, page };
}

/**
 * Mutate the scriptable mock state from the MAIN process. The callback runs in
 * the Electron main context where `globalThis.__GENIE_E2E__` (set by
 * registerE2EMocks) exposes the live state object. Pass a plain function body;
 * `arg` is forwarded as the second param.
 *
 * Example — flip the device flow to success:
 *   await scriptMock(app, () => {
 *     globalThis.__GENIE_E2E__.state.github.flow = {
 *       kind: 'success',
 *       user: { login: 'wishborn', name: null, avatar_url: '' },
 *     };
 *   });
 */
export async function scriptMock<T = void>(
    app: ElectronApplication,
    fn: (electronApp: unknown, arg: T) => void,
    arg?: T,
): Promise<void> {
    // electronApp.evaluate runs `fn` in main with the electron module as the
    // first arg; we reach the mock via the global handle inside fn.
    await app.evaluate(fn as never, arg as never);
}

/** Read the current mock state snapshot from the main process. */
export async function readMockState(app: ElectronApplication): Promise<{
    calls: { githubStatus: number; deviceStart: number; recheck: number };
    openedUrls: string[];
    githubFlowKind: string;
}> {
    return app.evaluate(() => {
        const s = (globalThis as Record<string, any>).__GENIE_E2E__.state;
        return {
            calls: { ...s.calls },
            openedUrls: [...s.openedUrls],
            githubFlowKind: s.github.flow.kind,
        };
    });
}
