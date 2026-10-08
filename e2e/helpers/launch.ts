import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
    awaitInstanceExit,
    awaitPidExit,
    clearInstanceRecord,
    instanceRecordPath,
    writeInstanceRecord,
} from './instance-lock';

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
 *
 * `master` is the odd one out and deliberately so: it is NOT a harness page. It
 * loads `master.html` — the app's real main window — against the fixture in
 * main/e2e/master.ts. Every other entry here mounts a component in isolation;
 * this one mounts the product.
 *
 * `ask` goes one step further: it loads NO page at all. The ForceTheQuestion
 * modal is a window the product OPENS, so main/e2e/ask.ts raises real questions
 * and `createAskWindow` makes the window Playwright attaches to (Tynn #272).
 */
export type E2EHarnessPage =
    | 'issuewatch'
    | 'ghcaps'
    | 'agent-access'
    | 'agent-manager'
    | 'picker-layer'
    | 'hosting'
    | 'repo-panel'
    | 'terminal-recovery'
    | 'tynn-health'
    | 'tynn-import'
    | 'workspace-create'
    | 'agent-pulse'
    | 'deck'
    | 'agent-view'
    | 'ask'
    | 'master';

const HARNESS_ROUTE: Record<E2EHarnessPage, string> = {
    issuewatch: 'e2e-issuewatch',
    ghcaps: 'e2e-ghcaps',
    'agent-access': 'e2e-agent-access',
    'agent-manager': 'e2e-agent-manager',
    'picker-layer': 'e2e-picker-layer',
    hosting: 'e2e-hosting',
    'repo-panel': 'e2e-repo-panel',
    'terminal-recovery': 'e2e-terminal-recovery',
    'tynn-health': 'e2e-tynn-health',
    'tynn-import': 'e2e-tynn-import',
    'workspace-create': 'e2e-workspace-create',
    'agent-pulse': 'e2e-agent-pulse',
    deck: 'e2e-deck',
    'agent-view': 'e2e-agent-view',
    ask: 'ask',
    master: 'master',
};

/**
 * The Electron MAIN process behind an app handle.
 *
 * NOT `app.process()`. On Windows Playwright spawns Electron through a `cmd.exe`
 * wrapper, so `app.process()` is the wrapper and `spawnfile` is `cmd.exe` — a
 * pid belonging to the most heavily recycled image on the machine, and one whose
 * exit says nothing about Electron's. Measured here: wrapper 14680, Electron main
 * 78952. Ask the app instead; it knows who it is, on every platform.
 */
const identities = new WeakMap<ElectronApplication, { pid: number; image: string }>();

async function identify(
    app: ElectronApplication,
): Promise<{ pid: number; image: string } | null> {
    const known = identities.get(app);
    if (known) return known;
    try {
        // BOUNDED. `evaluate` has no timeout of its own, and this now sits in
        // front of every launch — an app wedged badly enough not to answer must
        // degrade to "untracked", which is exactly today's behaviour, rather than
        // hang the hook and turn a legible `firstWindow` timeout into a mystery.
        const info = await Promise.race([
            app.evaluate(() => ({ pid: process.pid, exec: process.execPath })),
            new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
        ]);
        if (!info) return null;
        const id = { pid: info.pid, image: path.basename(info.exec) };
        identities.set(app, id);
        return id;
    } catch {
        // An app too broken to answer is an app we cannot track. Recording a pid
        // we are unsure of is worse than recording none: the next launch would
        // wait out its whole budget on it and then fail a run that was fine.
        return null;
    }
}

/**
 * Every Electron launch in this suite goes through here, so that none of them can
 * begin while a previous app is still on its way out (genie#369).
 *
 * WHY THE WAIT IS HERE AND NOT ONLY IN TEARDOWN. `app.close()` turns out to be
 * well behaved — measured on Windows, it returns only once the Electron main and
 * its wrapper are both actually gone (511ms, both dead the instant it returned).
 * So a spec that closes its app in `afterAll` leaks nothing, and a teardown-side
 * fix alone would have protected the one path that was never broken.
 *
 * The path that has no teardown is the one that matters: Playwright stops the
 * worker after a failed test and starts a fresh one, which re-runs the next
 * spec's `beforeAll` and launches again. No `afterAll` runs in between, and the
 * new worker is a NEW PROCESS with none of the old one's memory. That is why the
 * record is a FILE — it is the only thing that can carry "an app was started and
 * never proven dead" across that boundary.
 *
 * The cost when nothing is wrong is one `kill(pid, 0)`, which is why this can sit
 * in front of every launch.
 */
async function launchElectron(
    harness: string,
    options: Parameters<typeof electron.launch>[0],
): Promise<ElectronApplication> {
    const record = instanceRecordPath();
    await awaitInstanceExit(record);

    const app = await electron.launch(options);

    const id = await identify(app);
    if (id) writeInstanceRecord(record, { ...id, harness, startedAt: Date.now() });
    return app;
}

/**
 * Close an app and PROVE it is gone, rather than take `close()` on trust.
 *
 * `close()` does currently reap the process before it returns (see above), so on
 * today's Playwright this confirms rather than corrects. It is still worth
 * asserting: it costs one liveness check, it is the difference between a teardown
 * that knows and one that assumes, and if that behaviour ever changes this fails
 * in the spec that leaked instead of as a launch timeout in the next one.
 */
export async function closeGenieE2E(app: ElectronApplication | undefined): Promise<void> {
    if (!app) return;
    // Identify BEFORE closing — a closed app cannot answer.
    const id = await identify(app);
    try {
        await app.close();
    } catch {
        // An app that already died is closed, which is all this needs.
    }
    if (id) {
        await awaitPidExit(id.pid, id.image);
        clearInstanceRecord(instanceRecordPath(), id.pid);
    }
}

/** The two things {@link warmElectronRuntime} needs, injected so it is testable
 *  without launching Electron — which this repository does not do off CI. */
export interface WarmupEffects {
    launch: (options: Parameters<typeof electron.launch>[0]) => Promise<{
        firstWindow: (opts?: { timeout?: number }) => Promise<unknown>;
        close: () => Promise<void>;
    }>;
    /** How long to give `close()` before giving up on it. Injected so the bound
     *  itself is testable in milliseconds rather than by waiting out 20s. */
    closeTimeoutMs?: number;
}

export interface WarmupResult {
    ok: boolean;
    /** How long the cold boot took. The number this change is judged on. */
    ms: number;
    error?: string;
}

/**
 * Pay the run's FIRST Electron boot before any test is timing one (genie#369).
 *
 * `agent-access.spec.ts` sorts first, so it stands in front of the cold start
 * every run, and `launchGenieE2E` waits for `firstWindow()` on Playwright's 30s
 * default. Measured across every Windows launch-timeout log on that issue, the
 * first launch of a run costs 13-15s on a healthy runner and 34-35s on a slow
 * one, while the SECOND launch moments later costs ~5s. So 8-30 seconds of that
 * first number is a one-time cost, and in both timeout runs nothing had launched
 * before it — contention cannot explain a failure with nothing to contend with.
 *
 * Called from `globalSetup`, this moves that cost outside every test's budget,
 * so the 30s measures the app instead of a machine warming up. Deliberately NOT
 * a bigger timeout: same shape as the genie#425 wait-for-exit — take the
 * variable cost out of the timed window rather than widen the window.
 *
 * ## Three things it must not do
 *
 * **Touch the suite's profile.** A real boot writes to its `--user-data-dir`,
 * so warming up into {@link E2E_USERDATA} would change what the specs then find
 * — and that damage would present as a flaky test, not as this function. It
 * gets a private throwaway profile, as `launchTunnelE2E` already does.
 *
 * **Fail the run.** This is an optimisation. A runner that cannot spare the boot
 * should get a slow suite, not a red one; turning a performance fix into a new
 * way for a shard to die is a worse trade than the bug.
 *
 * **Leak a process.** A warm-up that threw at `firstWindow` and left Electron
 * running would hand the first spec a live app to wait behind — manufacturing
 * the exact launch failure this exists to remove, before any test has run.
 */
export async function warmElectronRuntime(
    effects: WarmupEffects = { launch: (o) => electron.launch(o) as never },
): Promise<WarmupResult> {
    const started = Date.now();
    const userData = path.join(os.tmpdir(), `genie-e2e-warmup-${process.pid}-${started}`);
    let app: Awaited<ReturnType<WarmupEffects['launch']>> | undefined;
    try {
        app = await effects.launch({
            /**
             * `--enable-logging` — WITHOUT IT THERE IS NOTHING TO CAPTURE (genie#667).
             *
             * BARE, not `=stderr`. Electron documents the switch as `--enable-logging` for stderr and
             * `--enable-logging=file` to write a file; `=stderr` is Chromium's form, and an
             * unrecognised value may be read as a filename or ignored. Measured: with `=stderr` a
             * renderer crash produced ZERO captured lines while the capture reported itself attached
             * on all 35 spec files.
             *
             * This comment said `=stderr` for one commit after the code stopped doing it — a comment
             * contradicting the code it documents, which is the exact defect class that cost a day
             * on `acp_engine` earlier (`db.ts` claimed `engineFor` read a key it never mentions).
             * Fixed rather than left, because the next reader believes the prose.
             *
             * Measured: occurrence 8 crashed the renderer with the stderr capture confirmed
             * `attached`, and produced ZERO lines. The capture was correct; Chromium simply had not
             * written anything. Chromium's own logging — which is where `[FATAL:file.cc(123)] Check
             * failed: <expr>` goes — is OFF unless logging is explicitly enabled, so the one line
             * that names the crash was never emitted on any of the eight occurrences.
             *
             * The minidump says this is a deliberate trap (`SIGTRAP` + `SI_KERNEL`, fault address 0),
             * i.e. `IMMEDIATE_CRASH()` from a failed CHECK — and a CHECK always prints its reason
             * first. Enabling the sink is the difference between having that sentence and not.
             *
             * E2E ONLY, and it changes no behaviour under test: it routes messages that already
             * exist to a stream instead of discarding them. The chatter it adds is dropped by
             * `isFatalElectronLine`, which is why that filter was built first.
             */
            args: [MAIN_ENTRY, `--user-data-dir=${userData}`, '--enable-logging'],
            env: {
                ...process.env,
                NODE_ENV: 'production',
                GENIE_E2E: '1',
                GENIE_E2E_PAGE: HARNESS_ROUTE.issuewatch,
                GENIE_E2E_HOSTING: '',
            },
        });
        // Generous, and not a test budget: absorbing this is the entire point,
        // so aborting early would leave the cost for the first spec — the thing
        // being fixed.
        await app.firstWindow({ timeout: 120_000 });
        return { ok: true, ms: Date.now() - started };
    } catch (e) {
        return { ok: false, ms: Date.now() - started, error: String(e) };
    } finally {
        // BOUNDED, not merely caught. `.catch()` handles a rejection; a `close()`
        // that never settles is not a rejection, and `await` on one waits forever
        // whatever is chained to it (genie#490). Here that would hang
        // `globalSetup` — stalling the entire run before a single test had
        // started, with nothing on screen to say why.
        if (app) {
            await withTeardownBound(app.close(), effects.closeTimeoutMs ?? 20_000, 'warm-up close');
        }
        try {
            fs.rmSync(userData, { recursive: true, force: true });
        } catch {
            /* a leftover temp profile is untidy, not broken */
        }
    }
}

/**
 * IS THIS THE LINE THAT SAYS WHY THE RENDERER DIED? — genie#667.
 *
 * The minidump's exception stream settles the KIND of crash without needing symbols:
 * `exception_code: 5` (SIGTRAP), `exception_flags: 128` (SI_KERNEL), fault address `0x0`. That
 * combination is a **deliberate trap** — Chromium's `IMMEDIATE_CRASH()`, which a failed `CHECK()` or
 * an explicit `FATAL` emits. Not a memory error, and not a glibc abort: `__libc_fatal` raises
 * `SIGABRT` (6), and this is 5.
 *
 * And a Chromium CHECK **prints its reason before dying** — `[FATAL:file.cc(123)] Check failed:
 * <expr>` — naming the exact check, file and line. Seven occurrences have produced no cause because
 * the rig never captured the renderer's stderr: the one line that identifies it is written and
 * discarded every time.
 *
 * A FILTER rather than piping everything, because Electron is chatty (Fontconfig, libva, GPU, dbus,
 * ALSA) and thirty spec files of that is a log nobody reads — the same failure the release-notes
 * limit exists to prevent. Which makes the predicate the part worth testing: **a filter that drops
 * the one line that matters is worse than no filter**, because it looks like the capture works.
 *
 * `WARNING` is excluded deliberately: those are frequent, sometimes contain the word "failed", and
 * would bury the FATAL. And the match is ANCHORED on Chromium's bracketed severity rather than a
 * bare /fatal/i, because this repo's own CI log contains the line
 * "# NON-FATAL. azure.archive.ubuntu.com has now been unreachable twice".
 */
export function isFatalElectronLine(line: string): boolean {
    const t = typeof line === 'string' ? line.trim() : '';
    if (t === '') return false;
    // Chromium's severity marker, inside the bracketed log prefix: `…:FATAL:file.cc(123)]`.
    if (/:(FATAL|DCHECK)\b/.test(t)) return true;
    // `[FATAL:…` with no leading pid/timestamp.
    if (/^\[(FATAL|DCHECK)\b/.test(t)) return true;
    // The signal report Chromium writes as it traps.
    if (/^Received signal\b/.test(t)) return true;
    // A child exiting unexpectedly is the other way this surfaces. Both prefix forms, which the
    // first version got wrong: `:ERROR:` alone misses the bare `[ERROR:…` with no pid/timestamp,
    // exactly the case already handled above for FATAL and forgotten here.
    if (/(^\[|:)ERROR:.*exited unexpectedly/.test(t)) return true;
    return false;
}

/**
 * HOW MANY THREADS DOES THIS PROCESS HAVE? — or null where the OS will not say.
 *
 * `/proc/self/task` is Linux-only, and ubuntu is where genie#667 has crashed most. On macOS and
 * Windows this answers **null**, which is the honest answer and not 0: a confident zero would read as
 * "no threads", which is impossible, and would corrupt the series this exists to produce.
 */
export function readThreadCount(pid?: number): number | null {
    // The PID IS REQUIRED IN PRACTICE, and the first version of this omitted it. `/proc/self/task`
    // is the Playwright test runner — a node process sitting at a constant ~11 threads — while
    // Electron runs as its CHILD. That version logged `threads: 11 (+0 …)` for every spec file,
    // which reads as "no accumulation" and is a measurement of the wrong process. A flat line from
    // the wrong place is worse than no line, because it gets believed.
    const target = typeof pid === 'number' && pid > 0 ? String(pid) : 'self';
    try {
        const entries = fs.readdirSync(`/proc/${target}/task`);
        return entries.length > 0 ? entries.length : null;
    } catch {
        return null;
    }
}

/** A count has to MULTIPLY before it is called a climb — see `resourceNote`. */
const THREAD_CLIMB_FACTOR = 2;

/**
 * The thread-count series, which decides whether genie#667 is really genie#805.
 *
 * #667's sixth occurrence produced a minidump at last. It establishes that the RENDERER dies, that
 * `--disable-dev-shm-usage` is already set, and that discardable memory was **99.1 % free** — so the
 * two usual Chromium suspects are both out. It suggests, from a truncated `glibc: pthread` fragment on
 * the crashing stack, a fatal glibc error of the `pthread_create`-failed shape: a renderer that cannot
 * create a thread aborts exactly like this, with no exception of ours anywhere.
 *
 * #805 is already filed and says *"pty-host leaks ~12 MB commit, 1 thread and ~11 handles per exited
 * terminal."* An E2E run kills a great many terminals across ~180 specs. **If threads accumulate, the
 * crash is #805 arriving at a ceiling** and the fix belongs there, not in whichever spec happened to
 * reload at the wrong moment.
 *
 * One number per spec file answers it: monotonic growth means accumulation, a flat line kills the
 * hypothesis cheaply. A MULTIPLE is required before flagging, because thread pools spin up and down
 * normally and a warning on every run teaches the reader to skip the line that matters — the same
 * failure the release-notes limit exists to prevent.
 *
 * Reads only. It never raises a limit: doing that before knowing whether the count climbs would hide
 * the leak, which is the error that raising genie#826's timeout would have been — and the measurement
 * there proved it, at ~0.4s against a 30s budget.
 */
export function resourceNote(input: { threads: number | null; first: number | null }): {
    message: string;
    climbing: boolean;
} {
    const { threads, first } = input;
    if (threads === null) {
        return { message: '[e2e] threads: not available on this platform (no /proc)', climbing: false };
    }
    if (first === null || first <= 0) {
        // A count with no baseline is a number, not a series. Claiming a delta against null would be
        // inventing one.
        return { message: `[e2e] threads: ${threads} (no baseline)`, climbing: false };
    }
    const delta = threads - first;
    const climbing = threads >= first * THREAD_CLIMB_FACTOR;
    const base = `[e2e] threads: ${threads} (${delta >= 0 ? '+' : ''}${delta} since the first spec, baseline ${first})`;
    return {
        climbing,
        message: climbing
            ? `${base} — CLIMBING, see genie#667/#805: a per-terminal thread leak would look exactly like this.`
            : base,
    };
}

/**
 * Playwright's own `waitForEvent` budget, which is what genie#826 reported expiring.
 *
 * Named so the warning below fires at a real fraction of the enforced limit rather than of a number
 * somebody typed. If Playwright's default ever changes, these must move together or the logged ratio
 * becomes a lie.
 */
export const WINDOW_WAIT_BUDGET_MS = 30_000;

/** The first thread count this worker saw, so every later sample has the same baseline. */
let firstThreadCount: number | null = null;

/** Fraction of the budget a PASSING open may reach before it is worth saying so. */
const WINDOW_WAIT_WARN_AT = 0.7;

/**
 * HOW LONG A SECOND WINDOW TOOK — the measurement genie#826 needs before anyone touches the timeout.
 *
 * The failure is `waitForEvent: Timeout 30000ms exceeded while waiting for event "window"`, macOS
 * only. The two obvious responses are both guesses: raising the budget hides the bug if something
 * intermittently blocks the open, and calling it infrastructure is what the issue itself warns a
 * timeout always looks like and usually is not.
 *
 * The discriminating fact is how long a SUCCESSFUL open takes on that runner, and nobody has it,
 * because the rig only ever reported the failure. So the elapsed time is logged on success — the case
 * that carries the information — and flagged when a passing run comes close to the limit, so the next
 * failure is predicted rather than discovered. A run at 24s passes today and is the warning that it
 * will not on a slightly slower runner tomorrow.
 *
 * Pure, so the thresholds are testable without opening a window — which the desktop rule forbids here
 * anyway.
 */
export function windowWaitNote(input: { ms: number; label: string }): { message: string; nearLimit: boolean } {
    const { ms, label } = input;
    // A clock that went backwards is not a slow window, and reporting it as near the limit would send
    // somebody after the wrong thing.
    const nearLimit = ms > 0 && ms >= Math.ceil(WINDOW_WAIT_BUDGET_MS * WINDOW_WAIT_WARN_AT);
    const base = `[e2e] window wait — ${label} took ${ms}ms of a ${WINDOW_WAIT_BUDGET_MS}ms budget`;
    return {
        nearLimit,
        message: nearLimit
            ? `${base} — NEAR THE LIMIT, see genie#826: this run passed and is the warning that a slower runner will not.`
            : base,
    };
}

/**
 * WHERE ELECTRON PUTS MINIDUMPS for this rig.
 *
 * Crashpad writes under the user-data dir, and the rig launches with
 * `--user-data-dir=${E2E_USERDATA}`. Named here rather than spelled out in the workflow, so the
 * path exists once and a step copying dumps into `test-results/` cannot drift from the launch.
 */
export function crashDumpDir(): string {
    return path.join(E2E_USERDATA, 'Crashpad');
}

/**
 * REPORT A RENDERER CRASH AT THE MOMENT IT HAPPENS.
 *
 * genie#667 has been open since run `34778060990` with one line of evidence — `page.reload: Page
 * crashed` — and five occurrences have added rows to a table without producing a cause. That message
 * is not the crash: it is whatever command ran NEXT noticing the renderer had gone, which is also why
 * the tally reads as though the fault moves between specs.
 *
 * Five occurrences now, all three platforms, two specs, and one of them on a **docs-only diff** —
 * which rules out every "a recent change caused it" explanation by construction. At roughly one job
 * in three, the green that gates a release is being produced by re-running rather than earned, and
 * this issue names that property as the reason it has survived.
 *
 * DIAGNOSTICS ONLY, deliberately. It changes no product code and no test behaviour, so it cannot
 * mask what it reports — and it is not a fix. A `page.reload()` following an `app.evaluate()` state
 * write is the one thing all five share, but that is a hypothesis: a `waitForLoadState` aimed at it
 * would most likely hide the crash rather than explain it, and a flake that stops reproducing without
 * a reason is worse than one that still does.
 */
/**
 * Only the `crash` subscription, nothing else.
 *
 * The event name is the LITERAL `'crash'` rather than `string`, because Playwright's `Page.on` is an
 * overload set: a `string` parameter makes TypeScript pick the first overload (`'close'`) and reject
 * a real `Page` outright. Narrow is also honest — this helper has no business with any other event.
 */
type CrashSource = { on: (event: 'crash', listener: () => void) => unknown };

export function attachCrashReporter<T extends CrashSource>(
    page: T,
    harness: string,
    log: (message: string) => void = (m) => console.error(m),
): T {
    page.on('crash', () => {
        try {
            log(
                `[e2e] RENDERER CRASHED — harness=${harness} at ${new Date().toISOString()}. `
                    + `Minidumps (if Crashpad wrote any): ${crashDumpDir()}. `
                    + 'See genie#667; the "Page crashed" error below is the next command noticing, not the crash.',
            );
        } catch {
            // A diagnostic must never fail a launch. Turning a crash nobody has diagnosed into a
            // launch nobody can perform would be strictly worse than the gap it is closing.
        }
    });
    return page;
}

export async function launchGenieE2E(
    harness: E2EHarnessPage = 'issuewatch',
    /** Extra environment for this launch only — e.g. `GENIE_E2E_MCP_SHUTTLE`. */
    extraEnv: Record<string, string> = {},
): Promise<{
    app: ElectronApplication;
    page: Page;
}> {
    const app = await launchElectron(harness, {
        // See the note on the other launch site: without this, a CHECK failure writes its reason
        // nowhere and the stderr capture has nothing to find (genie#667).
        args: [MAIN_ENTRY, `--user-data-dir=${E2E_USERDATA}`, '--enable-logging'],
        env: {
            ...process.env,
            NODE_ENV: 'production',
            GENIE_E2E: '1',
            GENIE_E2E_PAGE: HARNESS_ROUTE[harness],
            // Containers are mocked ONLY for the hosting harness — every other
            // spec keeps the real `dev:*` handlers (main/e2e/hosting.ts).
            GENIE_E2E_HOSTING: harness === 'hosting' ? '1' : '',
            ...extraEnv,
        },
    });
    // The harness window is opened on app.whenReady(); wait for it.
    //
    // A launch that fails here CLEANS UP AFTER ITSELF. Without this, a
    // `firstWindow` timeout leaves a running app behind with nobody holding a
    // handle to close it — the spec's `afterAll` never got one — so the app is
    // left for Playwright's process-exit handler to kill on its own schedule,
    // while the replacement worker is already launching the next spec. That is
    // the genie#369 amplifier at its source: one failed launch manufacturing the
    // overlap that fails the next one.
    let page: Page;
    try {
        page = await app.firstWindow();
        // BEFORE the first wait, so a crash during initial load is reported too — see genie#667.
        attachCrashReporter(page, harness);
        /**
         * ONE THREAD SAMPLE PER SPEC FILE — genie#667 vs genie#805.
         *
         * Here rather than per test: ~30 lines a run is a readable series, 180 is noise. The baseline
         * is whatever the first launch saw, kept in module scope so every spec file in a worker
         * compares against the same number.
         */
        /**
         * THE RENDERER'S OWN WORDS — genie#667. A `CHECK` failure prints its file, line and
         * expression before trapping, and the rig has been discarding that on seven occurrences.
         * Filtered through `isFatalElectronLine` so Electron's ordinary chatter does not flood the
         * log; see that function for why `WARNING` is excluded and why the match is anchored.
         */
        const stderr = app.process().stderr;
        /**
         * SAY WHICH IT IS. Without this line, "no FATAL lines in the log" is ambiguous between
         * *nothing fatal happened* and *the capture was inert because `stderr` was null* — and
         * `if (stderr)` skips silently. That is exactly the distinction this codebase insists on
         * everywhere else (`null` is "cannot see", `[]` is "none"), broken here in a diagnostic
         * whose whole purpose is to make an absence meaningful. Measured: the first run reported
         * zero captured lines on all three platforms and could not tell me which had happened.
         */
        // eslint-disable-next-line no-console
        console.log(`[e2e] electron stderr: ${stderr ? 'attached' : 'NOT AVAILABLE — a FATAL line cannot be captured, see genie#667'} (${harness})`);
        if (stderr) {
            let pending = '';
            stderr.on('data', (chunk: Buffer | string) => {
                pending += String(chunk);
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() ?? '';
                for (const line of lines) {
                    if (!isFatalElectronLine(line)) continue;
                    // eslint-disable-next-line no-console
                    console.error(`[e2e] electron stderr (${harness}): ${line.trim()}`);
                }
            });
        }

        // The ELECTRON main process, by pid — not `/proc/self`, which is this test runner.
        const threads = readThreadCount(app.process().pid);
        if (firstThreadCount === null) firstThreadCount = threads;
        // eslint-disable-next-line no-console
        console.log(resourceNote({ threads, first: firstThreadCount }).message);
        await page.waitForLoadState('domcontentloaded');
    } catch (e) {
        await closeGenieE2E(app).catch(() => {});
        throw e;
    }
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
    hostServe?: { mode: 'static' | 'php' | 'octane' | 'frankenphp'; root?: string; spa?: boolean; version?: string; server?: string };
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
        hostServe?: { mode: 'static' | 'php' | 'octane' | 'frankenphp'; root?: string; spa?: boolean; version?: string; server?: string };
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
            hostServe: s.hostServe as { mode: 'static' | 'php' | 'octane' | 'frankenphp'; root?: string; spa?: boolean; version?: string; server?: string } | undefined,
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
    const app = await launchElectron('mobile', {
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
    // A private `--user-data-dir` isolates this one's PROFILE, not the machine:
    // it is still a full Electron boot competing for the same CPU, disk and
    // loopback ports as an app that has not finished exiting. It waits its turn
    // like the rest.
    const app = await launchElectron('tunnel', {
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

/** What `seedAgentManagerE2E` (main/e2e/agent-manager.ts) put on disk + in the db. */
export interface AgentManagerSeed {
    workspaceId: string;
    workspacePath: string;
    agentId: string;
    agentName: string;
    personaPath: string;
    mcpPath: string;
    sidecarName: string;
    /** The `AGENT.md` header line Genie has NO field for. The round-trip
     *  assertion turns on this surviving a save. */
    unrenderedLine: string;
}

/** Read the agent-manager fixture (Tynn #709). Null when seeding never ran, so
 *  the spec fails with a cause rather than asserting against undefined. */
export async function readAgentManagerSeed(
    app: ElectronApplication,
): Promise<AgentManagerSeed | null> {
    return app.evaluate(() => {
        return (
            ((globalThis as Record<string, any>).__GENIE_E2E_AGENT_MANAGER__ as {
                workspaceId: string;
                workspacePath: string;
                agentId: string;
                agentName: string;
                personaPath: string;
                mcpPath: string;
                sidecarName: string;
                unrenderedLine: string;
            }) ?? null
        );
    });
}

/**
 * `AGENT.md` as it exists ON DISK right now.
 *
 * The assertion the DOM cannot make. A renderer that held the edit in state and
 * never wrote it looks exactly like one that saved; only the bytes tell them
 * apart, and only the bytes show whether the header key the UI does not render
 * survived the write.
 */
export async function readAgentManagerPersonaFile(app: ElectronApplication): Promise<string> {
    return app.evaluate(() => {
        const read = (globalThis as Record<string, any>).__GENIE_E2E_AGENT_MANAGER_READ__ as
            | (() => string)
            | undefined;
        return read ? read() : '';
    });
}

/** What `seedMasterE2E` (main/e2e/master.ts) put in the database. */
export interface MasterSeed {
    workspaceId: string;
    workspaceName: string;
    terminalId: string;
    terminalLabel: string;
    driverAgentName: string;
    sidecarAgentName: string;
    sidecarTerminalId: string;
    sidecarTerminalLabel: string;
    peerId: string;
    peerName: string;
    /** The GDW's folder — the GApp Store's dev-launcher entry names it. */
    peerPath: string;
    peerTerminalId: string;
    peerTerminalLabel: string;
}

/**
 * Read the master-window fixture's ids. Returns null when seeding never ran, so
 * the spec fails naming the cause instead of asserting against `undefined`.
 */
export async function readMasterSeed(app: ElectronApplication): Promise<MasterSeed | null> {
    return app.evaluate(() => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_MASTER__;
        return (h?.seed as MasterSeed) ?? null;
    });
}

/** Mirrors `TynnImportSeed` in main/e2e/tynn-import.ts (genie#355). */
export interface TynnImportSeed {
    parentPath: string;
    envelopeProjectId: string;
    plainProjectId: string;
    bareProjectId: string;
    envelopePath: string;
    plainPath: string;
    barePath: string;
    agentsProjectId: string;
    agentsPath: string;
    handWrittenPersona: string;
}

/**
 * Read the Tynn-import fixture's ids + the folder the envelope should land in.
 * Null when seeding never ran, so the spec fails naming the cause.
 */
export async function readTynnImportSeed(
    app: ElectronApplication,
): Promise<TynnImportSeed | null> {
    return app.evaluate(() => {
        const seed = (globalThis as Record<string, any>).__GENIE_E2E_TYNN_IMPORT__;
        return (seed as TynnImportSeed) ?? null;
    });
}

/** Mirrors `WorkspaceCreateSeed` in main/e2e/workspace-create.ts (genie#431). */
export interface WorkspaceCreateSeed {
    parentPath: string;
    workspaceName: string;
    expectedPath: string;
}

/**
 * Read the workspace-create fixture's destination folder + the name to type.
 * Null when seeding never ran, so the spec fails naming the cause.
 */
export async function readWorkspaceCreateSeed(
    app: ElectronApplication,
): Promise<WorkspaceCreateSeed | null> {
    return app.evaluate(() => {
        const seed = (globalThis as Record<string, any>).__GENIE_E2E_WORKSPACE_CREATE__;
        return (seed as WorkspaceCreateSeed) ?? null;
    });
}

/**
 * The grid last APPLIED to a terminal's pty, from main's size tracker.
 *
 * The half of genie#229 the DOM cannot show. A panel fitted while it was hidden
 * looks perfectly normal by the time it comes back — what lasts is the geometry
 * that reached the pty while the panel was off screen, and the scrollback the TUI
 * reflowed to fit it. Null means nothing was ever applied (no live pty).
 */
export async function readPtyGrid(
    app: ElectronApplication,
    terminalId: string,
): Promise<{ cols: number; rows: number } | null> {
    return app.evaluate((_e, id) => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_MASTER__;
        return h?.ptyGrid?.(id) ?? null;
    }, terminalId);
}

/** One grid a pty was driven to. Mirrors `TerminalSizeEvent` in main. */
export interface PtyGridEvent {
    cols: number;
    rows: number;
    /** ms since main started. */
    at: number;
}

/**
 * EVERY grid main drove that pty to, oldest first.
 *
 * {@link readPtyGrid} says where the pty is NOW, which cannot distinguish one
 * that never moved from one that moved and was put back — and a spec asserting a
 * NON-EVENT ("the panel a switch hid never drove its pty") is asking exactly
 * that. Two uses, both in master-window.spec.ts: waiting until nothing is in
 * flight before trusting a reading, and saying whether a forbidden resize
 * happened at all rather than comparing a snapshot (genie#542).
 */
export async function readPtyGridLog(
    app: ElectronApplication,
    terminalId: string,
): Promise<PtyGridEvent[]> {
    return app.evaluate((_e, id) => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_MASTER__;
        return (h?.ptyGridLog?.(id) as PtyGridEvent[]) ?? [];
    }, terminalId);
}

/**
 * The terminal ids main currently has a LIVE pty for. Read alongside
 * {@link readPtyGrid} so a missing grid says which half failed: no live pty means
 * the spawn never happened (or died), a live pty with no grid means the resize did.
 */
export async function readLiveTerminals(app: ElectronApplication): Promise<string[]> {
    return app.evaluate(() => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_MASTER__;
        return (h?.liveTerminals?.() as string[]) ?? [];
    });
}

/**
 * Raise the AgentInbox "a message came in" toast for a terminal, through main's
 * real announce path (fact lookup → notice → local broadcast). `landed` is what
 * a delivered nudge reports about its pty writes: true when the notice really is
 * sitting in that prompt, false when nothing was written.
 */
export async function announceInboxIncoming(
    app: ElectronApplication,
    terminalId: string,
    landed: boolean,
    pending = true,
): Promise<void> {
    await app.evaluate((_e, arg) => {
        const h = (globalThis as Record<string, any>).__GENIE_E2E_MASTER__;
        h?.announceInboxIncoming?.(arg.terminalId, arg.landed, arg.pending);
    }, { terminalId, landed, pending });
}

/**
 * Bound one teardown step, and SAY SO when it overruns (genie#490).
 *
 * A hook that hangs is worse than one that fails, because the failure is
 * reported against whichever test happened to run last. On `main` at `7f594b1d`
 * that was `master-window.spec.ts:961` — *"the palette offers no step Genie
 * would refuse"* — a test that passed its own assertions and had nothing to do
 * with it. Anyone reading the run concludes the Flows palette regressed.
 *
 * `.catch(() => {})` does not prevent this and reading it as a safety net is the
 * trap: it handles a REJECTION, and the failure here is a promise that never
 * settles at all. `await` on one waits forever regardless of what is chained to
 * it. That is the general lesson — a rejection handler is not a timeout.
 *
 * Rejections still propagate. A step that fails fast and one that hangs need
 * different answers, and collapsing them would bury a real teardown error under
 * "timed out".
 */
export async function withTeardownBound<T>(
    work: Promise<T>,
    ms: number,
    label: string,
): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
        const outcome = await Promise.race([
            work,
            new Promise<typeof OVERRAN>((r) => {
                timer = setTimeout(() => r(OVERRAN), ms);
            }),
        ]);
        if (outcome !== OVERRAN) return outcome;
        // Named, so the next occurrence points at the STEP instead of at an
        // innocent test. genie#490 asks for this to be measured rather than
        // reasoned about from the source; this is that measurement, made
        // permanent and free.
        console.warn(
            `[e2e teardown] ${label} did not finish within ${ms}ms — continuing. ` +
                `The app is wedged or already gone; this is the genie#490 shape.`,
        );
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const OVERRAN = Symbol('teardown-step-overran');

/**
 * Kill the fixture's ptys. Call this BEFORE `app.close()`: a manual quit with a
 * live terminal and a window open raises the keep-or-shut-down confirmation, and
 * because this harness IS the real master page it really renders that modal —
 * quit then sits for its 30s decision timeout with nobody there to answer.
 *
 * BOUNDED (genie#490). `app.evaluate` has no timeout of its own, and an app too
 * wedged to answer it used to hang this call forever — taking the `afterAll`,
 * then the worker teardown, then the shard. `identify()` above already races its
 * own evaluate for exactly this reason; this is the same idiom, applied to the
 * other place in this file that awaits an app that may never answer.
 *
 * Giving up here is safe and is not a silent failure: it is logged by name, and
 * the ptys die with the app moments later either way. What it stops is the
 * 60-second wait for an answer that is not coming.
 */
export async function killMasterTerminals(
    app: ElectronApplication,
    timeoutMs = 10_000,
): Promise<void> {
    await withTeardownBound(
        app.evaluate(() => {
            (globalThis as Record<string, any>).__GENIE_E2E_MASTER__?.killTerminals?.();
        }),
        timeoutMs,
        'killMasterTerminals',
    );
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
