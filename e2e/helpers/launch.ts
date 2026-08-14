import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';

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
 * A throwaway userData profile for E2E runs. Electron honours `--user-data-dir`,
 * so passing this isolates the test app's ENTIRE profile (settings DB, GitHub
 * token, everything) from the developer's REAL Genie install. Without it, the
 * harness booted the real app against the real GitHub token — and the real
 * issue-watch poller (registered unconditionally at boot) could mutate the real
 * auth state (e.g. flag a reauth on a transient hiccup). Never reuse the real
 * profile in tests.
 */
export const E2E_USERDATA = path.join(os.tmpdir(), 'genie-e2e-profile');

/**
 * Which harness window to open. `issuewatch` mounts the IssueWatchFlyout (the
 * default — back-compat with the existing spec); `ghcaps` mounts the
 * GithubCapabilitiesFlyout (per-install resolve flow); `picker-layer` mounts the
 * real AddWorkspaceModal so the file picker can be opened from inside it;
 * `hosting` mounts the real Hosting Manager settings section + the real
 * per-workspace Hosting panel. Maps to `GENIE_E2E_PAGE`, which `showE2EWindow`
 * (background.ts) reads to pick the route.
 */
export type E2EHarnessPage =
    | 'issuewatch'
    | 'ghcaps'
    | 'agent-access'
    | 'picker-layer'
    | 'hosting'
    | 'repo-panel'
    | 'terminal-recovery'
    | 'tynn-health';

const HARNESS_ROUTE: Record<E2EHarnessPage, string> = {
    issuewatch: 'e2e-issuewatch',
    ghcaps: 'e2e-ghcaps',
    'agent-access': 'e2e-agent-access',
    'picker-layer': 'e2e-picker-layer',
    hosting: 'e2e-hosting',
    'repo-panel': 'e2e-repo-panel',
    'terminal-recovery': 'e2e-terminal-recovery',
    'tynn-health': 'e2e-tynn-health',
};

export async function launchGenieE2E(
    harness: E2EHarnessPage = 'issuewatch',
): Promise<{
    app: ElectronApplication;
    page: Page;
}> {
    const app = await electron.launch({
        args: [MAIN_ENTRY, `--user-data-dir=${E2E_USERDATA}`],
        env: {
            ...process.env,
            NODE_ENV: 'production',
            GENIE_E2E: '1',
            GENIE_E2E_PAGE: HARNESS_ROUTE[harness],
            // Containers are mocked ONLY for the hosting harness — every other
            // spec keeps the real `dev:*` handlers (main/e2e/hosting.ts).
            GENIE_E2E_HOSTING: harness === 'hosting' ? '1' : '',
        },
    });
    // The harness window is opened on app.whenReady(); wait for it.
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    return { app, page };
}

/**
 * The Hosting Manager fixture's handle in MAIN (`main/e2e/hosting.ts`).
 *
 * `calls` is the half the DOM cannot show: a confirm dialog that fires the stop
 * anyway looks identical on screen to one that waits for the confirmation, and
 * only the call log tells them apart.
 */
export async function readHostingState(app: ElectronApplication): Promise<{
    calls: {
        workstation: number;
        engine: string[];
        site: string[];
        service: string[];
        toolchainUpdate: string[];
        toolchainSetDefault: string[];
        toolchainRemove: string[];
    };
    runtimeKind: string;
    siteNames: string[];
} | null> {
    return app.evaluate(() => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_HOSTING__;
        if (!h) return null;
        return {
            calls: {
                workstation: h.state.calls.workstation,
                engine: [...h.state.calls.engine],
                site: [...h.state.calls.site],
                service: [...h.state.calls.service],
                toolchainUpdate: [...h.state.calls.toolchainUpdate],
                // This projection is a hand-written subset, so a `calls` field
                // added to the harness and NOT added here silently reads as
                // "nothing reached main" — the spec then fails against a
                // perfectly working button. (`e2e/` is outside both typecheck
                // projects, so nothing flags the missing key either.)
                toolchainSetDefault: [...h.state.calls.toolchainSetDefault],
                toolchainRemove: [...h.state.calls.toolchainRemove],
            },
            runtimeKind: h.state.workstation.runtime.kind,
            siteNames: h.state.sites.map((s: { name: string }) => s.name),
        };
    });
}

