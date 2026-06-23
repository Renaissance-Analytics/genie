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

/** True only in E2E test mode. Everything in this module no-ops otherwise. */
export function isE2E(): boolean {
    return process.env.GENIE_E2E === '1';
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

interface GithubCapabilities {
    connected: boolean;
    satisfiedFeatures: string[];
    missing: string[];
    missingPermissions: string[];
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

/** The live scriptable state (only meaningful in E2E mode). */
export let e2eState: E2EState = defaultE2EState();

/** Reset to defaults — handy between tests sharing one Electron instance. */
export function resetE2EState(): void {
    e2eState = defaultE2EState();
    publishHandle();
}

/** Expose the state on a global so `electronApp.evaluate` can reach it. */
function publishHandle(): void {
    (globalThis as Record<string, unknown>).__GENIE_E2E__ = {
        get state() {
            return e2eState;
        },
        reset: resetE2EState,
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
