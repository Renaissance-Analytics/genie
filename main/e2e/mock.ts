/**
 * E2E test mode — scriptable GitHub + Issue Watch IPC, gated on GENIE_E2E.
 *
 * WHY THIS EXISTS
 * ---------------
 * Genie's renderer-interaction bugs (e.g. the device-flow reconnect where the
 * user code vanished on the first `github:status` poll) can't be caught by
 * vitest (no DOM / no running app) or typecheck. They only surface when the
 * real component drives the real IPC surface. This module lets a Playwright
 * Electron test DRIVE that surface deterministically — without hitting GitHub,
 * OAuth, the OS keychain, or a seeded DB.
 *
 * HOW IT'S WIRED
 * --------------
 * `isE2E()` is true ONLY when `process.env.GENIE_E2E === '1'`. background.ts
 * calls `registerE2EMocks()` AFTER the real registrations when E2E is on. For
 * each channel it owns, the mock `removeHandler()`s the real one first, then
 * re-`handle()`s it — so it OVERRIDES production regardless of registration
 * order and the wiring stays in this one file. In a normal run `isE2E()` is
 * false, `registerE2EMocks()` is never called, and this file has ZERO effect on
 * behaviour.
 *
 * HOW A TEST SCRIPTS IT
 * ---------------------
 * The test mutates `e2eState` from the MAIN process via Playwright's
 * `electronApp.evaluate(...)`, reaching this module through a global handle set
 * by {@link registerE2EMocks}. The mocked `ipcMain.handle` responders read the
 * live state on every call, so the test can:
 *   - seed a dead stored session (connected:true + needsReauth + a 401 detail),
 *   - start a device flow that stays `flow.kind:'pending'` across several
 *     `github:status` polls (connected stays true the whole time — the exact
 *     regression condition),
 *   - flip `flow.kind` to `'success'` on cue and watch the feed recover.
 *
 * The state shape mirrors the real handlers' return contracts (see
 * main/github/ipc.ts `github:status`, main/issue-watch/index.ts
 * `issue-watch:status`, and the renderer's lib/genie.ts types) so the component
 * under test sees byte-identical payloads to production.
 */

import { ipcMain } from 'electron';
import os from 'node:os';
import { startMobileServer } from '../mobile/server';
import { currentPin, _setPinForTest } from '../mobile/auth';
import {
    _seedPendingQuestionForTest,
    listPendingQuestions,
    answerPendingQuestion,
} from '../ask/force-question';
import type { MobileDataDeps } from '../mobile/api';

/** True only in E2E test mode. Everything in this module no-ops otherwise. */
export function isE2E(): boolean {
    return process.env.GENIE_E2E === '1';
}

/** True when the mobile-server E2E harness is requested (GENIE_E2E_MOBILE=1). */
export function isE2EMobile(): boolean {
    return isE2E() && process.env.GENIE_E2E_MOBILE === '1';
}

type FlowStatus =
    | { kind: 'idle' }
    | { kind: 'pending'; userCode: string; verificationUri: string; expiresInSec: number }
    | { kind: 'success'; user: { login: string; name: string | null; avatar_url: string } }
    | { kind: 'error'; code: string; message: string };

interface WatchErrorDetail {
    error: 'unauthenticated' | 'forbidden' | 'not_found' | 'rate_limited' | 'unknown';
    status?: number;
    message?: string;
}

interface WatchRepoView {
    owner: string;
    repo: string;
    enabled: boolean;
    unread: number;
    error: WatchErrorDetail['error'] | null;
    detail: WatchErrorDetail | null;
}

interface WatchFeedItem {
    kind: 'issue' | 'pr' | 'dependabot';
    key: string;
    number: number | null;
    title: string;
    url: string;
    updatedAt: string;
    owner: string;
    repo: string;
    unread?: boolean;
    severity?: string;
}

interface MissingInstallation {
    login: string;
    installationId: number | null;
    isOrg: boolean;
    reviewUrl: string;
}

interface MissingPermissionGroup {
    permission: string;
    access: string;
    installations: MissingInstallation[];
}

interface GithubCapabilities {
    connected: boolean;
    satisfiedFeatures: string[];
    missing: string[];
    missingPermissions: string[];
    /** Per missing permission, the installs not granting it (each w/ review URL). */
    missingByPermission: MissingPermissionGroup[];
    /** Deep-link to the App's permission settings (where the owner adds a perm). */
    appPermissionsUrl: string;
    checked: boolean;
}

/**
 * The scriptable surface. A test reads/writes this object from the main process
 * via `electronApp.evaluate(() => { ... globalThis.__GENIE_E2E__.state ... })`.
 * Defaults model the BUG'S starting point: a stored-but-dead session
 * (connected, needs reauth, last read was a 401) with one watched repo.
 */