export interface E2ESeedSite {
    id: string;
    name: string;
    genName: string;
    repo: string;
    runMode: string;
    kind: 'http' | 'tcp';
    enabled: boolean;
    state: string;
    ready?: boolean;
    port?: number;
    hostPort?: number;
    hostServe?: { mode: 'static' | 'php'; root: string; spa?: boolean };
    browserExposed?: boolean;
}

/** Seed the hosting fixture's site list (story #238 toggle E2E), then push a
 *  `dev-server:changed` so the panel repaints. Cleared by {@link resetHosting}. */
export async function seedHostingSites(
    app: ElectronApplication,
    sites: E2ESeedSite[],
): Promise<void> {
    await app.evaluate((_e, seed) => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_HOSTING__;
        if (!h) return;
        h.state.sites = seed;
        h.notifyChanged?.();
    }, sites);
}

/** Read the hosting fixture's sites back — to assert an edit PERSISTED what the
 *  DOM only implied (e.g. the browserExposed the toggle sends). */
export async function readHostingSites(app: ElectronApplication): Promise<
    Array<{
        id: string;
        name: string;
        runMode: string;
        hostPort?: number;
        hostServe?: { mode: 'static' | 'php'; root: string; spa?: boolean };
        browserExposed?: boolean;
    }>
> {
    return app.evaluate(() => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_HOSTING__;
        return (h?.state.sites ?? []).map((s: Record<string, unknown>) => ({
            id: s.id as string,
            name: s.name as string,
            runMode: s.runMode as string,
            hostPort: s.hostPort as number | undefined,
            hostServe: s.hostServe as
                | { mode: 'static' | 'php'; root: string; spa?: boolean }
                | undefined,
            browserExposed: s.browserExposed as boolean | undefined,
        }));
    });
}

/** Restore the hosting fixture to its defaults — every test starts from the
 *  same machine, whatever the one before it started or stopped. */
export async function resetHosting(app: ElectronApplication): Promise<void> {
    await app.evaluate(() => {
        (globalThis as Record<string, any>).__GENIE_E2E_HOSTING__?.reset();
    });
}

/**
 * Take the container runtime away mid-session and PUSH the change, without a
 * reload. Proves the surfaces repaint from `dev-server:changed` rather than
 * only at mount — a frozen page is invisible in a screenshot and fatal in use.
 */
export async function hostingRuntimeUnavailable(app: ElectronApplication): Promise<void> {
    await app.evaluate(() => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_HOSTING__;
        h.runtimeUnavailable();
        h.notifyChanged();
    });
}

/**
 * Boot Genie in MOBILE-server E2E mode (GENIE_E2E + GENIE_E2E_MOBILE). The main
 * process brings up the REAL mobile server on 127.0.0.1 at a fixed port + PIN
 * with mock data deps (see main/e2e/mock.ts `startMobileE2EServer`). The desktop
 * harness window is irrelevant here — the spec drives the SERVED `/m/` page over
 * a plain chromium browser — but a window still opens so `firstWindow()` resolves
 * and we know main is ready. `GENIE_E2E_USERDATA` isolates the auth/audit files.
 *
 * Returns the app handle plus the bound port + PIN read back from the main
 * process's global handle, so the spec hits the exact running instance.
 */
