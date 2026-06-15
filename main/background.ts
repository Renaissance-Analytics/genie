import { app, BrowserWindow, ipcMain, nativeImage, session } from 'electron';
import path from 'path';
import { createTray } from './tray';
import { registerShortcuts, unregisterShortcuts } from './shortcuts';
import { registerIpcHandlers } from './ipc';
import { initDatabase } from './db';
import { registerProtocolHandler, handleGenieUrl } from './auth';
import {
    registerTerminalIpc,
    stopAllTerminals,
    requestFinalSnapshots,
    snapshotRetainedWindowless,
    terminalHasWindow,
    broadcastTerminalAttention,
} from './terminal/ipc';
import { startMcpServer } from './mcp/server';
import {
    initTerminalBackend,
    isHostBacked,
    disconnectHostLeaveRunning,
} from '@particle-academy/fancy-term-host';
import {
    wireTerminalAdapter,
    killHostForUpdate,
    snapshotHostTerminalsForUpdate,
    getSnapshotStore,
    detachedTerminalsEnabled,
} from './terminal/genie-adapter';
import {
    activateHostService,
    hostBackendKind,
    selectTerminalBackend,
    shouldKillHostForUpdate,
} from './terminal/host-service';
import {
    liveHostTerminals,
    shouldConfirmQuit,
    confirmQuitTerminals,
    pickDialogWindow,
} from './terminal/quit-confirm';
import { isQuittingForUpdate } from './updater/quit-state';
import { registerFilesIpc } from './files/ipc';
import { registerGithubIpc } from './github/ipc';
import { registerUpdaterIpc, checkForUpdatesNow } from './updater/ipc';
import { registerDocsIpc } from './docs/ipc';
import { installAppMenu } from './app-menu';

/**
 * Genie — Tynn desktop companion.
 *
 * Architecture:
 *   - Main process owns everything sensitive (db, filesystem, git ops,
 *     sub-process spawning, session cookies).
 *   - Renderer (Next.js) is read-only across IPC; talks via typed channels.
 *   - Tray icon is the durable surface; windows are spawned lazily.
 *
 * Story #149 — scaffold + tray. Subsequent stories layer on top.
 */

const isProd = process.env.NODE_ENV === 'production';
const isDev = !isProd;

// Single-instance lock. If a second copy of Genie is launched (e.g. clicking
// a genie:// URL), the existing process gets the activation event and the
// second one exits. This is also how the Windows protocol handoff works.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
}

let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let docsWindow: BrowserWindow | null = null;
let masterWindow: BrowserWindow | null = null;
const terminalWindows = new Set<BrowserWindow>();

export function getMainWindow(): BrowserWindow | null {
    return mainWindow;
}

/**
 * Open TheFloor — the unified workspace + terminal management window.
 * Hosts the cross-project terminal tree, the workspace CRUD sidebar,
 * the layout grid, and the project context menu. Single instance —
 * clicking the tray entry while already open just focuses it.
 */
export function showMasterWindow(): void {
    // Whenever the window comes to the front, refresh the update check so
    // the header pill reflects reality (throttled in the updater). Genie
    // lives in the tray, so this is the moment the user can actually see
    // the result.
    checkForUpdatesNow();
    if (masterWindow && !masterWindow.isDestroyed()) {
        masterWindow.show();
        masterWindow.focus();
        return;
    }
    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 980,
        minHeight: 620,
        show: false,
        // Hidden native title bar — the in-app .titlebar row is the drag
        // region, so the window presents one "Genie" chrome instead of a
        // native label + menu bar duplicating it. The overlay keeps the
        // native min/max/close cluster (and its snap layouts flyout) on
        // Windows; macOS keeps inset traffic lights.
        title: 'Genie',
        titleBarStyle: 'hidden',
        ...(process.platform !== 'darwin'
            ? {
                  titleBarOverlay: {
                      color: '#0a0a0c',
                      symbolColor: '#a1a1aa',
                      height: 46,
                  },
              }
            : {}),
        autoHideMenuBar: true,
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/master');
    } else {
        win.loadFile(path.join(__dirname, 'master.html'));
    }

    win.once('ready-to-show', () => win.show());
    // Re-check on focus too — catches the case where Genie was left open
    // for hours and a release shipped in the meantime (throttled).
    win.on('focus', () => checkForUpdatesNow());
    win.on('closed', () => {
        if (masterWindow === win) masterWindow = null;
    });
    masterWindow = win;
}