export interface E2EState {
    github: {
        connected: boolean;
        username: string | null;
        needsReauth: boolean;
        flow: FlowStatus;
        capabilities: GithubCapabilities;
    };
    issueWatch: {
        /** Per-workspace status returned by `issue-watch:status`. */
        status: {
            connected: boolean;
            error: WatchErrorDetail['error'] | null;
            detail: WatchErrorDetail | null;
            needsReauth: boolean;
        };
        repos: WatchRepoView[];
        feed: WatchFeedItem[];
    };
    /** Call counters — let a test assert e.g. "status was polled ≥ N times". */
    calls: { githubStatus: number; deviceStart: number; recheck: number };
    /** External URLs the flyout tried to open (kept inert; recorded for asserts). */
    openedUrls: string[];
}

/** A fresh default state for the dead-session reconnect scenario. */
export function defaultE2EState(): E2EState {
    return {
        github: {
            // The stored token is still present (so `connected` is true) but it's
            // dead — needsReauth set, and reads come back 401. This is precisely
            // the state that made the old poll fire on the first tick.
            connected: true,
            username: 'wishborn',
            needsReauth: true,
            flow: { kind: 'idle' },
            capabilities: {
                connected: true,
                satisfiedFeatures: [
                    'issue-watch.issues',
                    'issue-watch.pulls',
                    'issue-watch.dependabot',
                ],
                missing: [],
                missingPermissions: [],
                missingByPermission: [],
                appPermissionsUrl:
                    'https://github.com/settings/apps/genie-ide/permissions',
                checked: true,
            },
        },
        issueWatch: {
            status: {
                connected: true,
                error: 'unauthenticated',
                detail: { error: 'unauthenticated', status: 401, message: 'Bad credentials' },
                needsReauth: true,
            },
            repos: [
                {
                    owner: 'wishborn',
                    repo: 'tynn-cli',
                    enabled: true,
                    unread: 0,
                    error: 'unauthenticated',
                    detail: { error: 'unauthenticated', status: 401, message: 'Bad credentials' },
                },
            ],
            feed: [],
        },
        calls: { githubStatus: 0, deviceStart: 0, recheck: 0 },
        openedUrls: [],
    };
}

/**
 * Capability state for the per-install RESOLVE scenario: `contents` (→
 * provisioning) missing, with TWO installs — a personal one that GRANTS it and
 * an org one that does NOT. Only the org install is listed for `contents`, each
 * with its own review URL, alongside the App-permission-settings deep-link. The
 * ghcaps E2E spec installs this, then reloads the harness so the flyout re-reads
 * it. (A pure data fixture — mirrors what capability-service.ts produces.)
 */
export function missingContentsCapabilities(): GithubCapabilities {
    return {
        connected: true,
        satisfiedFeatures: [
            'issue-watch.issues',
            'issue-watch.pulls',
            'issue-watch.dependabot',
        ],
        missing: ['github.provision'],
        missingPermissions: ['contents'],
        missingByPermission: [
            {
                permission: 'contents',
                access: 'write',
                installations: [
                    // The org install is the one MISSING contents → it's listed.
                    {
                        login: 'Renaissance-Analytics',
                        installationId: 2002,
                        isOrg: true,
                        reviewUrl:
                            'https://github.com/organizations/Renaissance-Analytics/settings/installations/2002',
                    },
                ],
            },
        ],
        appPermissionsUrl:
            'https://github.com/settings/apps/genie-ide/permissions',
        checked: true,
    };
}

/** The live scriptable state (only meaningful in E2E mode). */
export let e2eState: E2EState = defaultE2EState();

/** Reset to defaults — handy between tests sharing one Electron instance. */
export function resetE2EState(): void {
    e2eState = defaultE2EState();
    publishHandle();
}

/** Expose the state on a global so `electronApp.evaluate` can reach it. The
 *  scenario builders ride along so a spec can script a known capability shape
 *  (e.g. the per-install missing-`contents` resolve flow) without re-deriving it. */
function publishHandle(): void {
    (globalThis as Record<string, unknown>).__GENIE_E2E__ = {
        get state() {
            return e2eState;
        },
        reset: resetE2EState,
        missingContentsCapabilities,
    };
}

/**
 * Override-register the mocked GitHub + Issue Watch IPC handlers. Called by
 * background.ts AFTER the real registrations when {@link isE2E} is true. Each
 * channel is `removeHandler`'d (dropping the production owner, if any) then
 * re-`handle`'d, so the mock wins no matter the order. The channel set here is
 * exactly the subset the IssueWatchFlyout + useGithubCapabilities hook touch.
 */