export async function launchGenieMobileE2E(): Promise<{
    app: ElectronApplication;
    page: Page;
    port: number;
    pin: string;
    scrollback: string;
    terminalId: string;
}> {
    const app = await electron.launch({
        args: [MAIN_ENTRY, `--user-data-dir=${E2E_USERDATA}`],
        env: {
            ...process.env,
            NODE_ENV: 'production',
            GENIE_E2E: '1',
            GENIE_E2E_MOBILE: '1',
            GENIE_E2E_USERDATA: '',
        },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Read the bound port/PIN the main process exposed once the server bound.
    const handle = await app.evaluate(async () => {
        const g = globalThis as Record<string, any>;
        // The server starts inside whenReady; poll briefly for the handle.
        for (let i = 0; i < 100 && !g.__GENIE_E2E_MOBILE__; i++) {
            await new Promise((r) => setTimeout(r, 50));
        }
        return g.__GENIE_E2E_MOBILE__ ?? null;
    });
    if (!handle) {
        await app.close();
        throw new Error('mobile E2E server never published its handle');
    }
    return {
        app,
        page,
        port: handle.port,
        pin: handle.pin,
        scrollback: handle.scrollback,
        terminalId: handle.terminalId,
    };
}

/**
 * Boot the real Electron Testing Browser against the deterministic tunnel
 * fixture owned by main/e2e/tunnel.ts. The fixture and proxy bind loopback-only
 * inside the disposable E2E process; no Herd, Tailscale installation, live
 * workstation, or developer profile is involved.
 */
export async function launchGenieTunnelE2E(): Promise<{
    app: ElectronApplication;
}> {
    const tunnelUserData = path.join(
        os.tmpdir(),
        `genie-e2e-tunnel-${process.pid}-${Date.now()}`,
    );
    const app = await electron.launch({
        args: [MAIN_ENTRY, `--user-data-dir=${tunnelUserData}`],
        env: {
            ...process.env,
            NODE_ENV: 'production',
            GENIE_E2E: '1',
            GENIE_E2E_TUNNEL: '1',
            GENIE_E2E_USERDATA: '',
        },
    });
    return { app };
}

export interface TunnelProbe {
    /** Set by the MAIN process, not the page: true once every capability leg has
     *  been observed working over the tunnel (or the harness's convergence
     *  deadline expired, so the spec fails with the real residual state rather
     *  than an opaque poll timeout). See main/e2e/tunnel-legs.ts. */
    ready: boolean;
    /** True while a probe pass is mid-flight (the flags are partial). */
    running: boolean;
    /** Legs that failed at least once before succeeding — surfaced by the spec so
     *  a genuinely intermittent tunnel stays visible. */
    recovered: string[];
    transport?: 'tailscale';
    origin: string;
    absoluteScript: boolean;
    absoluteStyle: boolean;
    bearer: {
        ok: boolean;
        authorization: string | null;
    };
    cookie: boolean;
    redirect: {
        ok: boolean;
        url: string;
    };
    stream: boolean;
    websocket: boolean;
    vite: {
        manifest: boolean;
        module: boolean;
        sourceMap: boolean;
        hmr: boolean;
        debugger: boolean;
    };
    next: {
        module: boolean;
        sourceMap: boolean;
        fastRefresh: boolean;
    };
    reverb: boolean;
    errors: string[];
}

/** Read the browser-content probe published by the E2E tunnel harness. */
export async function readTunnelProbe(app: ElectronApplication): Promise<TunnelProbe | null> {
    return app.evaluate(() => {
        const handle = (globalThis as Record<string, any>).__GENIE_E2E_TUNNEL__;
        return handle?.probe ?? null;
    });
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

/**
 * Read the agent-access fixture the `e2e-agent-access` harness seeded (see
 * main/e2e/agent-access.ts). Returns null if seeding never ran, so the spec can
 * fail with a clear cause rather than asserting against undefined names.
 */
export async function readAgentAccessSeed(app: ElectronApplication): Promise<{
    workspaceId: string;
    workspaceName: string;
    peerId: string;
    peerName: string;
} | null> {
    return app.evaluate(() => {
        return (
            ((globalThis as Record<string, any>).__GENIE_E2E_AGENT_ACCESS__ as {
                workspaceId: string;
                workspaceName: string;
                peerId: string;
                peerName: string;
            }) ?? null
        );
    });
}

/**
 * Read the MCP server-push handle the booted app publishes under E2E — its live
 * workspace endpoint URL plus hooks to drive a REAL broker delivery and read the
 * push diagnostics. Returns null when the app never published it (which is
 * exactly the failure the server-push spec must catch: no boot wiring).
 */
export async function readMcpPushHandle(app: ElectronApplication): Promise<{
    endpointUrl: string;
} | null> {
    return app.evaluate(() => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_MCP__;
        return h ? { endpointUrl: h.endpointUrl as string } : null;
    });
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