/**
 * Open a Stage — a satellite TheFloor window pinned to a single project
 * by default. Multiple stages can be open at once; each one has its own
 * selection + layout state. Stages share the underlying ptys with
 * TheFloor (via the multi-attach manager), so a terminal running in
 * TheFloor will mirror its live output into the Stage when added.
 */
const stageWindows = new Set<BrowserWindow>();
export function showStageWindow(workspaceId?: string): void {
    const win = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 900,
        minHeight: 560,
        show: false,
        // Same hidden-titlebar treatment as the master window — one chrome.
        title: 'Genie',
        titleBarStyle: 'hidden',
        ...(process.platform !== 'darwin'
            ? {
                  titleBarOverlay: {
                      color: '#0a0a0c',
                      symbolColor: '#a1a1aa',
                      height: 46,
                  },
              }
            : {}),
        autoHideMenuBar: true,
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    const query = workspaceId
        ? `?stage=${encodeURIComponent(workspaceId)}`
        : '?stage=1';
    if (isDev) {
        win.loadURL(`http://localhost:8888/master${query}`);
    } else {
        win.loadFile(path.join(__dirname, 'master.html'), {
            search: query.slice(1),
        });
    }
    win.once('ready-to-show', () => win.show());
    stageWindows.add(win);
    win.on('closed', () => stageWindows.delete(win));
}

/**
 * Open a standalone terminal window — used by the tray menu's "New
 * terminal" entry and (later) by the workspace UI. The window loads the
 * `/terminal` route, which mounts an XTerm bound to a fresh pty.
 */
export function showTerminalWindow(): void {
    const win = new BrowserWindow({
        width: 880,
        height: 560,
        show: false,
        frame: true,
        title: 'Genie · Terminal',
        backgroundColor: '#09090b',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/terminal');
    } else {
        win.loadFile(path.join(__dirname, 'terminal.html'));
    }

    win.once('ready-to-show', () => win.show());
    terminalWindows.add(win);
    win.on('closed', () => terminalWindows.delete(win));
}

export function getCaptureWindow(): BrowserWindow | null {
    return captureWindow;
}

export function getSettingsWindow(): BrowserWindow | null {
    return settingsWindow;
}

/**
 * The legacy `/tray` BrowserWindow was retired in favour of TheFloor as the
 * single unified surface. Every old call site (auth callback, second-
 * instance handler, macOS dock click, IPC) now lands in TheFloor instead.
 * Kept exported only so existing imports compile; the underlying
 * `createMainWindow` is no longer reachable.
 */
export function showMainWindow(): void {
    showMasterWindow();
}

export function showSettingsWindow(): void {
    if (!settingsWindow || settingsWindow.isDestroyed()) {
        settingsWindow = createSettingsWindow();
        // createSettingsWindow defers .show() to 'ready-to-show'; just
        // wait for it. focus() also no-ops until the window is visible.
        settingsWindow.once('ready-to-show', () => settingsWindow?.focus());
        return;
    }
    settingsWindow.show();
    settingsWindow.focus();
}

export function getDocsWindow(): BrowserWindow | null {
    return docsWindow;
}

/**
 * Open (or focus) the Docs viewer window. Mirrors showSettingsWindow — a
 * separate BrowserWindow loading the `/docs` renderer page, reused on repeat
 * opens so we never stack duplicate doc windows.
 */
export function showDocsWindow(): void {
    if (!docsWindow || docsWindow.isDestroyed()) {
        docsWindow = createDocsWindow();
        docsWindow.once('ready-to-show', () => docsWindow?.focus());
        return;
    }
    docsWindow.show();
    docsWindow.focus();
}

export function showCaptureWindow(): void {
    if (!captureWindow || captureWindow.isDestroyed()) {
        captureWindow = createCaptureWindow();
    }
    captureWindow.show();
    captureWindow.focus();
}

export function hideCaptureWindow(): void {
    if (captureWindow && !captureWindow.isDestroyed()) {
        captureWindow.hide();
    }
}

function createMainWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 480,
        height: 640,
        show: false,
        frame: true,
        title: 'Genie',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/tray');
    } else {
        win.loadFile(path.join(__dirname, 'tray.html'));
    }

    win.on('close', (e) => {
        // Closing the window hides it instead of quitting — Genie is
        // tray-resident.
        if (!(app as any).isQuiting) {
            e.preventDefault();
            win.hide();
        }
    });

    return win;
}

function createSettingsWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 720,
        height: 640,
        show: false,
        frame: true,
        title: 'Genie Settings',
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/settings');
    } else {
        win.loadFile(path.join(__dirname, 'settings.html'));
    }

    // Defer showing until the page has actually painted. Without this, the
    // window pops up as a white/blank rectangle for several frames while
    // the renderer boots, which reads as "broken" rather than "loading".
    win.once('ready-to-show', () => win.show());
    return win;
}

function createDocsWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 960,
        height: 720,
        show: false,
        frame: true,
        title: 'Genie Documentation',
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/docs');
    } else {
        win.loadFile(path.join(__dirname, 'docs.html'));
    }

    win.once('ready-to-show', () => win.show());
    return win;
}

function createCaptureWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 480,
        height: 200,
        show: false,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/capture');
    } else {
        win.loadFile(path.join(__dirname, 'capture.html'));
    }

    // Hide on blur — capture is a transient flow.
    win.on('blur', () => {
        if (!win.webContents.isDevToolsOpened()) {
            win.hide();
        }
    });

    return win;
}

app.on('second-instance', (_event, argv) => {
    // Windows: protocol URLs come in via argv. Find the genie:// URL.
    const url = argv.find((a) => a.startsWith('genie://'));
    if (url) {
        handleGenieUrl(url);
    } else {
        showMainWindow();
    }
});

// macOS: protocol URLs come in via 'open-url'.
app.on('open-url', (event, url) => {
    event.preventDefault();
    handleGenieUrl(url);
});