export function registerE2EMocks(): void {
    publishHandle();

    /** Override a channel: drop any existing handler, then install the mock. */
    const override: typeof ipcMain.handle = (channel, listener) => {
        ipcMain.removeHandler(channel as string);
        ipcMain.handle(channel as string, listener as never);
    };

    // --- GitHub ----------------------------------------------------------
    override('github:status', async () => {
        e2eState.calls.githubStatus += 1;
        const g = e2eState.github;
        return {
            connected: g.connected,
            username: g.username,
            needsReauth: g.needsReauth,
            clientIdSet: true,
            builtInClientId: true,
            usingOverride: false,
            activeClientId: 'Iv1.e2e…dev',
            storageOk: true,
            flow: g.flow,
        };
    });

    override('github:device:start', async () => {
        e2eState.calls.deviceStart += 1;
        // Begin a pending flow. The test flips flow.kind to 'success'/'error'
        // when it wants the poll to complete; until then `connected` stays true
        // (dead token still stored) and the poll must NOT complete on that.
        e2eState.github.flow = {
            kind: 'pending',
            userCode: 'WXYZ-1234',
            verificationUri: 'https://github.com/login/device',
            expiresInSec: 900,
        };
        return {
            user_code: 'WXYZ-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
        };
    });

    override('github:device:cancel', async () => {
        e2eState.github.flow = { kind: 'idle' };
        return { ok: true };
    });

    override('github:recheck-capabilities', async () => {
        e2eState.calls.recheck += 1;
        return e2eState.github.capabilities;
    });

    override('github:capabilities', async () => e2eState.github.capabilities);
    override(
        'github:can-access',
        async (_e, key: string) =>
            e2eState.github.capabilities.satisfiedFeatures.includes(key),
    );

    // --- Issue Watch -----------------------------------------------------
    override('issue-watch:status', async () => e2eState.issueWatch.status);
    override('issue-watch:repos', async () => e2eState.issueWatch.repos);
    override('issue-watch:feed', async () => e2eState.issueWatch.feed);
    override('issue-watch:mark-seen', async () => ({ ok: true }));
    override('issue-watch:counts', async () => ({}));
    override('issue-watch:set', async () => ({ ok: true }));

    // --- Inert externals -------------------------------------------------
    // The flyout opens the verification URL in the OS browser on reconnect.
    // Record it and DO NOTHING — never launch a browser in a test.
    override('tynn:open-in-browser', async (_e, pathOrUrl: string) => {
        e2eState.openedUrls.push(pathOrUrl);
        return { ok: true };
    });
}

// ===========================================================================
// Mobile remote-control E2E harness (GENIE_E2E_MOBILE=1)
// ---------------------------------------------------------------------------
// Brings the REAL mobile server up on loopback (bindIpOverride) at a FIXED port
// with a KNOWN pin and an auto-confirming pairing hook, fed by an in-memory
// MobileDataDeps (one workspace, one process, one terminal). This lets a plain
// chromium browser drive the actually-served `/m/` page + REST + WS end-to-end
// without a tailnet, a real desktop modal, the DB, or node-pty. Inert unless the
// flag is set; the production startMobileServer call in background.ts is skipped
// in E2E (we own the singleton here).
// ===========================================================================

/** The fixed loopback port + PIN the mobile E2E spec drives. Deterministic. */
export const E2E_MOBILE_PORT = 51999;
export const E2E_MOBILE_PIN = '424242';

/** A seeded workspace / process / terminal for the mobile dashboard + terminal. */
const E2E_MOBILE_WORKSPACE = {
    id: 'ws-e2e-mobile',
    project_name: 'Mobile E2E',
    path: 'C:/e2e/mobile-workspace',
};
const E2E_MOBILE_TERMINAL_ID = 'term-e2e-mobile';
const E2E_MOBILE_PROCESS_ID = 'proc-e2e-mobile';
/** The catch-up banner getScrollback returns when the phone attaches /ws/term. */
export const E2E_MOBILE_SCROLLBACK = '*** genie mobile e2e terminal ***\r\n';

/**
 * In-memory state the mock deps mutate so process start/stop + terminal writes
 * have observable effects (status flips, byte echo) without touching real
 * supervisor / pty machinery.
 */
const mobileE2E = {
    processStatus: 'stopped' as
        | 'running'
        | 'stopped'
        | 'restarting'
        | 'crashed'
        | 'failed',
    terminalLive: true,
};

/**
 * Build the scriptable MobileDataDeps. Lazy-imports the bus + terminal-bridge
 * (mobileEmit / mobileTermFanout) so a process start can push `process:status`
 * to /ws/events and a terminal write can echo back down /ws/term — exercising
 * the real fan-out paths the phone UI consumes.
 */
