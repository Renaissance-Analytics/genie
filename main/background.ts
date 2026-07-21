import {
    app,
    BrowserWindow,
    ipcMain,
    nativeImage,
    Notification,
    session,
} from 'electron';
import fs from 'fs';
import path from 'path';
import { createTray, rebuildMenu } from './tray';
import { registerShortcuts, unregisterShortcuts } from './shortcuts';
import { launchedFromAutostart } from './autostart';
import { registerIpcHandlers } from './ipc';
import { writeClipboardImagePng } from './clipboard-image';
import crypto from 'node:crypto';
import os from 'node:os';
import {
    initDatabase,
    listWorkspaces,
    listTerminalSpecs,
    getAllSettings,
    getTerminalSpec,
    getWorkspace,
    createTerminalSpec,
    workspaceProcessApproval,
    workspaceTerminalApproval,
    removeWorkspace,
    getWorkspaceTunnelSites,
    setWorkspaceTunnelSite,
} from './db';
import { discoverSites } from './mobile/hosts';
import { listLocalEnabledGenSites } from './sites/local-sites';
import {
    writeWorkspaceAgentMcp,
    healTynnLiteralToken,
    syncWorkspaceCodexTynnMcp,
} from './mcp/agent-config';
import { resolveAlertSound, deliverAlertSound } from './notify-sound';
import { demandWindowAttention, resolveAttentionWindow } from './attention-flash';
import { workspaceDocHealth, repairWorkspaceDocs } from './workspace/create-agi';
import { registerForceQuestionIpc, forceQuestion } from './ask/force-question';
import {
    registerIssueWatchIpc,
    resolveWorkspaceRepos,
    getWorkspaceFeed,
    getOpenCounts,
    setIssueWatchServiceState,
    setIssueWatchPingSinks,
} from './issue-watch';
import { issueWatchWakeText } from './issue-watch/ping';
import { getToken } from './github/storage';
import { detectFolder } from './workspace/detect';
import { cleanupLegacyTynnCliInstall } from './cli/legacy-cleanup';
import type {
    WorkspaceMap,
    WorkspaceRepoInfo,
    IssueWatchSnapshot,
    IssueWatchItem,
} from './mcp/protocol';
import { registerProtocolHandler, handleGenieUrl, isSignedIn, onAuthChanged } from './auth';
import {
    registerTerminalIpc,
    stopAllTerminals,
    requestFinalSnapshots,
    snapshotRetainedWindowless,
    terminalHasWindow,
    killTerminalById,
    reapOrphanTerminals,
    rehydrateAgentInbox,
    installAgentPulse,
    createAgentTerminal,
    writeToTerminal,
    readTerminalOutput,
    broadcastTerminalAttention,
} from './terminal/ipc';
import { installAgentInboxPresence } from './agentinbox/presence';
import { agentInboxBroker } from './agentinbox/broker';
import { dbAgentInboxStore } from './agentinbox/store';
import { getWorkspaceAgentAccess } from './db';
import { installKnowledgeBroadcast } from './knowledge/presence';
import {
    buildSubmitBytes,
    resolveTerminalInput,
    stripAnsi,
} from './terminal/keystrokes';
import {
    startMcpServer,
    workspaceEndpointUrl,
    DEFAULT_MCP_PORT,
} from './mcp/server';
import { startControlServer } from './control';
import { startMobileServer, DEFAULT_MOBILE_PORT } from './mobile/server';
import {
    listPendingQuestions,
    answerPendingQuestion,
    desktopQuestionTransport,
} from './ask/force-question';
import { listAllProcesses } from './terminal/process-list';
import { getTerminalSize, recordTerminalSize } from './terminal/size-tracker';
import {
    startAutostartProcesses,
    startProcess,
    stopProcess,
    restartProcess,
    getProcessStatuses,
} from './terminal/process-supervisor';
import type {
    ManageProcessRequest,
    ManageProcessResult,
    ManagedProcessInfo,
    ProvisionWorkspacesRequest,
    ProvisionWorkspacesResult,
    OpsChildInfo,
    ManageTerminalsRequest,
    ManageTerminalsResult,
    ManagedTerminalInfo,
    RunAgentRequest,
    RunAgentResult,
    ManageWorkspacesRequest,
    ManageWorkspacesResult,
    ManagedWorkspaceInfo,
    AgentType,
} from './mcp/protocol';
import { resolveTargetWorkspace, type TargetDecision } from './mcp/target-workspace';
import { TynnBackend } from './backend/tynn';
import { startLocalWorkstation } from './tynn/local-workstation';
import { readTynnLink, ensureMcpGitignored } from './tynn/provision';
import {
    bindWindowToConnection,
    unbindWindow,
    disconnectConnKey,
    type RemoteHost,
} from './remote';
import { openWorkspace } from './workspace/open';
import {
    computeOpsProvisionPlan,
    applyOpsProvision,
    provisionTargets,
    opsAutoProvisionEnabled,
} from './tynn/ops-provision';
import { broadcastWorkspacesChanged } from './ipc';
import {
    initTerminalBackend,
    isHostBacked,
    disconnectHostLeaveRunning,
    terminalManager,
} from '@particle-academy/fancy-term-host';
import {
    wireTerminalAdapter,
    killHostForUpdate,
    snapshotHostTerminalsForUpdate,
    detachedTerminalsEnabled,
    electronEncryptor,
} from './terminal/genie-adapter';
import { setSecretEncryptor } from './secrets/store';
import { buildHostServerDeps } from './host-core/server-deps';
import type { HostCorePorts } from './host-core/ports';
import {
    hostBackendKind,
    shouldKillHostForUpdate,
    detachedHostPinsBinary,
} from './terminal/host-service';
import { runBackendSelection as runBackendSelectionCore } from './host-core/backend-selection';
import {
    liveHostTerminals,
    shouldConfirmQuit,
    confirmQuitTerminals,
    pickDialogWindow,
} from './terminal/quit-confirm';
import {
    workspaceIdOfTerminal,
    SYSTEM_WORKSPACE_ID,
} from './terminal/workspace-of-terminal';
import { registerOpenFile } from './editor/open-file';
import {
    registerHostTools,
    createSpecializedAgentTerminal,
    restartAgentTerminal,
    updateAgentInboxChannel,
} from './mcp/host-tools';
import { isQuittingForUpdate } from './updater/quit-state';
import { markDesktopRuntime, isHeadless } from './runtime-mode';
import { registerFilesIpc } from './files/ipc';
import { registerGithubIpc } from './github/ipc';
import { registerPluginsIpc } from './plugins/ipc';
import { registerPluginEditorBridge } from './plugins/editor-bridge';
import { registerDocumentConvert } from './plugins/document-convert';
// (plugin editor-routing is consumed via the plugins:editor-for IPC in
// editor-bridge.ts — CodePanel asks it per tab open.)
import { revalidateAllPluginTrust } from './plugins/install';
import {
    registerCapabilityIpc,
    runBootCapabilityCheck,
} from './github/capability-service';
import {
    registerUpdaterIpc,
    checkForUpdatesNow,
    mobileUpdateStatus,
    mobileInstallUpdate,
    mobileCheckUpdate,
} from './updater/ipc';
import { registerDocsIpc } from './docs/ipc';
import { installAppMenu } from './app-menu';
import {
    isE2E,
    isE2EMobile,
    registerE2EMocks,
    startMobileE2EServer,
} from './e2e/mock';
import {
    isE2ETailscaleTunnel,
    isE2ETunnel,
    startTunnelE2EHarness,
} from './e2e/tunnel';
import { seedAgentAccessE2E } from './e2e/agent-access';

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