app.whenReady().then(async () => {
    // Persistent session under "persist:tynn" so cookies survive restarts.
    // tynn-api.ts uses this session for all outbound calls.
    session.fromPartition('persist:tynn');

    // Surface preload-script errors loudly. Without this, a bug in
    // preload.ts fails silently — window.genie never attaches and the
    // renderer just sits on "Waiting for preload…" with no clue why.
    // The terminal running `npm run dev` now gets the error + stack.
    app.on('web-contents-created', (_e, contents) => {
        contents.on('preload-error', (_event, preloadPath, error) => {
            // eslint-disable-next-line no-console
            console.error(
                `[preload-error] ${preloadPath}\n${error?.stack ?? error?.message ?? String(error)}`,
            );
        });
    });

    initDatabase();
    registerIpcHandlers();
    // Wire the terminal core to its Electron/SQLite adapters (snapshot store +
    // settings provider + host spawner) and subscribe the cwd→db / host-status→
    // broadcast bridges. MUST run before initTerminalBackend (which reads the
    // host spawner + settings) and before registerTerminalIpc (which uses the
    // shared snapshot store). __dirname is the compiled main bundle dir, where
    // the detached pty-host script sits beside background.js.
    wireTerminalAdapter(__dirname);
    // Tier 3: choose the terminal backend BEFORE registering the terminal IPC.
    // initTerminalBackend connects-or-spawns the detached pty-host when the
    // `detached_terminals` setting is ON (default OFF → in-process). It NEVER
    // throws — any failure degrades to the in-process backend with a non-fatal
    // toast. Doing this first means registerTerminalIpc binds its data/exit
    // fan-out to whichever backend won (subscribeBackendEvents also re-binds on
    // any later swap, so a mid-session fallback still routes correctly).
    // BACKEND SELECTION (fallback chain: service → detached-spawn → in-process).
    //
    //   1. detached_terminals OFF → in-process only. Skip the whole host path.
    //   2. ON → FIRST try the per-user OS service (fancy-term-host@0.2.0
    //      /service): install-if-missing/stale → start → connect a HostClient to
    //      the SAME socket. A service-backed host runs on its OWN standalone Node
    //      runtime, so it survives BOTH a quit AND an update (it never pins
    //      Genie's binary). ensureHostService NEVER throws → on {ok:false} (no
    //      runtime shipped, unsupported OS, install/connect failure) we FALL BACK.
    //   3. Fallback → initTerminalBackend(): connect-to-existing-or-spawn the
    //      DETACHED host (Genie's execPath child — pins the binary, survives a
    //      normal quit, must be killed on update). It too NEVER throws → on
    //      failure it degrades to in-process with a non-fatal toast.
    //
    // selectTerminalBackend records which one won via setHostBackendKind, so
    // hostBackendKind() drives the update-teardown branch + willRestartPtyHost.
    const selection = await selectTerminalBackend({
        detachedEnabled: detachedTerminalsEnabled(),
        activateService: () =>
            activateHostService({
                snapshots: getSnapshotStore(),
                userDataDir: app.getPath('userData'),
            }),
        initDetached: () => initTerminalBackend(),
        isHostBackedProbe: () => isHostBacked(),
    });
    const backendInit: { host: boolean; reattachIds: string[] } = {
        host: selection.host,
        reattachIds: selection.reattachIds,
    };
    if (selection.kind === 'service') {
        // eslint-disable-next-line no-console
        console.log(
            `[terminal] per-user OS service active (action=${selection.serviceAction}); ` +
                `${backendInit.reattachIds.length} session(s) to reattach`,
        );
    } else if (selection.serviceReason) {
        // eslint-disable-next-line no-console
        console.log(`[terminal] OS service not used: ${selection.serviceReason}`);
    }
    // Static imports above — earlier dynamic imports could fail silently
    // on some bundlers, leaving the IPC channels unregistered and
    // surfacing as "No handler registered for 'terminal:resize'" in the
    // renderer once a window mounts.
    registerTerminalIpc();
    if (backendInit.host && backendInit.reattachIds.length > 0) {
        // The renderer remounts retained specs on launch via the create() rejoin
        // path; the host client's mirror already holds their scrollback, so the
        // normal master-view restore replays them. Nothing extra to push here —
        // the ids are surfaced for diagnostics/logging only.
        // eslint-disable-next-line no-console
        console.log(
            `[terminal] reattached to detached host: ${backendInit.reattachIds.length} session(s)`,
        );
    }
    registerFilesIpc();
    registerGithubIpc();
    registerUpdaterIpc();
    // Agent-integration MCP server (loopback). imDone pulses the caller's
    // terminal glow. Best-effort: a failed bind just means no MCP endpoints.
    void startMcpServer({
        serverVersion: app.getVersion(),
        onImDone: (terminalId) => broadcastTerminalAttention(terminalId, true),
    }).catch((e) => console.error('[mcp] failed to start', e));
    // Docs viewer IPC (docs:list / docs:read). __dirname is the compiled main
    // bundle dir; resolveDocsDir uses it to find the bundled docs/ in both dev
    // and the packaged asar.
    registerDocsIpc(__dirname);
    // Two-phase quit (Tier 1 terminal persistence). On the FIRST before-quit we
    // hold the quit, ask every window to serialize its terminals one last time,
    // wait a bounded window for those final `terminal:snapshot` messages to
    // land, then kill the ptys and let the quit proceed. A re-entry guard means
    // the second (post-flush) quit passes straight through, so quit can never
    // hang on this. The wait is also unconditionally bounded by a timer, so a
    // wedged renderer can't block shutdown either.
    let snapshotFlushDone = false;
    // Manual-quit terminal confirmation (T3). When host-backed, a normal quit
    // leaves the ptys running in the detached host. Before doing that silently
    // we ask the user which terminals to keep vs shut down. This guards the
    // before-quit re-entry: while the dialog is up we've preventDefault'd and
    // are awaiting the renderer's decision; a stray second quit must not stack
    // another dialog.
    let quitConfirmInFlight = false;
    // Teardown picks behaviour by (a) active backend and (b) WHY we're quitting:
    //
    //   • NORMAL quit, host-backed   → disconnectHostLeaveRunning(). The detached
    //     pty-host OWNS the ptys and must OUTLIVE the quit so the next launch
    //     reattaches live sessions. We snapshot first (T1 floor) but DO NOT kill.
    //   • NORMAL quit, in-process    → stopAllTerminals() (kill the ptys we own).
    //   • UPDATE quit, host-backed   → the host PINS Genie's binary (it runs as
    //     execPath), so NSIS can't overwrite it. Snapshot every host terminal
    //     (so restore replays history, not fresh) then GRACEFULLY shut the host
    //     down (killHostForUpdate → shutdownHost(): the host kills its own ptys,
    //     cleans up pidfile/socket, exits) and WAIT (bounded) before
    //     quitAndInstall's installer runs, with a defensive pidfile-kill fallback
    //     if the graceful path doesn't take.
    //   • UPDATE quit, in-process    → stopAllTerminals() (no host to worry about).
    //
    // Returns a promise so the before-quit second phase can AWAIT the bounded
    // host kill before letting the quit proceed.
    const teardownTerminals = async (): Promise<void> => {
        const forUpdate = isQuittingForUpdate();
        const kind = hostBackendKind();
        if (isHostBacked()) {
            // UPDATE-quit teardown branches on the ACTIVE BACKEND KIND, because
            // only ONE kind pins Genie's binary:
            //   • 'service'  — the host runs on its OWN standalone Node runtime
            //     via the OS service, so it NEVER pins Genie's binary. It
            //     SURVIVES the update exactly like a normal quit: just disconnect
            //     and leave it running, so after the swap Genie reconnects and
            //     terminals are still live. NO kill, NO snapshot needed.
            //   • 'detached' — the host is Genie's execPath child, so it PINS the
            //     binary. NSIS can't overwrite it while alive → keep alpha.44's
            //     snapshot-then-kill (now via the graceful shutdownHost path).
            if (shouldKillHostForUpdate(forUpdate, kind)) {
                // Snapshot windowless host ptys (windowed ones are covered by the
                // renderer snapshot broadcast) BEFORE the host dies, so the cold
                // post-update launch replays their history.
                snapshotHostTerminalsForUpdate(terminalHasWindow);
                // Disconnect the client first (no lingering socket), then shut the
                // host down so the installer can replace the pinned binary.
                disconnectHostLeaveRunning();
                await killHostForUpdate();
            } else {
                // Normal quit (any host kind) OR update quit with a service-backed
                // host → leave the host running so the next launch reattaches.
                disconnectHostLeaveRunning();
            }
        } else {
            stopAllTerminals();
        }
    };
    // The teardown+re-quit tail, shared by every path that proceeds to actually
    // quit (normal, post-confirm, post-timeout, no-window). Runs the backend
    // teardown (host-backed normal → disconnectHostLeaveRunning leaves the kept
    // terminals running; update → kills the host) then re-triggers app.quit(),
    // which the snapshotFlushDone guard now lets pass straight through.
    const finishQuit = (): void => {
        void teardownTerminals().finally(() => {
            snapshotFlushDone = true;
            quitConfirmInFlight = false;
            app.quit();
        });
    };

    // Drive the manual-quit confirmation: broadcast the live host terminals to
    // the chosen window and await the renderer's decision (via the tested
    // confirmQuitTerminals orchestrator — bounded timeout, one-shot listener).
    //   - 'cancelled' → abort the quit; clear the in-flight flag so a later quit
    //                   re-asks. Nothing torn down, Genie stays open.
    //   - 'proceed'   → the deselected terminals were already killed; run the
    //                   teardown tail (leaves the kept ones running) + quit.
    const runQuitConfirmThenQuit = (
        liveTerminals: ReturnType<typeof liveHostTerminals>,
    ): void => {
        const win = pickDialogWindow();
        if (!win) {
            // No-window fallback: nothing to host the dialog (e.g. tray quit with
            // all windows closed). Don't block — fall back to today's behaviour
            // (disconnectHostLeaveRunning leaves all running) and quit.
            finishQuit();
            return;
        }
        void confirmQuitTerminals({
            liveTerminals,
            send: (channel, payload) => win.webContents.send(channel, payload),
            focusWindow: () => {
                win.show();
                win.focus();
            },
        }).then((outcome) => {
            if (outcome === 'cancelled') {
                quitConfirmInFlight = false;
                return;
            }
            finishQuit();
        });
    };

    app.on('before-quit', (event) => {
        if (snapshotFlushDone) return; // re-entry: let the quit proceed
        // While the confirm dialog is up we've already preventDefault'd and are
        // awaiting the renderer; swallow any stray re-quit so we don't stack a
        // second dialog or double-teardown.
        if (quitConfirmInFlight) {
            event.preventDefault();
            return;
        }
        // PHASE 1 — SNAPSHOT. Tier 2 → Tier 1 degrade: snapshot any RETAINED-but-
        // windowless ptys from their scrollback before we tear down, so a
        // suspended dev server replays on the next launch. (Host-backed: this is
        // the resilience floor if the detached host is later killed externally.)
        // This ALWAYS runs first, so even a terminal the user later chooses to
        // shut down still has a replayable snapshot next launch.
        snapshotRetainedWindowless();
        // On the UPDATE path the host kill is async + bounded, so we must always
        // take the preventDefault → await → re-quit two-phase even with no window
        // open (otherwise the synchronous return would quit before the host dies).
        const forUpdate = isQuittingForUpdate();
        if (BrowserWindow.getAllWindows().length === 0 && !forUpdate) {
            // Nothing window-side to snapshot and a normal quit — tear down
            // immediately (the windowless retained snapshot above already ran).
            snapshotFlushDone = true;
            void teardownTerminals();
            return;
        }
        event.preventDefault();
        if (BrowserWindow.getAllWindows().length > 0) requestFinalSnapshots();
        // Give the renderer ~250ms to land its final snapshots, THEN advance the
        // state machine. The whole chain is bounded so quit can't hang.
        setTimeout(() => {
            // PHASE 2 — CONFIRM (manual quit only). After the snapshot flush, on a
            // MANUAL quit that's host-backed with ≥1 live host terminal AND a
            // window open, ask the user which terminals to keep vs shut down. The
            // update path skips this entirely (forUpdate gate) — it snapshots +
            // shuts the whole host down for the binary swap. In-process / no-
            // terminals / no-window all fall through to the teardown tail.
            const liveTerminals = forUpdate ? [] : liveHostTerminals();
            const confirm =
                !forUpdate &&
                shouldConfirmQuit({
                    hostBacked: isHostBacked(),
                    liveTerminals,
                    hasOpenWindow: BrowserWindow.getAllWindows().length > 0,
                });
            if (confirm) {
                quitConfirmInFlight = true;
                runQuitConfirmThenQuit(liveTerminals);
                return;
            }
            // PHASE 3 — TEARDOWN + QUIT (no confirmation needed).
            finishQuit();
        }, 250);
    });
    registerProtocolHandler();

    // Tray icons live at <asar>/resources/*.png in production (the
    // electron-builder files filter ships them) and at resources/*.png
    // in dev. The -update variant carries the amber badge dot shown
    // while an update is pending.
    const resourcesDir = isDev
        ? path.join(process.cwd(), 'resources')
        : path.join(__dirname, '..', 'resources');
    const trayImg = nativeImage.createFromPath(
        path.join(resourcesDir, 'tray-icon.png'),
    );
    const trayUpdateImg = nativeImage.createFromPath(
        path.join(resourcesDir, 'tray-icon-update.png'),
    );
    if (process.platform === 'darwin' && !trayImg.isEmpty()) {
        trayImg.setTemplateImage(true);
    }
    createTray(trayImg, trayUpdateImg.isEmpty() ? undefined : trayUpdateImg);

    installAppMenu();

    registerShortcuts();

    // On macOS, hitting the dock icon should show the main window.
    app.on('activate', () => {
        showMainWindow();
    });
});

app.on('window-all-closed', () => {
    // Genie stays alive in the tray. Do nothing.
});

app.on('before-quit', () => {
    (app as any).isQuiting = true;
    unregisterShortcuts();
});

// Bridge for getting the active project context (used by capture window).
ipcMain.handle('app:get-current-project', async () => {
    // Capture window uses this to pre-select the project. Defaults to the
    // last-opened workspace, then to primary's project, then null.
    const { getLastOpenedProject } = require('./workspace/last-opened');
    return getLastOpenedProject();
});