function buildMobileE2EDeps(): MobileDataDeps {
    // Resolved from the SAME module the server uses, so the fan-out reaches the
    // live socket sets server.ts registered.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mobileEmit } = require('../mobile/bus') as typeof import('../mobile/bus');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mobileTermFanout } =
        require('../mobile/terminal-bridge') as typeof import('../mobile/terminal-bridge');

    const processRow = () => ({
        id: E2E_MOBILE_PROCESS_ID,
        kind: 'process' as const,
        label: 'E2E dev server',
        command: 'npm run dev',
        workspace: E2E_MOBILE_WORKSPACE.project_name,
        workspaceId: E2E_MOBILE_WORKSPACE.id,
        status: mobileE2E.processStatus,
        autostart: false,
    });
    const setProc = (status: typeof mobileE2E.processStatus) => {
        mobileE2E.processStatus = status;
        mobileEmit('process:status', { id: E2E_MOBILE_PROCESS_ID, status });
    };

    return {
        listWorkspaces: () => [E2E_MOBILE_WORKSPACE],
        listTerminalSpecs: () => [
            {
                id: E2E_MOBILE_TERMINAL_ID,
                workspace_id: E2E_MOBILE_WORKSPACE.id,
                label: 'E2E terminal',
                type: 'terminal',
                cwd: E2E_MOBILE_WORKSPACE.path,
                live_cwd: null,
            },
        ],
        listAllProcesses: () => [processRow()],
        liveTerminalIds: () =>
            mobileE2E.terminalLive ? [E2E_MOBILE_TERMINAL_ID] : [],

        startProcess: () => setProc('running'),
        stopProcess: () => setProc('stopped'),
        restartProcess: () => setProc('running'),

        createAgentTerminal: (opts) => ({
            id: `term-e2e-${Date.now()}`,
            scrollback: `*** new terminal in ${opts.label} ***\r\n`,
        }),
        killTerminalById: (id) => id === E2E_MOBILE_TERMINAL_ID,
        // Echo the phone's input straight back down the byte stream, so the
        // terminal view shows what it sent (a cheap stand-in for a real pty).
        writeToTerminal: (id, data) => {
            mobileTermFanout(id, data);
            return true;
        },
        readTerminalOutput: () => ({
            data: E2E_MOBILE_SCROLLBACK,
            cursor: E2E_MOBILE_SCROLLBACK.length,
            dropped: false,
        }),
        getScrollback: () => E2E_MOBILE_SCROLLBACK,
        resize: () => true,

        listPendingQuestions: () => listPendingQuestions(),
        answerPendingQuestion: (id, answers) => answerPendingQuestion(id, answers),
    };
}

/**
 * Start the mobile server for the E2E harness (idempotent per process). Called
 * from background.ts inside the isE2E() block when GENIE_E2E_MOBILE=1, BEFORE
 * the native-module startup steps so a node-pty/sqlite hiccup in the sandbox
 * can't stop it. Binds 127.0.0.1:E2E_MOBILE_PORT with a fixed PIN and an
 * auto-confirming pairing hook, exposes the port/pin on the global handle.
 */
export async function startMobileE2EServer(): Promise<void> {
    // The desktop confirm modal is bypassed: every pairing auto-confirms, so the
    // test pairs without a human at the desktop.
    await startMobileServer({
        serverVersion: 'e2e',
        userDataDir: process.env.GENIE_E2E_USERDATA || os.tmpdir(),
        // __dirname is the compiled app/ dir (mock.ts is bundled into
        // background.js) — same value background.ts passes — so mobile.html +
        // _next/* sit beside it.
        appDir: __dirname,
        enabled: true,
        configuredPort: () => E2E_MOBILE_PORT,
        confirmPair: async () => true,
        bindIpOverride: '127.0.0.1',
        data: buildMobileE2EDeps(),
    });
    // Force the PIN to the known value so `?pair=` is deterministic (initAuth ran
    // inside startMobileServer above, so state now exists).
    _setPinForTest(E2E_MOBILE_PIN);

    // Seed ONE pending ForceTheQuestion so the Questions flow has something to
    // answer. Enqueued WITHOUT a desktop modal window (test seam); the phone
    // resolves it through the normal answerPendingQuestion → finish path.
    _seedPendingQuestionForTest(
        [
            {
                header: 'Deploy?',
                question: 'Ship the mobile build to production?',
                options: [
                    { label: 'Ship it', description: 'Deploy now.' },
                    { label: 'Hold', description: 'Wait for review.' },
                ],
            },
        ],
        E2E_MOBILE_WORKSPACE.project_name,
    );

    // Expose the bound port + pin so the spec can read them deterministically
    // (it also just hard-codes the constants; this is a belt-and-braces handle).
    (globalThis as Record<string, unknown>).__GENIE_E2E_MOBILE__ = {
        port: E2E_MOBILE_PORT,
        pin: currentPin(),
        scrollback: E2E_MOBILE_SCROLLBACK,
        terminalId: E2E_MOBILE_TERMINAL_ID,
        processId: E2E_MOBILE_PROCESS_ID,
        workspaceId: E2E_MOBILE_WORKSPACE.id,
    };
}