/**
 * Notify the user that an agent called imDone, per the Customization settings:
 *   - notify_sound → broadcast `notify:sound` so a renderer synthesizes a chime
 *     (no audio asset shipped; the tray window is always alive to play it).
 *   - notify_toast → an OS notification (the "tray popup"), reusing Electron's
 *     native Notification (proven in updater/ipc.ts).
 * Both default off and are independent of the always-on attention glow.
 */

function notifyImDone(terminalId: string): void {
    let settings;
    try {
        settings = getAllSettings();
    } catch {
        return;
    }
    // Resolve the per-alert sound choice (synth / bundled wav / custom file →
    // data-URL / off). A null descriptor means "off" for this alert — skip the
    // chime entirely. Only resolved when the master sound gate is on.
    const sound =
        settings.notify_sound === 'on' ? resolveAlertSound('imDone') : null;
    if (sound) {
        // Deliver the chime to the MASTER renderer specifically — it's the only
        // window that subscribes to `notify:sound`. A freshly-created master
        // window (cold launch / upgrade-restart) may still be loading when the
        // alert fires; sending then drops the message, so deliverAlertSound
        // defers to did-finish-load (mirrors openTaskManagerWindow /
        // sendOpenFile). When fully tray-resident (no master window) no renderer
        // can play audio — the OS toast below still notifies.
        deliverAlertSound(masterWindow, { kind: 'imDone', sound });
    }
    if (settings.notify_toast === 'on' && Notification.isSupported()) {
        const label = getTerminalSpec(terminalId)?.label ?? 'A terminal';
        const n = new Notification({
            title: 'Genie — agent finished',
            body: `${label} is done and waiting for you.`,
            // Silence the OS chime only when OUR chime actually plays, so we
            // don't double up — but if the alert sound is off, let the OS sound.
            silent: !!sound,
        });
        n.on('click', () => {
            // Surface (creating if needed) the master window — the previous
            // `mainWindow` reference is never assigned, so this used to focus an
            // arbitrary window and did nothing when tray-resident.
            showMasterWindow();
        });
        n.show();
    }
    // Demand attention at the OS level (taskbar flash / dock bounce) for the
    // window hosting this workspace, but only when it isn't focused. A local
    // terminal lives in the master window; resolveAttentionWindow encodes the
    // host-window-vs-master pick (this process's imDone is always local → the
    // master window). Fires on every alert, like the glow — independent of the
    // sound/toast toggles above.
    demandWindowAttention(resolveAttentionWindow(null, masterWindow, hostWindows));
}

// Single-instance lock. If a second copy of Genie is launched (e.g. clicking
// a genie:// URL), the existing process gets the activation event and the
// second one exits. This is also how the Windows protocol handoff works.
//
// SKIPPED in E2E (GENIE_E2E): the lock is process-wide (app-name-keyed on
// Windows, so --user-data-dir does NOT isolate it), so a running real Genie —
// or a leftover test instance — makes every E2E launch quit before it opens a
// window (the Playwright `firstWindow` timeout). Each E2E run is already
// isolated by its own --user-data-dir + E2E ports, so skipping the lock is safe
// and lets the suite run alongside a live Genie.
const gotLock =
    process.env.GENIE_E2E === '1' || app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
}

let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
/** The restriction the current settingsWindow was built for (the ?remote=1 URL
 *  flag is fixed at load, so a mode change needs a fresh window). */
let settingsRestricted = false;
/** The host connKey the current settingsWindow is bound to (null = local). Baked
 *  into the URL + the window binding at load, so opening Settings for a DIFFERENT
 *  host (or for local) needs a fresh window. */
let settingsConnKey: string | null = null;
let docsWindow: BrowserWindow | null = null;
let knowledgeWindow: BrowserWindow | null = null;
let masterWindow: BrowserWindow | null = null;
const terminalWindows = new Set<BrowserWindow>();

export function getMainWindow(): BrowserWindow | null {
    return mainWindow;
}

/**
 * Open the master window and tell its renderer to surface the Task Manager
 * (the cross-workspace process panel). Used by the tray's "Task Manager…"
 * item. Sends after the webContents finishes loading so a freshly-created
 * window receives the event once its renderer is ready.
 */
export function openTaskManagerWindow(): void {
    showMasterWindow();
    const win = masterWindow;
    if (!win || win.isDestroyed()) return;
    const send = () => {
        if (!win.isDestroyed()) win.webContents.send('open-task-manager');
    };
    // A pre-existing window is already loaded → send now; a fresh one needs to
    // finish loading first (did-finish-load fires once the renderer mounts).
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
}

/**
 * Open TheFloor — the unified workspace + terminal management window.
 * Hosts the cross-project terminal tree, the workspace CRUD sidebar,
 * the layout grid, and the project context menu. Single instance —
 * clicking the tray entry while already open just focuses it.
 */
export function showMasterWindow(): void {
    // HEADLESS (genie-cloud host): there is no real BrowserWindow — electron is a
    // stub, so `win.loadFile` is undefined and creating/loading one throws
    // `win.loadFile is not a function`. A stray call here (an agent action, the auth
    // flow, the tray) would then abort the host boot BEFORE the workspace-assignment
    // subscription starts (host-core `workspaceAssignments.start()`), so assigned
    // workspaces never provision. Nothing to show without a display: no-op.
    if (isHeadless()) return;
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
 * Open (or focus) a HOST window — a native Genie Floor (`/master`) whose `api()`
 * is routed over the remote bridge to a paired host, so you drive that machine's
 * REAL desktop UI (rail, terminals, processes) — NOT its `/m/` mobile web view.
 *
 * The connection must already be live in the registry (the Hosts picker calls
 * `connectRemote` first, handling the PIN). We BIND this window's webContents to
 * the connKey BEFORE the page loads, so the renderer's boot-time `myBinding()`
 * resolves `remote` and wires the bridge for THIS window only — the local window
 * (and any other host window) is unaffected. Closing it unbinds + disconnects
 * that host (the saved token persists for a 1-click reconnect).
 */
const hostWindows = new Map<string, BrowserWindow>();
export function showHostWindow(host: RemoteHost, connKey: string): void {
    const existing = hostWindows.get(connKey);
    if (existing && !existing.isDestroyed()) {
        existing.show();
        existing.focus();
        return;
    }
    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 980,
        minHeight: 620,
        show: false,
        // Same hidden-titlebar chrome as the master/stage windows.
        title: `Genie — ${host.hostname}`,
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
    const wcId = win.webContents.id;
    // Bind BEFORE load so the renderer's first myBinding() already reads remote.
    bindWindowToConnection(wcId, connKey);
    const query = `?host=${encodeURIComponent(connKey)}`;
    if (isDev) {
        win.loadURL(`http://localhost:8888/master${query}`);
    } else {
        win.loadFile(path.join(__dirname, 'master.html'), { search: query.slice(1) });
    }
    win.once('ready-to-show', () => win.show());
    hostWindows.set(connKey, win);
    win.on('closed', () => {
        hostWindows.delete(connKey);
        unbindWindow(wcId);
        // Last window driving this host is gone → tear down its WS bridges
        // (the saved token stays for a quick reconnect next time).
        disconnectConnKey(connKey);
    });
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

export function showSettingsWindow(restricted = false, connKey: string | null = null): void {
    // `restricted` = opened FROM a remote/host window → show only the connection-
    // relevant subset. `connKey` = the caller's bound host, so the Settings window's
    // api() bridge reads/writes THAT host's workspace/agent settings (bucket 2). Both
    // are baked into the window URL + binding at load, so a change vs the reused
    // window needs a fresh one (recreate, don't reload).
    if (
        !settingsWindow ||
        settingsWindow.isDestroyed() ||
        settingsRestricted !== restricted ||
        settingsConnKey !== connKey
    ) {
        if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
        settingsRestricted = restricted;
        settingsConnKey = connKey;
        settingsWindow = createSettingsWindow(restricted, connKey);
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

export function getKnowledgeWindow(): BrowserWindow | null {
    return knowledgeWindow;
}

/**
 * Open (or focus) the Knowledge Graph window. Mirrors showDocsWindow — a separate
 * Genie-skinned BrowserWindow loading the `/knowledge` renderer page, reused on
 * repeat opens (a singleton) so we never stack duplicate windows. Backs the
 * `knowledge:open-window` IPC + the `knowledge.openWindow()` renderer call.
 */
export function showKnowledgeWindow(): void {
    if (!knowledgeWindow || knowledgeWindow.isDestroyed()) {
        knowledgeWindow = createKnowledgeWindow();
        knowledgeWindow.once('ready-to-show', () => knowledgeWindow?.focus());
        return;
    }
    knowledgeWindow.show();
    knowledgeWindow.focus();
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

function createSettingsWindow(restricted = false, connKey: string | null = null): BrowserWindow {
    const win = new BrowserWindow({
        width: 860,
        height: 680,
        minWidth: 680,
        minHeight: 520,
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

    // ?remote=1 tells the settings page it was opened from a remote/host window →
    // show only the connection-relevant subset (device Customization + the
    // host-sourced workspace/agent groups).
    //
    // When opened from a bound HOST window we ALSO carry `?host=<connKey>` and bind
    // THIS window to that connection BEFORE load, so its api() routes over the remote
    // bridge — the DEVICE prefs (theme/notifications/copy-paste) stay client-local via
    // the bridge's settings split, while the WORKSPACE / AGENT-ENVIRONMENT settings
    // (Ai.System, Agent-MCP config, host terminal toolkit env) read/write the HOST.
    // Without a connKey the window stays LOCAL exactly as before.
    const wcId = win.webContents.id;
    let search = restricted ? 'remote=1' : '';
    if (connKey) {
        bindWindowToConnection(wcId, connKey);
        search = `host=${encodeURIComponent(connKey)}${search ? `&${search}` : ''}`;
        // Drop only THIS window's binding on close — never tear the shared host
        // connection down (the host window that opened us still drives it).
        win.on('closed', () => unbindWindow(wcId));
    }
    if (isDev) {
        win.loadURL(`http://localhost:8888/settings${search ? `?${search}` : ''}`);
    } else {
        win.loadFile(
            path.join(__dirname, 'settings.html'),
            search ? { search } : undefined,
        );
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

function createKnowledgeWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 1100,
        height: 760,
        minWidth: 720,
        minHeight: 480,
        show: false,
        frame: true,
        title: 'Knowledge Graph',
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    if (isDev) {
        win.loadURL('http://localhost:8888/knowledge');
    } else {
        win.loadFile(path.join(__dirname, 'knowledge.html'));
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

/**
 * Desktop wrapper over the extracted, GUI-free backend selection — injects the
 * Electron/E2E-derived inputs. Reused by startup and the `genie host
 * start/restart` control commands.
 *
 * Never attempt the detached host under E2E: the --no-pack test build ships no
 * standalone runtime, and a detached + unref'd host child would outlive the test
 * by design. The E2E specs don't exercise terminals, so in-process keeps boot
 * deterministic. The production default is ON.
 */
async function runBackendSelection() {
    return runBackendSelectionCore({
        userDataDir: app.getPath('userData'),
        detachedEnabled: detachedTerminalsEnabled() && !isE2E(),
    });
}

function readPtyHostPid(): number | null {
    try {
        const j = JSON.parse(
            fs.readFileSync(
                path.join(app.getPath('userData'), 'ptyhost.json'),
                'utf8',
            ),
        );
        return typeof j.pid === 'number' ? j.pid : null;
    } catch {
        return null;
    }
}

/** `genie host stop` — kill the running pty-host (terminates its terminals). */
async function hostStop(): Promise<string> {
    const pid = readPtyHostPid();
    try {
        disconnectHostLeaveRunning();
    } catch {
        /* in-process backend — nothing to disconnect */
    }
    if (pid == null) return 'no host process recorded (in-process backend?)';
    try {
        process.kill(pid);
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return `host pid ${pid} was not running`;
        return `failed to stop host pid ${pid}: ${e instanceof Error ? e.message : String(e)}`;
    }
    return `stopped host (pid ${pid}) — its running terminals were terminated`;
}

/** `genie host start` — (re)initialise the terminal backend. */
async function hostStart(): Promise<string> {
    const sel = await runBackendSelection();
    return `host start → backend: ${sel.kind}${
        sel.serviceReason ? ` (${sel.serviceReason})` : ''
    }`;
}

/** `genie host restart` — stop the host, then re-init the backend. */
async function hostRestart(): Promise<string> {
    const stopped = await hostStop().catch(() => 'stop skipped');
    const sel = await runBackendSelection();
    return `${stopped}\nhost restart → backend: ${sel.kind}`;
}

// Last-resort process-level guards. Without them, a single unhandled exception
// or promise rejection anywhere in main (an IPC handler, a stray async tick)
// tears the whole app down — the "selecting a workspace crashes everything"
// class of failure. Log loudly and keep running: one bad operation must not
// kill Genie. (Renderer-side crashes are caught by ErrorBoundary instead.)
process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[Genie main] uncaughtException — kept alive:', err);
});
process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[Genie main] unhandledRejection — kept alive:', reason);
});

app.whenReady().then(async () => {
    // HEADLESS (genie-cloud host): the electron stub still resolves whenReady, so
    // this DESKTOP boot would otherwise run on a headless host — calling
    // markDesktopRuntime() (which wrongly flips isDesktop()/isHeadless() and would
    // enable desktop-only full-FS access), creating windows, and crashing in
    // showMasterWindow (no real BrowserWindow → win.loadFile is not a function),
    // aborting before the host-core workspace-assignment subscription can run. The
    // host uses its own host-core boot, never this desktop path. isHeadless() is
    // reliably true here (plain-node process.type is undefined, and markDesktop
    // hasn't run yet), so bail before any of it. Desktop (process.type==='browser')
    // is NOT headless → proceeds normally.
    if (isHeadless()) return;
    // Mark this as the DESKTOP runtime (Electron main). Gates the System
    // workspace's full-filesystem access (files/ipc.ts) — impossible headless.
    markDesktopRuntime();

    // The Testing Browser E2E owns a completely isolated window + loopback
    // fixture and needs none of the normal desktop database/terminal startup.
    // Start it before native backends so the release-facing browser contract
    // cannot be hidden by an unrelated developer-machine service failure.
    if (isE2ETunnel()) {
        await startTunnelE2EHarness().catch((e) =>
            console.error('[e2e] tunnel harness failed to start', e),
        );
        return;
    }

    // One-time upgrade migration: remove the system-wide tynn-cli installation
    // created by older Genie builds before terminals/processes inherit its PATH.
    const cliCleanup = await cleanupLegacyTynnCliInstall();
    if (cliCleanup.error) {
        console.error(`[tynn-cli cleanup] ${cliCleanup.error}`);
    } else if (cliCleanup.cleaned) {
        console.log(
            `[tynn-cli cleanup] removed legacy toolkit${
                cliCleanup.backupDir ? `; user files preserved at ${cliCleanup.backupDir}` : ''
            }`,
        );
    }

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

    initDatabase(app.getPath('userData'));
    // Install the secrets-at-rest encryptor for ALL token stores (mobile / remote
    // / GitHub) BEFORE anything reads them. Desktop injects the Electron
    // safeStorage-backed impl; genie-cloud injects its KMS one. Fail-closed: if
    // unavailable, those stores keep secrets in memory only (never plaintext).
    setSecretEncryptor(electronEncryptor());
    // Inject the two desktop-GUI hooks the extracted MCP tools need (tray-menu
    // rebuild + surfacing the master window). Headless leaves these as no-ops.
    registerHostTools({ rebuildMenu, showMasterWindow });
    // The four host-core ports, Electron-backed. The headless genie-cloud build
    // injects KMS / fail-closed / log impls of the same interfaces. These power
    // the GUI-free server-deps factory (buildHostServerDeps) below.
    const electronPorts: HostCorePorts = {
        encryptor: electronEncryptor(),
        questionTransport: desktopQuestionTransport,
        notifier: { imDone: (terminalId) => notifyImDone(terminalId) },
        lifecycle: { keepAlive: () => {} },
    };
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
    // `detached_terminals` setting is ON — now the DEFAULT (explicit 'off' →
    // in-process). It NEVER
    // throws — any failure degrades to the in-process backend with a non-fatal
    // toast. Doing this first means registerTerminalIpc binds its data/exit
    // fan-out to whichever backend won (subscribeBackendEvents also re-binds on
    // any later swap, so a mid-session fallback still routes correctly).
    // BACKEND SELECTION (fallback chain: service → detached-spawn → in-process).
    //
    //   1. detached_terminals OFF (an explicit opt-out now) → in-process only.
    //      Skip the whole host path.
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
    const selection = await runBackendSelection();
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
    // Reap orphaned host PTYs (a spec deleted out from under a detached
    // terminal, or a crashed session) once the host has settled its reattach.
    // Deferred + unref'd so it never blocks startup; safe because it only kills
    // ids with NO spec — retained/reattaching terminals all still have specs.
    setTimeout(() => {
        try {
            reapOrphanTerminals();
        } catch {
            /* best-effort */
        }
    }, 8000).unref?.();
    // AgentInbox: wire the presence/message fan-out + the durable store, then
    // re-register every persisted AgentInbox agent (durable identity rides
    // terminal_specs.meta) and rehydrate their messages/inboxes from genie.db so
    // a restart loses neither the agent directory nor a queued message.
    try {
        installAgentInboxPresence();
        agentInboxBroker.setStore(dbAgentInboxStore);
        // Wake-on-DM (issue #9): the broker decides IF an idle opted-in agent should
        // be woken (fail-safe); this sink does the actual injection — submit the
        // nudge to the agent's pty, like a bracketed-paste send.
        agentInboxBroker.setWakeSink((terminalId, text) => {
            writeToTerminal(terminalId, buildSubmitBytes(text, true));
        });
        // AgentInbox OUTER tier: the broker asks the workspaces table who may reach
        // into a given workspace. Kept a seam so the broker stays db-free (and
        // permissive when unwired, e.g. in unit tests).
        agentInboxBroker.setWorkspaceAccessResolver((workspaceId) =>
            getWorkspaceAgentAccess(workspaceId),
        );
        rehydrateAgentInbox();
        agentInboxBroker.rehydrateMessages();
    } catch {
        /* best-effort — AgentInbox is additive; a failure never blocks startup */
    }
    // AgentPulse: wire the terminal-activity tracker's broadcast (rail glow +
    // live sparkline). Additive; a failure never blocks startup.
    try {
        installAgentPulse();
    } catch {
        /* best-effort */
    }
    // Knowledge Graph: wire the store's change events to the renderer broadcast
    // so an open window live-refreshes (incl. an agent's MCP writes).
    try {
        installKnowledgeBroadcast();
    } catch {
        /* best-effort — knowledge is additive; a failure never blocks startup */
    }
    registerFilesIpc();
    registerGithubIpc();
    // Plugin System (Settings → Plugins): install / enable / grant / marketplace.
    registerPluginsIpc();
    registerPluginEditorBridge();
    registerDocumentConvert();
    // Re-evaluate plugin trust against the current trust store on boot, so a key
    // removed / Developer Mode turned off between sessions revokes fail-closed.
    try {
        revalidateAllPluginTrust();
    } catch {
        /* best-effort — the runtime surface gate still fail-closes per call */
    }
    // GitHub capability gating: detect which features the App's granted
    // permissions allow + expose the gate to the renderer.
    registerCapabilityIpc();
    registerUpdaterIpc();
    // Issue Watch: per-workspace GitHub issue/PR/Dependabot watching + poller.
    registerIssueWatchIpc();
    // IssueWatch → agent pings: a `notify` handler glows its terminal; a `wake`
    // handler gets the SAME fail-safe idle-only nudge as wake-on-DM (never
    // mid-turn). Both edges live here (electron glow + broker wake); the routing
    // rule + change-dedup are pure in issue-watch/ping.ts.
    setIssueWatchPingSinks({
        notify: (terminalId) => broadcastTerminalAttention(terminalId, true),
        wake: (terminalId) => agentInboxBroker.wakeTerminalIfIdle(terminalId, issueWatchWakeText()),
    });
    // E2E test mode (GENIE_E2E=1): OVERRIDE the GitHub + Issue Watch channels
    // with scriptable mocks so a Playwright test can drive the device-flow /
    // reconnect UI deterministically (no GitHub, no OAuth, no keychain, no DB
    // seed). Runs AFTER the real registrations and removeHandler's each channel
    // first, so it wins. Inert (never called) in a normal run.
    if (isE2E()) {
        registerE2EMocks();
        // eslint-disable-next-line no-console
        console.log('[e2e] GENIE_E2E=1 — GitHub + Issue Watch IPC mocked.');
        // Open the harness window NOW — not at the end of whenReady. The later
        // startup steps (terminal backend selection, MCP/control servers) touch
        // native modules (node-pty) that may be unbuildable in a test sandbox; if
        // one of those awaits hangs or throws, the end-of-whenReady window would
        // never open. The flyout only needs IPC + the renderer, both ready here.
        showE2EWindow();
        // Mobile-server E2E harness (GENIE_E2E_MOBILE=1): bring the REAL mobile
        // server up on 127.0.0.1 at a fixed port/PIN with mock data deps, BEFORE
        // the native-module startup steps below (node-pty / sqlite) that may hang
        // or throw in a test sandbox. The desktop window above is irrelevant for
        // this spec — the served `/m/` page + REST + WS are what it drives.
        if (isE2EMobile()) {
            await startMobileE2EServer().catch((e) =>
                console.error('[e2e] mobile server failed to start', e),
            );
        }
    }
    // Start with the master window OPEN by default. Genie launches to the tray
    // alone (no window) only when EITHER the user set `start_minimized`
    // (Settings → General) OR the OS launched Genie at sign-in (autostart passes
    // `--autostart` / macOS wasOpenedAtLogin) — an auto-start should never ambush
    // the user with a window on every boot. In both cases the window opens on the
    // first tray click / quick-capture hotkey. E2E opened its own harness window
    // above. Shown here — right after IPC + the terminal backend are ready, before
    // the MCP/mobile servers — so it appears promptly and no later async step hides it.
    if (
        !isE2E() &&
        !launchedFromAutostart() &&
        (getAllSettings() as Record<string, string>)['start_minimized'] !== 'on'
    ) {
        showMasterWindow();
    }
    // Boot-time capability check: once GitHub is known-connected, detect any
    // missing required permission and broadcast `github:capabilities` so the
    // renderer can raise the resolve modal + persistent header warning. Deferred
    // + best-effort so it never blocks startup (the token may settle first).
    // Skipped under E2E — the mock owns the capability channels + state.
    if (!isE2E()) setTimeout(() => void runBootCapabilityCheck(), 4000).unref?.();
    // Start background Process service runners flagged autostart. Headless —
    // they run in the pty backend with no panel; the supervisor broadcasts
    // status to the workspace-row indicator + inline manager.
    startAutostartProcesses();
    // ForceTheQuestion modal IPC (the agent-integration MCP raises it).
    registerForceQuestionIpc({
        isDev,
        preloadPath: path.join(__dirname, 'preload.js'),
        getMasterWindow: () => masterWindow,
    });
    // Wire the openFileForUser tool's renderer round-trip: resolve workspace +
    // path in main, then ask the master Floor to reuse/open an editor panel.
    registerOpenFile({
        workspaceIdOfTerminal,
        getWorkspaceRoot: (wsId) => getWorkspace(wsId)?.path ?? null,
        homeDir: () => os.homedir(),
        sendOpenFile: (payload) => {
            // Surface the master window so the file is actually visible, then push
            // the request (after its content has loaded, on a cold open).
            showMasterWindow();
            const w = masterWindow;
            if (!w || w.isDestroyed()) return;
            const send = () => {
                if (!w.isDestroyed()) w.webContents.send('editor:open-file', payload);
            };
            if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
            else send();
        },
    });
    // Agent-integration MCP server (loopback). imDone pulses the caller's
    // terminal glow + optional chime/toast; ForceTheQuestion raises the modal.
    // Best-effort: a failed bind just means no MCP endpoints.
    // The MCP server's deps are assembled by the GUI-free factory from the
    // extracted host-tools + the injected ports (so the SAME deps run headless).
    await startMcpServer(
        buildHostServerDeps(
            {
                serverVersion: app.getVersion(),
                userDataDir: app.getPath('userData'),
                // The fixed, user-settable port (Settings → Agent MCP). Parsed
                // from the k/v setting; falls back to the default when garbage.
                configuredPort: () => {
                    const raw = (getAllSettings() as Record<string, string>)['mcp_port'];
                    const n = raw ? parseInt(raw, 10) : NaN;
                    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_MCP_PORT;
                },
            },
            electronPorts,
        ),
    ).catch((e) => console.error('[mcp] failed to start', e));
    // Backfill the genie MCP entry into the Claude/Cursor config of any
    // workspace already opted in — now with the stable workspace endpoint URL,
    // so older configs that carried the broken ${GENIE_MCP_URL} ref are
    // rewritten to the hard-coded URL on launch. Best-effort.
    for (const ws of listWorkspaces()) {
        if (ws.mcp_enabled) {
            writeWorkspaceAgentMcp(ws.path, true, workspaceEndpointUrl(ws.id));
        }
    }
    // Self-heal the `tynn` MCP entry of any workspace still on the OLD, broken
    // `${TYNN_AGENT_TOKEN}` reference form — which Claude Code / Cursor REFUSE to
    // load when the var is unset (a stale terminal, a subagent, a non-Genie shell),
    // breaking "connect to Tynn" for EVERY agent there (the outage). Rewrite it to
    // the self-contained literal-token form, reading the token from the workspace's
    // own gitignored `.env` (no re-mint / no network). Best-effort per workspace —
    // never blocks or crashes boot.
    for (const ws of listWorkspaces()) {
        try {
            if (healTynnLiteralToken(ws.path)) ensureMcpGitignored(ws.path);
            if (syncWorkspaceCodexTynnMcp(ws.path)) ensureMcpGitignored(ws.path);
        } catch (e) {
            console.error('[tynn] literal-token self-heal failed for', ws.path, e);
        }
    }
    // Control server for the bundled `genie` CLI (status / kill / host control).
    // Loopback + token; writes <userData>/genie-control.json for discovery.
    void startControlServer({
        userDataDir: app.getPath('userData'),
        killTerminal: (id) => killTerminalById(id),
        hostStop,
        hostStart,
        hostRestart,
    }).catch((e) => console.error('[control] failed to start', e));
    // Local-workstation IssueWatch client (design brief genie-service-separation
    // §2a): self-register + Ed25519-enroll THIS machine as a Tynn Workstation
    // (FREE + uncapped, no GCC spawn), then — when the user's IssueWatch FMS
    // toggle is on — subscribe to our OWN private-workstation channel so
    // server-side IssueWatch deltas arrive via PUSH (the same hosted path the
    // cloud host rides), not a local GitHub poll. Best-effort, fire-and-forget:
    // any failure just leaves IssueWatch on its local poller — no regression.
    // Skipped under E2E (no live Tynn) so a Playwright run never self-registers.
    //
    // IssueWatch is a Tynn service for every signed-in local Genie. It must not
    // depend on whether this machine exposes Genie Remote/Mobile hosting.
    if (!isE2E()) {
        let issueWatchHandle: Awaited<ReturnType<typeof startLocalWorkstation>> = null;
        const startIssueWatch = async () => {
            issueWatchHandle?.stop();
            issueWatchHandle = await startLocalWorkstation({
                inventory: async () => {
                    const workspaces = listWorkspaces();
                    const sites = await listLocalEnabledGenSites();
                    return {
                        workspaces: workspaces.map((workspace) => ({
                            id: workspace.id,
                            name: workspace.project_name,
                            projectId: workspace.project_id || null,
                            sites: sites
                                .filter((site) => site.workspaceId === workspace.id)
                                .map((site) => ({
                                    id: site.siteId,
                                    name: site.genName,
                                    hostname: site.hostname,
                                })),
                        })),
                    };
                },
                log: (m) => console.log('[workstation]', m),
            });
        };
        void isSignedIn().then((signedIn) => {
            if (signedIn) return startIssueWatch();
            setIssueWatchServiceState('signed-out');
        });
        onAuthChanged((signedIn) => {
            if (signedIn) void startIssueWatch();
            else {
                issueWatchHandle?.stop();
                issueWatchHandle = null;
                setIssueWatchServiceState('signed-out');
            }
        });
    }
    // Mobile remote-control server (Settings → Mobile, opt-in). Bound ONLY to the
    // Tailscale IP — fail closed if no tailnet. Reuses the SAME terminal/process/
    // workspace/question functions the desktop + MCP use (built as MobileDataDeps
    // here so DB/terminal access stays in main, like startMcpServer's deps).
    // Non-fatal: a failed bind just means no mobile endpoint.
    // Skipped under the mobile E2E harness, which already started the singleton
    // above with mock deps — this production call would overwrite `deps`.
    if (!isE2EMobile() && !isE2ETailscaleTunnel()) await startMobileServer({
        serverVersion: app.getVersion(),
        userDataDir: app.getPath('userData'),
        // The compiled app dir holding mobile.html + the static export.
        appDir: __dirname,
        // Opt-in, two independent surfaces (both default 'off'): the phone web UI
        // (mobile_enabled) and desktop Genie Remote (remote_enabled). The server
        // binds when EITHER is on; the phone UI route is gated on mobileUiEnabled,
        // so remote can be used without turning the Mobile toggle on.
        enabled:
            (getAllSettings() as Record<string, string>)['mobile_enabled'] === 'on' ||
            (getAllSettings() as Record<string, string>)['remote_enabled'] === 'on',
        mobileUiEnabled: (getAllSettings() as Record<string, string>)['mobile_enabled'] === 'on',
        remoteEnabled: (getAllSettings() as Record<string, string>)['remote_enabled'] === 'on',
        networkAccess: {
            local: (getAllSettings() as Record<string, string>)['remote_network_local'] !== 'off',
            lan: (getAllSettings() as Record<string, string>)['remote_network_lan'] === 'on',
            tailscale: (getAllSettings() as Record<string, string>)['remote_network_tailscale'] !== 'off',
            tynn: (getAllSettings() as Record<string, string>)['remote_network_tynn'] !== 'off',
        },
        configuredPort: () => {
            const raw = (getAllSettings() as Record<string, string>)['mobile_port'];
            const n = raw ? parseInt(raw, 10) : NaN;
            return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_MOBILE_PORT;
        },
        // One-time DESKTOP confirm before minting a session token, so a tailnet
        // peer who learns the PIN still can't pair silently. Reuses the same
        // OS-level ForceTheQuestion modal as the MCP approval gates.
        confirmPair: async ({ ip, ua }) => {
            const result = await forceQuestion([
                {
                    header: 'Pair phone?',
                    question:
                        `A device wants to pair for mobile remote control:\n\n` +
                        `• from: ${ip}\n` +
                        `• ${ua || 'unknown device'}\n\n` +
                        `Once paired it can drive terminals on this machine. ` +
                        `Approve only if this is YOUR device.`,
                    options: [
                        { label: 'Pair', description: 'Allow this device to connect.' },
                        { label: 'Deny', description: 'Reject — nothing is paired.' },
                    ],
                },
            ]);
            if (result.cancelled) return false; // dismissed = deny
            return (result.answers[0]?.selected ?? []).includes('Pair');
        },
        // Serve-local-sites (Phase C): the host reverse proxy's settings/allowlist
        // accessors. `localSitesEnabled` finally HOST-ENFORCES the master switch
        // Phase B only stored; `resolveSite` maps an opaque siteId → its loopback
        // target STRICTLY from the discovered + per-site-`enabled` + served set
        // (the SSRF/open-proxy guard — the remote can never supply a raw target).
        siteProxy: {
            localSitesEnabled: () =>
                (getAllSettings() as Record<string, string>)['local_sites_enabled'] === 'on',
            resolveSite: async (siteId) => {
                // Scope to THIS host's served workspaces (like /api/sites/set): a
                // site is servable if ANY served workspace enabled it. discoverSites
                // caches probes, so repeated resolves only re-parse the hosts file.
                for (const ws of listWorkspaces()) {
                    const views = await discoverSites(getWorkspaceTunnelSites(ws.id));
                    const hit = views.find((v) => v.siteId === siteId && v.enabled);
                    if (hit) {
                        return {
                            workspaceId: ws.id,
                            hostname: hit.hostname,
                            scheme: hit.scheme,
                            port: hit.port,
                        };
                    }
                    for (const owner of views.filter((v) => v.enabled)) {
                        const endpoint = owner.companions?.find((c) => c.siteId === siteId);
                        if (endpoint) {
                            return {
                                workspaceId: ws.id,
                                hostname: endpoint.hostname,
                                scheme: endpoint.scheme,
                                port: endpoint.port,
                                loopback: endpoint.loopback,
                                allowedOrigins: [owner.hostname, endpoint.hostname],
                            };
                        }
                    }
                }
                return null;
            },
        },
        data: {
            listWorkspaces: () =>
                listWorkspaces().map((w) => ({
                    id: w.id,
                    project_name: w.project_name,
                    path: w.path,
                })),
            listTerminalSpecs: () =>
                listTerminalSpecs().map((s) => ({
                    id: s.id,
                    workspace_id: s.workspace_id,
                    label: s.label,
                    type: s.type,
                    cwd: s.cwd,
                    live_cwd: s.live_cwd,
                })),
            listAllProcesses: () => listAllProcesses(),
            liveTerminalIds: () => {
                try {
                    return terminalManager().list().map((t) => t.id);
                } catch {
                    return [];
                }
            },
            startProcess: (id) => startProcess(id),
            stopProcess: (id) => stopProcess(id),
            restartProcess: (id) => restartProcess(id),
            createAgentTerminal: (opts) => createAgentTerminal(opts),
            createSpecializedAgentTerminal: (input) => createSpecializedAgentTerminal(input),
            restartAgentTerminal: (id) => restartAgentTerminal(id),
            updateAgentInboxChannel: (specId, patch) => updateAgentInboxChannel(specId, patch),
            killTerminalById: (id) => killTerminalById(id),
            writeToTerminal: (id, data) => writeToTerminal(id, data),
            readTerminalOutput: (id, o) => readTerminalOutput(id, o),
            getScrollback: (id) => {
                try {
                    return terminalManager().getScrollback(id) ?? '';
                } catch {
                    return '';
                }
            },
            resize: (id, cols, rows) => {
                try {
                    const ok = terminalManager().resize(id, cols, rows);
                    if (ok) recordTerminalSize(id, cols, rows);
                    return ok;
                } catch {
                    return false;
                }
            },
            // Repaint-on-drop (mobile bridge): nudge SIGWINCH so a full-screen
            // TUI re-emits a clean frame after a dropped one, restoring the pty
            // to its ACTUAL last-applied size (from the tracker) so it never
            // reflows the desktop terminal.
            repaint: (id) => {
                const s = getTerminalSize(id);
                if (!s) return;
                try {
                    const mgr = terminalManager();
                    mgr.resize(id, s.cols, s.rows + 1);
                    mgr.resize(id, s.cols, s.rows);
                } catch {
                    /* pty gone / resize unsupported — best-effort */
                }
            },
            // Host-clipboard image sync (remote image paste): place the client's
            // shipped PNG where THIS host's CLI reads it. On Windows/macOS that's
            // the OS clipboard (the client then sends the paste trigger); on a Linux
            // host it's a temp FILE and the returned `path` is what the client
            // pastes, because Claude Code can't reliably read a Linux clipboard
            // image (headless has none; headed needs xclip/wl-paste). Shared with
            // the local IPC handler via `writeClipboardImagePng`.
            writeClipboardImage: (png) => writeClipboardImagePng(png),
            listPendingQuestions: () => listPendingQuestions(),
            answerPendingQuestion: (id, answers) => answerPendingQuestion(id, answers),
            // Self-update ("Upgrade Genie" tool) — backed by the SAME updater
            // module the desktop pill drives, so a phone-triggered install walks
            // the identical quitAndInstall / two-phase teardown path.
            updateStatus: () => mobileUpdateStatus(),
            installUpdate: () => mobileInstallUpdate(),
            checkUpdate: () => mobileCheckUpdate(),
            // Serve-local-sites (Phase B): the host's discovered loopback dev
            // sites merged with a workspace's per-site tunnel settings (the §5
            // allowlist). Same discovery the local IPC (`sites:list`) uses — this
            // exposes it to a remote/programmatic caller over /api/sites.
            listSites: (workspaceId, opts) => {
                const settings = workspaceId ? getWorkspaceTunnelSites(workspaceId) : {};
                return discoverSites(settings, opts);
            },
            setSiteConfig: (workspaceId, siteId, patch) => {
                setWorkspaceTunnelSite(workspaceId, siteId, patch);
                return { ok: true };
            },
            // The host's ENABLED `.gen` sites aggregated across EVERY workspace's
            // allowlist — the enabled-only snapshot a remote reads over
            // /api/sites/enabled for its header `.gen` popover + Testing Browser
            // resolver. Same source the local IPC (`sites:all`) uses, so a remote
            // window sees exactly what a local one computes.
            listEnabledSites: () => listLocalEnabledGenSites(),
        },
    }).catch((e) => console.error('[mobile] failed to start', e));
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
    //   • UPDATE quit, host-backed   → ONLY an electron-mode detached host (the
    //     no-runtime fallback, which PINS Genie's binary as execPath) is
    //     snapshotted + gracefully shut down so NSIS can overwrite the binary.
    //     The normal case — a host on the user-data standalone runtime, or the
    //     OS service — pins NOTHING the updater touches and is LEFT RUNNING, so
    //     live terminals + their agents SURVIVE the upgrade and the relaunched
    //     Genie reattaches them.
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
            //   • 'detached' — the host is a detached child. It only PINS the
            //     binary when launched as Genie's execPath child; a detached host
            //     on the shipped standalone Node (the default when the runtime is
            //     present) does NOT pin genie.exe and SURVIVES the update like a
            //     service-backed host. So only kill when it actually pins
            //     (detachedHostPinsBinary) — conservative: unknown ⇒ pins ⇒ kill.
            if (shouldKillHostForUpdate(forUpdate, kind) && detachedHostPinsBinary()) {
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

/**
 * Open the E2E harness window (GENIE_E2E only). Loads the harness route named by
 * `GENIE_E2E_PAGE` (default `e2e-issuewatch`), which mounts a real flyout open
 * against the scriptable mock (main/e2e/mock.ts). Each spec picks its page:
 *   - `e2e-issuewatch` → IssueWatchFlyout (device-flow reconnect),
 *   - `e2e-ghcaps`     → GithubCapabilitiesFlyout (per-install resolve flow).
 * Plain BrowserWindow, shown immediately so Playwright can attach to its first
 * window.
 */
function showE2EWindow(): void {
    // Allowlist the harness routes so a stray env value can't load an arbitrary
    // page; default to the issue-watch harness for back-compat.
    const requested = process.env.GENIE_E2E_PAGE ?? 'e2e-issuewatch';
    const ALLOWED = ['e2e-ghcaps', 'e2e-issuewatch', 'e2e-agent-access'] as const;
    const page = (ALLOWED as readonly string[]).includes(requested)
        ? requested
        : 'e2e-issuewatch';
    if (page === 'e2e-agent-access') {
        // Seed the fixture workspaces BEFORE the window loads — the harness page
        // resolves its target by listing on mount, so the rows must already exist.
        // Also resets agent_access, since the E2E profile is reused across runs.
        try {
            seedAgentAccessE2E();
        } catch (e) {
            console.error('[e2e] agent-access seed failed', e);
        }
    }
    const win = new BrowserWindow({
        width: 900,
        height: 760,
        show: true,
        title: 'Genie E2E',
        backgroundColor: '#0a0a0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    if (isDev) {
        win.loadURL(`http://localhost:8888/${page}`);
    } else {
        win.loadFile(path.join(__dirname, `${page}.html`));
    }
}

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
