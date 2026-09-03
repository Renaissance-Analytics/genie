import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    nativeImage,
    Notification,
    session,
} from 'electron';
import fs from 'fs';
import path from 'path';
import { createTray, rebuildMenu } from './tray';
import { registerShortcuts, unregisterShortcuts } from './shortcuts';
import { openDebugLog } from './debug-log';
import { launchedFromAutostart } from './autostart';
import { resolveWorkstationTui } from './agents/tui';
import { ensureGenieOsWorkspace, wireGenieOsWorkspace } from './agents/os-workspace';
import { GENIE_OS_TERMINAL_ID, obsoleteOsAgentSpecIds, osAgentLaunchCommand } from './agents/os-agent';
import {
    osAgentBootInstructions,
    readWorkstationEvidence,
    recordOsAgentBoot,
} from './agents/os-lifecycle';
import {
    applyWorkstationResetAtBoot,
    isWorkstationResetPending,
    type ResetFailure,
} from './workstation/reset';
import { providerDef } from './agents/registry';
import { ensureOwnedProvidersInstalled } from './agents/availability';
import { liveAvailabilityDeps } from './agents/availability-effects';
import { appendLaunchFlags } from './agentinbox/session-capture';
import { registerIpcHandlers, applyStartupToolchainPrecedence, addWorkspaceFromFolder } from './ipc';
import {
    agentRecordsList,
    agentRecordCreate,
    agentRecordStart,
    agentRecordDelete,
    agentRecordSetDefault,
    agentRecordAddRuntime,
    agentRecordFront,
    agentRecordSetAvatar,
} from './ipc';
import { writeClipboardImagePng } from './clipboard-image';
import crypto from 'node:crypto';
import os from 'node:os';
import {
    initDatabase,
    listWorkspaces,
    listTerminalSpecs,
    listWorkspaceAgents,
    getTerminalSpec,
    getAllSettings,
    setSettings,
    getWorkspace,
    toWorkspaceAppKind,
    createTerminalSpec,
    updateTerminalSpec,
    deleteTerminalSpec,
    workspaceProcessApproval,
    workspaceTerminalApproval,
    removeWorkspace,
    getWorkspaceDevSites,
    setHostedSitesSync,
    getWorkspaceDevServices,
    getOrCreateDevServiceEngine,
    getDevServicePorts,
    saveDevServicePorts,
} from './db';
import { listLocalEnabledGenSites, resolveEnabledSite } from './sites/local-sites';
import { remoteGenUrl } from './sites/gen-url';
import { LOCAL_CONN_KEY, openTestingBrowser } from './testing-browser';
import { devLifecycle } from './dev-server/lifecycle';
import {
    devServiceEnvFor,
    devServiceHostEnvFor,
    devServiceHostEnvReportFor,
} from './dev-server/services/service-manager';
import { resolveContainerRuntime } from './dev-server';
import { devServerHostBrowserRoutes } from './dev-server/site-manager';
import { createDesktopHostBrowserReconciler } from './dev-server/host-browser-desktop';
import { waitForHttp } from './dev-server/port-probe';
import { preferredServicePort } from './dev-server/services/service-ports';
import { createBundledHostWebSocketService } from './dev-server/services/host-websocket';
import type { HostBrowserReconciler } from './dev-server/host-browser-reconcile';
import { initHosting, type HostingHandles } from './host-core/hosting';
import {
    writeWorkspaceAgentMcp,
    healTynnMcpEntry,
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
    broadcastTerminalReveal,
    broadcastPluginPanelOpen,
    announceInboxIncoming,
    beginInputHold,
    releaseInputHold,
    isTerminalLive,
} from './terminal/ipc';
import { installAgentInboxPresence } from './agentinbox/presence';
import { agentInboxBroker } from './agentinbox/broker';
import { harnessTransportRegistry } from './agentinbox/harness-transport';
import { createHarnessTransportSink } from './agentinbox/transport-sink';
import { agentShutdownReadiness } from './agents/shutdown-readiness';
import { setPluginPanelOpenSink } from './plugins/registry';
import { announceAgentUpgrade, withWorkstationOperator } from './agents/upgrade-announcement';
import { MANUAL_RECOVERY, reconnectStrategy, type McpRecovery } from './agents/mcp-reconnect';
import { terminalIsBlocked } from './agents/injection-guard';
import { getChangelog } from './updater/changelog';
import { deliverNudge, type NudgeIO } from './agentinbox/nudge-delivery';
import { dbAgentInboxStore } from './agentinbox/store';
import { getWorkspaceAgentAccess } from './db';
import { getTynnBackend } from './backend/registry';
import { installKnowledgeBroadcast } from './knowledge/presence';
import {
    stripAnsi,
} from './terminal/keystrokes';
import {
    startMcpServer,
    workspaceEndpointUrl,
    pushToWorkspace,
    pushToTerminal,
    serverPushDiagnostics,
    DEFAULT_MCP_PORT,
    registerTerminalEndpoint,
} from './mcp/server';
import { startControlServer } from './control';
import { startMobileServer, DEFAULT_MOBILE_PORT } from './mobile/server';
import {
    listPendingQuestions,
    answerPendingQuestion,
    desktopQuestionTransport,
    setDeferredAnswerSink,
    formatDeferredAnswer,
    type DeferredAnswerDelivery,
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
import {
    getScheduleInfo,
    runScheduleNow,
    startSchedules,
    stopSchedules,
} from './terminal/process-scheduler';
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
import { buildWorkstationInventory, startLocalWorkstation } from './tynn/local-workstation';
import { startManagedCredentials } from './tynn/managed-credentials-service';
import { startUserChannelIssueWatch } from './tynn/user-channel-issuewatch';
import { setIssueWatchRefreshTransport } from './issue-watch/force-refresh';
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
import {
    broadcastDevServerChanged,
    broadcastDevSiteProgress,
    broadcastWorkspacesChanged,
} from './ipc';
import {
    initTerminalBackend,
    isHostBacked,
    disconnectHostLeaveRunning,
    terminalManager,
    getHostClient,
} from '@particle-academy/fancy-term-host';
import {
    wireTerminalAdapter,
    killHostForUpdate,
    snapshotHostTerminalsForUpdate,
    detachedTerminalsEnabled,
    electronEncryptor,
    buildHostRecoveryDeps,
    broadcastToWindows,
} from './terminal/genie-adapter';
import {
    TERMINAL_RECOVER_CHANNEL,
    TERMINAL_RECOVERY_STATUS_CHANNEL,
    type RecoveryState,
} from './terminal/recovery-channels';
import { setSecretEncryptor } from './secrets/store';
import { buildHostServerDeps } from './host-core/server-deps';
import { registerAppBridge } from './apps/bridge';
import { registerAppsIpc, sweepPreviewsAtBoot } from './apps/ipc';
import { registerFlowsIpc } from './flows/ipc';
import { registerAppsE2E } from './e2e/apps';
import type { HostCorePorts } from './host-core/ports';
import {
    hostBackendKind,
    shouldKillHostForUpdate,
    detachedHostPinsBinary,
    wireHostLossRecovery,
    recoverFromHostLoss,
    resolveShippedCaddyBin,
} from './terminal/host-service';
import { runBackendSelection as runBackendSelectionCore } from './host-core/backend-selection';
import {
    liveHostTerminals,
    shouldConfirmQuit,
    confirmQuitTerminals,
    pickDialogWindow,
} from './terminal/quit-confirm';
import { workspaceIdOfTerminal } from './terminal/workspace-of-terminal';
import { planImDoneNotice } from './attention/imdone-notice';
import { terminalNoticeFacts } from './attention/terminal-facts';
import { registerOpenFile } from './editor/open-file';
import {
    registerHostTools,
    createSpecializedAgentTerminal,
    restartAgentTerminal,
    updateAgentInboxChannel,
} from './mcp/host-tools';
import { isQuittingForUpdate } from './updater/quit-state';
import {
    REOPEN_AFTER_UPDATE_KEY,
    shouldShowMasterWindowOnBoot,
} from './updater/reopen-after-update';
import { markDesktopRuntime, isHeadless } from './runtime-mode';
import { registerFilesIpc } from './files/ipc';
import { registerGithubIpc } from './github/ipc';
import { registerPluginsIpc } from './plugins/ipc';
import { registerRepoIpc } from './repo/ipc';
import { registerPluginEditorBridge } from './plugins/editor-bridge';
import { registerDocumentConvert } from './plugins/document-convert';
// (plugin editor-routing is consumed via the plugins:editor-for IPC in
// editor-bridge.ts — CodePanel asks it per tab open.)
import { reconcileBundledPlugins, revalidateAllPluginTrust } from './plugins/install';
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
import { seedRepoE2E } from './e2e/repo';
import { seedAgentPulseE2E } from './e2e/agent-pulse';
import { seedMasterE2E } from './e2e/master';

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
        const notice = planImDoneNotice(terminalNoticeFacts(terminalId));
        const n = new Notification({
            title: notice.title,
            body: notice.body,
            // Silence the OS chime only when OUR chime actually plays, so we
            // don't double up — but if the alert sound is off, let the OS sound.
            silent: !!sound,
        });
        n.on('click', () => {
            // Surface (creating if needed) the master window — the previous
            // `mainWindow` reference is never assigned, so this used to focus an
            // arbitrary window and did nothing when tray-resident.
            showMasterWindow();
            // …then go to the terminal that actually finished. Surfacing the
            // window alone left the user on whatever workspace happened to be
            // active, which is the hunt this toast exists to end.
            broadcastTerminalReveal(terminalId, workspaceIdOfTerminal(terminalId));
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
// The external-browser host reconcile (story #238): brings up the host CA +
// hosts-file + Caddy :443 for browser-exposed host-native sites. Created once at
// hosting init; fired on boot + (debounced) on every `.gen` change.
let hostBrowserReconciler: HostBrowserReconciler | null = null;
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

/**
 * The desktop's pty/window bindings for {@link deliverNudge} — the injected I/O
 * that module documents. The sequencing, the always-give-the-keyboard-back rule
 * and the did-it-actually-land accounting live there, where they are testable;
 * this is only the wiring.
 */
const nudgeIO: NudgeIO = {
    write: (terminalId, bytes) => writeToTerminal(terminalId, bytes),
    releaseHold: (terminalId) => releaseInputHold(terminalId),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

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
    debugLog.fail('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[Genie main] unhandledRejection — kept alive:', reason);
    debugLog.fail('unhandledRejection', reason);
});

/**
 * `--genie-debug`: the startup log, opened before anything that can fail.
 *
 * Genie writes no log otherwise, so a start that dies before its window exists
 * leaves nothing behind — the failure mode that made diagnosing Omarchy a
 * conversation instead of a file. Inactive and free unless the flag is passed.
 *
 * Opened at module scope, not inside whenReady: a crash during app init would
 * otherwise happen before the logger exists, which is exactly the crash worth
 * catching.
 */
const debugLog = openDebugLog({
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
});
debugLog.note('main module loaded; waiting for app ready');

/**
 * Tell the user a workstation reset did not finish.
 *
 * An OS message box rather than a toast, for the same reason
 * `reportAgentSeedingRefusal` uses one: this fires during boot, where there may
 * be no window at all (tray-resident launch, autostart, "start minimised"), and
 * a partial reset is precisely the failure that otherwise looks like success —
 * Genie comes up fine while state the user asked to have removed is still
 * there. Non-blocking; boot carries on either way.
 */
function reportWorkstationResetFailures(failures: ResetFailure[]): void {
    const detail = failures.map((f) => `${f.entry} — ${f.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`[workstation reset] incomplete:\n${detail}`);
    debugLog.fail('workstation reset incomplete', new Error(detail));
    void dialog
        .showMessageBox({
            type: 'warning',
            title: 'Genie',
            message: 'The workstation reset did not finish.',
            detail:
                `Genie removed everything else, but these items are still there:\n\n${detail}\n\n` +
                'They are usually held open by something still running. Genie will not try again — ' +
                'restart the computer and reset again if you need them gone.',
            buttons: ['OK'],
            noLink: true,
        })
        .catch(() => {
            /* no window to host the dialog — the console + debug log above stand */
        });
}

/**
 * Tell every live agent that Genie upgraded — and repair the connection the
 * upgrade broke, first (genie#346).
 *
 * MUST be called AFTER `startMcpServer`. It used to run in the AgentInbox
 * wiring block, hundreds of lines earlier, which meant the reconnect was
 * performed against an endpoint that was not listening yet: `/mcp reconnect
 * genie` was typed into a Claude terminal before there was anything to connect
 * to, and no harness channel could possibly have re-bound, so every notice was
 * composed as "not attached" and typed at a prompt. Ordering it here is the
 * structural half of the fix; `AGENT_UPGRADE_TRANSPORT_GRACE_MS` is the other,
 * giving the channel bridges their few seconds to come back.
 *
 * Best-effort throughout: an upgrade notice must never be able to block boot.
 */
function announceUpgradeToAgents(): void {
    try {
        const currentVersion = app.getVersion();
        const previousVersion = getAllSettings().agent_upgrade_announced_version;
        if (previousVersion === currentVersion) return;
        void getChangelog(currentVersion, previousVersion).then((changelog) => {
            announceAgentUpgrade({
                currentVersion,
                previousVersion,
                // NAME as well as id: an agent called `general` is never
                // nudged (Tynn story #262), and `announceAgentUpgrade`
                // cannot enforce that without knowing what each one is
                // called. `purpose` IS the agent's name — a saved agent's
                // name is its channel purpose.
                // …and the workstation OPERATOR, whatever the directory
                // says (genie#352). It is the one agent that can be missing
                // from it — deliberately not a workspace agent — so the ONE
                // broadcast that exists to tell agents the ground moved
                // under them reached everyone except the agent whose job is
                // the machine.
                agents: withWorkstationOperator(
                    agentInboxBroker.directory()
                        .filter((agent) => agent.status !== 'offline')
                        .map((agent) => ({ agentId: agent.agentId, name: agent.purpose })),
                ),
                changes: changelog.groups.flatMap((group) => group.changes).slice(0, 8),
                // Reconnect the agent's `genie` server BEFORE telling it
                // anything: the upgrade replaced the process behind the
                // endpoint, so the notice would otherwise arrive telling it
                // to call tools that will not answer.
                //
                // RETURNS what it managed to do, so the notice can say so. Both
                // repairs can legitimately refuse — `wakeTerminalIfIdle` will
                // not type over a live prompt, `restartAgentTerminal` will not
                // drop an agent with no resumable session — and an agent told
                // "Genie reconnected you" when nothing happened acts on a lie.
                reconnect: (agentId): McpRecovery => {
                    // ITS OWN SEND, and per-harness. A raw write plus CR does
                    // not use the terminal's real submit bytes, so the command
                    // was TYPED and never submitted -- and the upgrade notice
                    // then landed in the same box, the two sharing one line.
                    const info = agentInboxBroker.getInfo(agentId);
                    const terminalId = info?.terminalId;
                    // No terminal to reach: the agent is still told how to
                    // reconnect itself rather than left to discover dead tools.
                    if (!terminalId) return MANUAL_RECOVERY;
                    const spec = getTerminalSpec(terminalId);
                    const strategy = reconnectStrategy(spec?.meta?.agent as string | undefined);
                    if (strategy.kind === 'command') {
                        // Through the nudge machinery: it holds the keyboard,
                        // submits properly, replays anything typed during the
                        // swap, and refuses when the agent is not provably idle.
                        const typed = agentInboxBroker.wakeTerminalIfIdle(terminalId, strategy.text);
                        return { strategy, applied: typed };
                    }
                    if (strategy.kind === 'restart') {
                        // Codex has no reconnect command and does not discover
                        // the replacement URL -- Genie passes it in launch
                        // config, so the running process keeps the old one. A
                        // managed restart resumes the session against refreshed
                        // config, OUT OF BAND, with nothing typed at a prompt
                        // that may be a modal.
                        return { strategy, applied: restartAgentTerminal(terminalId).ok };
                    }
                    // A provider Genie cannot repair (genie#346). It used to get
                    // NOTHING and stay disconnected until a human noticed; now
                    // its terminal glows for attention and the notice carries
                    // the instruction. Nothing is typed — the whole reason this
                    // provider has no command is that Genie cannot read its
                    // prompt.
                    broadcastTerminalAttention(terminalId, true);
                    return { strategy, applied: false };
                },
                send: (agentId, text) =>
                    agentInboxBroker.send({ system: true, toAgentId: agentId, text }).ok,
                persist: (version) => setSettings({ agent_upgrade_announced_version: version }),
            });
        });
    } catch {
        /* best-effort — the upgrade notice never blocks or breaks boot */
    }
}

app.whenReady().then(async () => {
    debugLog.note('app ready');
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

    // A reset is applied before THIS process's database, terminal host, service
    // or window opens the files. It is NOT applied before the PREVIOUS
    // process's children are gone: a detached pty-host is designed to outlive
    // the quit, and an OS-service host outlives it by definition. So the two
    // directories holding those running executables — `runtime/` and
    // `pty-host/` — stay outside the reset boundary alongside the managed
    // toolchain, which survives intact (see workstation/reset.ts).
    //
    // Guarded, and it reports itself: an unguarded throw here used to abort the
    // boot before `initDatabase`, leaving Genie half-started with no IPC and no
    // window, forever — the marker was only cleared after the deletions, so
    // every subsequent boot repeated it (genie#349).
    applyWorkstationResetAtBoot(app.getPath('userData'), reportWorkstationResetFailures);
    initDatabase(app.getPath('userData'));
    const genieOsWorkspace = await ensureGenieOsWorkspace(app.getPath('userData'));
    // The OSA is wired further down, AFTER `startMcpServer` — see genie#319.
    for (const obsoleteId of obsoleteOsAgentSpecIds(listTerminalSpecs())) {
        deleteTerminalSpec(obsoleteId);
    }
    // The workstation operator is built in, not a project-owned configuration.
    // Persist only its terminal shell so it can resume like every other agent;
    // `system:true` keeps it outside every project and the fixed id makes this
    // seed idempotent across upgrades.
    const existingOsAgent = getTerminalSpec(GENIE_OS_TERMINAL_ID);
    // The BOOT TASK only. The AgentBuilder skill used to be concatenated here
    // and typed into the TUI as a positional prompt on every relaunch -- 1.2KB
    // of SKILL.md, frontmatter and all, arriving with no task attached. It is
    // installed as a skill file by `wireGenieOsWorkspace` now, so the operator
    // loads it when it is relevant instead of wearing it as an opening prompt.
    // genie#352 — the mode is DERIVED from evidence a reset would clear, not
    // from a dotfile that (until #348) could never be written, and the boot
    // RECORDS it so the next one needs no evidence at all. Without this the
    // operator was handed the first-boot script on every single restart and
    // re-ran onboarding instead of resuming as the workstation's operator.
    const osAgentInstructions = osAgentBootInstructions(
        recordOsAgentBoot(
            app.getPath('userData'),
            readWorkstationEvidence(app.getPath('userData'), listWorkspaces().length > 0),
        ),
    );
    const osSettings = getAllSettings();
    const osProvider = resolveWorkstationTui(osSettings);
    const osDef = providerDef(osProvider);
    const osBase = osSettings[osDef.commandSettingKey] || osDef.defaultCommand;
    const osCommand = osAgentLaunchCommand(
        osProvider,
        appendLaunchFlags(osBase, osSettings[osDef.flagsSettingKey] || ''),
    );
    // Detect-and-install pass for provider binaries GENIE OWNS — `genie`, the
    // TUI, and `kiwi` (genie#313). Only when it is actually WANTED: a
    // workspace exists (a saved agent there might pick it), or the OSA above
    // is itself configured to use it — never on a host that will never launch
    // either one. Fire-and-forget from boot's perspective, the same as the
    // hosting managers below ("creating the managers starts NOTHING") — an
    // install must never hold up app startup, however long it takes. A launch
    // attempted before this resolves fails OPEN (`launchBlockReason` only
    // blocks a provider the pass already recorded `unavailable`), so nothing
    // regresses; `ensureProviderInstalled` also resolves rather than rejects
    // for every real failure mode, so this catch is only for a defect in the
    // pass itself.
    ensureOwnedProvidersInstalled(
        { hasWorkspace: listWorkspaces().length > 0, osaProvider: osProvider },
        liveAvailabilityDeps,
    ).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('[agents] provider availability check failed', e);
    });
    if (!existingOsAgent) {
        createTerminalSpec({
            id: GENIE_OS_TERMINAL_ID,
            workspace_id: null,
            label: 'Genie',
            cwd: genieOsWorkspace,
            type: 'terminal',
            meta: {
                system: true,
                agent: osProvider,
                agent_command: osCommand,
                agent_id: 'genie:workstation',
                agent_instructions: osAgentInstructions,
                whisper_purpose: 'genie',
                whisper_scope: 'all',
                whisper_wake_on_dm: true,
            },
        });
    } else if (
        existingOsAgent.cwd !== genieOsWorkspace ||
        existingOsAgent.workspace_id !== null ||
        existingOsAgent.meta.agent_instructions !== osAgentInstructions ||
        existingOsAgent.meta.agent !== osProvider ||
        existingOsAgent.meta.agent_command !== osCommand
    ) {
        updateTerminalSpec(existingOsAgent.id, {
            cwd: genieOsWorkspace,
            workspace_id: null,
            meta: { ...existingOsAgent.meta, system: true, agent: osProvider, agent_command: osCommand, agent_id: 'genie:workstation', agent_instructions: osAgentInstructions },
        });
    }
    // The container DEV SERVER — sites (#234 P2), services (P3) and their
    // lifecycle (P4). Hosting is an agent ability, so the WIRING lives in
    // host-core's `initHosting`; this desktop shell supplies only the Electron +
    // genie.db-backed ports (the headless genie-cloud host supplies its own).
    // Creating the managers starts NOTHING — no runtime is probed and no daemon
    // touched until a site or service is acted on, so a machine with no Docker
    // pays nothing, and nothing comes up on boot of a workspace nobody asked to
    // serve. `initHosting` builds services before sites (a site reads its
    // workspace's service env when it starts) and reads both lazily for the
    // lifecycle — the ordering the four inline calls used to encode by hand.
    // The external-browser reconcile (story #238): live browser-exposed host-
    // native routes → the real host CA + hosts-file + Caddy :443. Assembled once;
    // fired on boot and (debounced) on every `.gen` change below. No-op — and no
    // admin prompt — until a site is opted in.
    // Write a per-site generated Caddyfile under the Genie data dir, returning its
    // path — the fs seam behind `writeServeConfig`. The siteId is a devSiteIdFor
    // hash (a safe path segment); guarded anyway so nothing user-derived escapes.
    function writeHostServeConfig(siteId: string, content: string): string {
        if (!/^[A-Za-z0-9_-]+$/.test(siteId)) {
            throw new Error(`unsafe site id ${JSON.stringify(siteId)}`);
        }
        const dir = path.join(app.getPath('userData'), 'host-site-configs');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${siteId}.caddyfile`);
        fs.writeFileSync(file, content);
        return file;
    }

    // The ONE bundled-Caddy resolution, shared by the `.gen` front door and the
    // `hostServe` (static / php) site server — the two roles Genie's Caddy plays.
    // It resolves to the per-user COPY, outside the install dir: run from
    // `<INSTDIR>\resources\runtime\caddy.exe` it sat inside the NSIS installer's
    // path sweep, so every update killed the front door and every static/php
    // site's server with it (genie#265; measured in
    // `.ai/_discovery/genie-process-supervisor.md` §3.4). Resolved once so the
    // two callers can never end up on different binaries.
    const hostCaddyBin = resolveShippedCaddyBin();
    let hostingHandles: HostingHandles | null = null;
    hostBrowserReconciler = createDesktopHostBrowserReconciler({
        userDataDir: app.getPath('userData'),
        caddyBin: hostCaddyBin,
        platform: process.platform,
        routes: () => [
            ...devServerHostBrowserRoutes(),
            ...(hostingHandles?.services.hostBrowserRoutes() ?? []),
        ],
        log: (m) => console.warn('[host-browser]', m),
    });
    // A workspace as the hosting managers see it. `appKind` travels with it so a
    // purge about to drop a SHARED engine's data volume can say whose data is in
    // there — an installed Genie App's, or an ordinary project's (Tynn #250).
    const asDevWorkspace = (w: { id: string; path: string; project_name: string; app_kind?: string | null }) => {
        const appKind = toWorkspaceAppKind(w.app_kind);
        return { id: w.id, path: w.path, label: w.project_name, ...(appKind ? { appKind } : {}) };
    };
    hostingHandles = initHosting({
        resolveRuntime: () => resolveContainerRuntime(),
        listWorkspaces: () => listWorkspaces().map(asDevWorkspace),
        workspaceFor: (id) => {
            const row = getWorkspace(id);
            return row ? asDevWorkspace(row) : null;
        },
        devSitesFor: (id) => getWorkspaceDevSites(id),
        devServicesFor: (id) => getWorkspaceDevServices(id),
        // Machine-scoped, minted once per engine CONTAINER: a shared engine's
        // superuser credential cannot live in any one workspace's row.
        engineAdmin: (req) => getOrCreateDevServiceEngine(req),
        hostWebSockets: createBundledHostWebSocketService({
            resourcesPath: process.resourcesPath,
            userDataDir: app.getPath('userData'),
            port: preferredServicePort('reverb-1', 'websocket'),
            probe: (port) => waitForHttp(port, 60_000),
        }),
        // Machine-scoped for the same reason the credential is: the publication
        // belongs to the CONTAINER, which several workspaces may share. Keeping it
        // is what stops a port moving when the derived one was unavailable once.
        servicePorts: {
            read: (recordKey) => getDevServicePorts(recordKey),
            save: (recordKey, ports) => saveDevServicePorts(recordKey, ports),
        },
        // This workspace's provisioned services, as environment. `initHosting`
        // ENSURES they are up (acquire) before handing them to a starting site,
        // so a dev server never comes up pointed at an engine that is not there.
        devServiceEnvFor: (id) => devServiceEnvFor(id),
        // Same services in HOST form (127.0.0.1:<published port>) for a HOST-NATIVE
        // site's dev server (story #238 / beta.237).
        devServiceHostEnvFor: (id) => devServiceHostEnvFor(id),
        // …with the diagnostic behind an EMPTY result, so a host-native start logs
        // WHY it got no service env rather than serving DB-less (moic's beta.245).
        devServiceHostEnvReportFor: (id) => devServiceHostEnvReportFor(id),
        // A host-native site's dev server runs as a real HOST process; its captured
        // output is logged here (under the Genie data dir).
        hostSiteLogDir: path.join(app.getPath('userData'), 'host-sites'),
        // Genie's bundled Caddy + where its generated per-site configs are written,
        // so a `hostServe` (static / php) site is served by Genie's own web server —
        // the agent declares a mode, Genie writes the config (moic/blockchain: no
        // hand-rolled nginx). The SAME resolved binary the host `.gen` proxy uses,
        // which for these sites matters twice over: this Caddy IS the site's server
        // process, so an update that killed it took the site down, not just its route.
        caddyBin: hostCaddyBin,
        writeServeConfig: (siteId, content) => writeHostServeConfig(siteId, content),
        // Which php/node version this machine defaults to (Settings → Toolchain).
        // A Genie-served site follows it unless it pins one, and the spawn resolves
        // THAT install's real executable instead of asking PATH (genie#207).
        readToolchainDefaults: () => getAllSettings().toolchain_defaults,
        confirmImagePull: confirmContainerImagePull,
        // The `.gen` change event, so the header popover, the rail icon, the Site
        // Manager and the Testing Browser's resolver all re-pull when a container
        // starts or stops. Fires for both managers. Also (debounced) re-reconciles
        // the external browser's host Caddy/hosts when a browser-exposed site
        // starts, stops, or is toggled.
        onChanged: () => {
            broadcastDevServerChanged();
            hostBrowserReconciler?.schedule();
        },
        // A repo `.env` Genie could not keep current (read-only, open, not checked
        // out), or one it kept current inside a git-TRACKED file. Both used to be
        // discarded, which left a moved port looking exactly like a broken
        // database. Logged rather than thrown: an engine must still come up.
        onServiceEnvProblem: (message) => {
            console.warn(`[genie] service .env: ${message}`);
        },
        // Live site START progress (Gap 2) — pushed to any open Site Manager so a
        // card shows `pulling → building → starting → ready` with the build log
        // streaming, instead of a disabled button until the build finishes.
        onSiteProgress: (progress) => broadcastDevSiteProgress(progress),
        // `manageSite open` — the ONE desktop-shaped action; the headless build
        // leaves it off and `open` says "no browser here" rather than failing.
        openInBrowser: (genName) =>
            openTestingBrowser(LOCAL_CONN_KEY, 'This machine', remoteGenUrl(genName)),
    });
    // Mirror a Tynn-linked envelope's hosted-site config to Tynn (#661) whenever
    // it is persisted, so the hosting control UX can track it. Fire-and-forget:
    // a dead session or offline Tynn must never fail the local write. db.ts
    // resolves the linked project id and calls this; it must not import the Tynn
    // client (tynn.ts imports db.ts, which would cycle).
    setHostedSitesSync((projectId, sites) => {
        void getTynnBackend()
            .syncHostedSites(projectId, sites)
            .catch(() => {
                /* offline / unlinked / dead session — the envelope stays the truth */
            });
    });
    // Install the secrets-at-rest encryptor for ALL token stores (mobile / remote
    // / GitHub) BEFORE anything reads them. Desktop injects the Electron
    // safeStorage-backed impl; genie-cloud injects its KMS one. Fail-closed: if
    // unavailable, those stores keep secrets in memory only (never plaintext).
    setSecretEncryptor(electronEncryptor());
    // Inject the two desktop-GUI hooks the extracted MCP tools need (tray-menu
    // rebuild + surfacing the master window). Headless leaves these as no-ops.
    registerHostTools({
        rebuildMenu,
        showMasterWindow,
        // The SAME registration the Add-workspace UI performs, so an operator
        // agent and a human land in exactly one code path.
        addWorkspaceFolder: async (path) => addWorkspaceFromFolder(path),
    });
    // The four host-core ports, Electron-backed. The headless genie-cloud build
    // injects KMS / fail-closed / log impls of the same interfaces. These power
    // the GUI-free server-deps factory (buildHostServerDeps) below.
    const electronPorts: HostCorePorts = {
        encryptor: electronEncryptor(),
        questionTransport: desktopQuestionTransport,
        notifier: { imDone: (terminalId) => notifyImDone(terminalId) },
        lifecycle: { keepAlive: () => {} },
    };
    // Genie's own toolchain FIRST on PATH, before anything that spawns a child
    // exists — terminals, sites, services, agents. Awaited: a terminal created
    // in the same tick as the scan would otherwise race it and inherit the
    // machine's ordering, which is the exact fault being fixed (genie: Herd
    // uninstalled, its binaries and PATH entry left behind, `php` still Herd's).
    await applyStartupToolchainPrecedence();
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
    // Host-loss watchdog (genie#203): when the single shared detached host dies
    // mid-session, fancy-term-host only reverts to in-process + toasts, leaving
    // every terminal frozen. Arm its socket-close 'error' → recover (snapshot →
    // respawn via backend selection → tell the renderer to remount + replay →
    // structured status). Re-arms onto the respawned client. Detects the clean
    // death modes today; the HUNG-host case (pipe stays open, no event) is gated
    // on an upstream heartbeat (Particle-Academy/fancy-term-host#11).
    if (selection.kind === 'detached' || selection.kind === 'service') {
        wireHostLossRecovery({
            getActiveClient: () => {
                const c = getHostClient();
                return c ? { once: (e, cb) => c.once(e, cb) } : null;
            },
            recover: () =>
                recoverFromHostLoss(
                    buildHostRecoveryDeps(async () => {
                        const s = await runBackendSelection();
                        return { host: s.host };
                    }),
                ),
        });
    }
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
        // The broker decides WHAT to say and HOW it may land (see agentinbox/
        // draft.ts); this sink performs it. Returns false when it cannot start,
        // so the broker can fall back to the idle-only wake.
        agentInboxBroker.setWakeSink(({ terminalId, text, plan }) => {
            // NEVER type into a terminal parked on someone else's prompt.
            // Silence is not idleness: a TUI sitting on its own modal emits
            // nothing, so the idle checks say it is safe. Codex's update
            // prompt is the case that proved it -- a stray keystroke there
            // picks "1. Update now" and runs a global npm install.
            //
            // A veto, not a permission: it runs on top of the idle gate. The
            // cost of being wrong is a deferred nudge; the cost the other way
            // is answering a modal on the user's behalf.
            if (terminalIsBlocked(readTerminalOutput(terminalId, { bytes: 2000 }).data)) {
                return false;
            }
            // One swap per terminal: a second notice must never cut the same box
            // while the first is still putting the draft back.
            if (!beginInputHold(terminalId)) return false;
            void deliverNudge(nudgeIO, terminalId, text, plan);
            return true;
        });
        agentInboxBroker.setPendingNudgeSink(({ terminalId, pending }) => {
            announceInboxIncoming(terminalId, false, pending);
        });
        agentInboxBroker.setTransportSink(createHarnessTransportSink(harnessTransportRegistry));
        // The PTY notice and the unread backstop are for an agent with NO
        // channel of its own. This is how the broker knows which agents those
        // are — the backstop is armed on imDone, where no message is in hand and
        // the transport sink is never consulted (genie#344).
        agentInboxBroker.setHarnessAttachedResolver((agentId) =>
            harnessTransportRegistry.isVerified(agentId),
        );
        // AgentInbox OUTER tier: the broker asks the workspaces table who may reach
        // into a given workspace. Kept a seam so the broker stays db-free (and
        // permissive when unwired, e.g. in unit tests).
        agentInboxBroker.setWorkspaceAccessResolver((workspaceId) =>
            getWorkspaceAgentAccess(workspaceId),
        );
        // Server-push: on live delivery, nudge the recipient's MCP GET SSE stream
        // (the "inbox over a hooked connection" path). Route per-agent via its
        // terminal's session when the client echoed one; else fall back to the
        // whole workspace. A no-op when the agent has no open stream (returns 0).
        agentInboxBroker.setNotifySink((target, msg) => {
            const notification = {
                method: 'notifications/message',
                params: {
                    level: 'info',
                    logger: 'agentinbox',
                    data:
                        msg.kind === 'dm'
                            ? `New AgentInbox DM from ${msg.fromLabel}`
                            : `New AgentInbox channel message from ${msg.fromLabel}`,
                },
            };
            const perAgent = pushToTerminal(target.terminalId, notification);
            if (perAgent === 0) pushToWorkspace(target.workspaceId, notification);
        });
        // PendingQuestions (genie #62): a DND-deferred ForceTheQuestion answer is
        // delivered back to the asking agent THROUGH the inbox — append + wake +
        // stream-nudge — so the agent PULLs it (ping/poll/pull) instead of the answer
        // being dropped. force-question stays broker-free via this injected sink.
        setDeferredAnswerSink((d: DeferredAnswerDelivery) => {
            agentInboxBroker.deliverHumanMessageToTerminal(
                d.terminalId,
                formatDeferredAnswer(d),
                // This is the human ANSWERING a question this agent asked, not
                // ordinary mail. It arrived as "You just received a message from
                // You as a DM" — which reads as a note the agent sent itself.
                'ftq-answer',
            );
        });
        rehydrateAgentInbox();
        agentInboxBroker.rehydrateMessages();
        // The upgrade announcement used to run HERE, and that was the bug
        // (genie#346): the MCP server is not started until the end of
        // `whenReady`, so every reconnect was aimed at an endpoint that was not
        // listening. It now runs from `announceUpgradeToAgents()`, after
        // `startMcpServer`.
    } catch {
        /* best-effort — AgentInbox is additive; a failure never blocks startup */
    }
    setPluginPanelOpenSink(({ terminalId, pluginId, panelId, activeItemId }) => {
        const workspaceId = getTerminalSpec(terminalId)?.workspace_id;
        if (!workspaceId) return;
        const payload = {
            workspaceId,
            pluginId,
            panelId,
            ...(activeItemId ? { activeItemId } : {}),
        };
        showMasterWindow();
        const win = masterWindow;
        if (win && !win.isDestroyed() && win.webContents.isLoadingMainFrame()) {
            win.webContents.once('did-finish-load', () => broadcastPluginPanelOpen(payload));
        } else {
            broadcastPluginPanelOpen(payload);
        }
    });
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
    // Repository panel (the first plugin-panel consumer): host-side git ops.
    registerRepoIpc();
    // Plugin System (Settings → Plugins): install / enable / grant / marketplace.
    registerPluginsIpc();
    registerPluginEditorBridge();
    registerDocumentConvert();
    // Self-heal FIRST: re-install any bundled plugin whose stored manifest drifted
    // from the source Genie now ships (e.g. a manifest installed before a schema
    // tightening), preserving its enabled state + grants — so revalidate below sees
    // a fresh, valid manifest and never wrongly refuses a first-party plugin. THEN
    // re-evaluate plugin trust against the current trust store, so a key removed /
    // Developer Mode turned off between sessions revokes fail-closed.
    try {
        await reconcileBundledPlugins();
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
    //
    // EXCEPTION: an auto-update relaunch. The user was actively using Genie and
    // clicked to update; on Windows the updater's relaunch can look like an
    // autostart launch, which silently stranded the window in the tray after
    // every upgrade. `restartAndApply` persists a one-shot flag we consume here
    // to reopen anyway — but a deliberate `start_minimized` is still honoured.
    {
        const settings = getAllSettings() as Record<string, string>;
        const reopenAfterUpdate = settings[REOPEN_AFTER_UPDATE_KEY] === '1';
        // One-shot: clear it now so only the boot immediately after the update
        // reopens (whatever we decide below).
        if (reopenAfterUpdate) setSettings({ [REOPEN_AFTER_UPDATE_KEY]: '' });
        if (
            shouldShowMasterWindowOnBoot({
                isE2E: isE2E(),
                fromAutostart: launchedFromAutostart(),
                startMinimized: settings['start_minimized'] === 'on',
                reopenAfterUpdate,
            })
        ) {
            showMasterWindow();
        }
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
    // Re-arm every approved SCHEDULED task (a process spec with meta.schedule).
    // This is what makes a schedule survive quit/crash/auto-update: the timers
    // died with the process, the specs did not, so each is armed forward from
    // now — deliberately WITHOUT catching up the fires that were missed while
    // the Host was down.
    startSchedules();
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
        listWorkspaces: () => listWorkspaces().map((w) => ({ id: w.id, path: w.path })),
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
    const mcpDeps = buildHostServerDeps(
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
    );
    // Genie Apps (Tynn #250): the GApp bridge runs on the SAME deps as the MCP
    // server, so an installed app reaches the real tools through the real
    // implementations — under app rules, decided at the same chokepoint agents
    // use. Registered before the server starts so an app window that opens early
    // never finds a dead channel.
    registerAppBridge(mcpDeps);
    registerAppsIpc();
    // Flows ride the SAME bridge, so a workflow is bounded by exactly the grant
    // its app already holds. This also wires the scheduler's flow-fire handler and
    // reconciles every declared schedule, which is what makes a time-based trigger
    // arm itself rather than waiting for anyone to ask.
    registerFlowsIpc(mcpDeps);
    // A GApp PREVIEW cannot outlive its window, and a window cannot outlive this
    // process — so any preview workspace still in the database now is the residue
    // of a crash or a kill, with no window, no grant and no site behind it. This
    // is what keeps "closing the window is the whole cleanup" true in the one case
    // where the window never got the chance to close.
    sweepPreviewsAtBoot();
    // E2E seam (GENIE_E2E=1 only): publish the handle a spec uses to open a REAL
    // GApp window over the REAL bridge. The property it exists to prove is a
    // negative -- `window.genie` is absent inside a GApp's page -- and a negative
    // cannot be established by reading code. Inert in a normal run.
    if (isE2E()) registerAppsE2E();
    await startMcpServer(mcpDeps).catch((e) => console.error('[mcp] failed to start', e));
    // genie#346 — ONLY now. Every agent's `genie` connection died with the old
    // process, and both halves of the repair need a listening endpoint: the
    // typed `/mcp reconnect genie` has nothing to connect to without one, and a
    // harness channel cannot re-register itself against a port nobody is on.
    // Fire-and-forget: it schedules its own work and never blocks boot.
    announceUpgradeToAgents();

    // Wire the operator's OWN workspace the way every other workspace is wired.
    // Without this it had no `.mcp.json`, no `.agents/skills/` and no Codex
    // config, because every sync call site is keyed on a registered workspace
    // row and the OSA deliberately has none.
    //
    // genie#319 — this MUST come after `startMcpServer`, for the same reason the
    // E2E seam below does: `registerTerminalEndpoint` returns null until the
    // server has a port. Run earlier in boot it handed `wireGenieOsWorkspace` a
    // null endpoint on every machine, every boot, so the OSA was never wired at
    // all — while its agent was still launched with a channel flag that then had
    // no server to resolve. The endpoint itself is stable (fixed terminal id,
    // persisted token), so this stays idempotent across restarts.
    if (!wireGenieOsWorkspace(genieOsWorkspace, registerTerminalEndpoint(GENIE_OS_TERMINAL_ID))) {
        console.error(
            '[osa] workspace not wired — no MCP endpoint; the operator will boot without its tools',
        );
    }
    // E2E seam (GENIE_E2E=1 only): publish the LIVE MCP endpoint plus hooks to
    // drive a REAL broker delivery, so a Playwright spec can prove the whole
    // server-push chain in the compiled app — including that the boot above
    // actually wired the notify sink. Published here (after startMcpServer) so
    // the endpoint URL exists. Inert in a normal run.
    if (isE2E()) {
        const wsId = 'e2e-push-ws';
        (globalThis as Record<string, unknown>).__GENIE_E2E_MCP__ = {
            endpointUrl: workspaceEndpointUrl(wsId),
            diagnostics: () => serverPushDiagnostics(),
            /** Join two agents in that workspace and DM between them — the same
             *  send() path an agent's `agentinbox` tool call takes. */
            sendSelfTestDm: (): boolean => {
                const base = {
                    workspaceId: wsId,
                    workspaceName: 'E2E Push',
                    slug: 'e2e-push',
                    agentType: 'claude' as const,
                    purpose: 'general',
                    scope: 'all' as const,
                    scopeWorkspaces: [],
                    chatSessionId: null,
                };
                agentInboxBroker.join({
                    ...base,
                    agentId: 'e2e-push-a',
                    terminalId: 'e2e-push-t-a',
                    label: 'E2E A',
                });
                agentInboxBroker.join({
                    ...base,
                    agentId: 'e2e-push-b',
                    terminalId: 'e2e-push-t-b',
                    label: 'E2E B',
                });
                const r = agentInboxBroker.send({
                    fromAgentId: 'e2e-push-a',
                    toAgentId: 'e2e-push-b',
                    text: 'e2e server-push probe',
                });
                return r.ok === true && (r.delivered ?? 0) > 0;
            },
        };
        // eslint-disable-next-line no-console
        console.log('[e2e] MCP push handle published');
    }
    // Backfill the genie MCP entry into the Claude/Cursor config of any
    // workspace already opted in — now with the stable workspace endpoint URL,
    // so older configs that carried the broken ${GENIE_MCP_URL} ref are
    // rewritten to the hard-coded URL on launch. Best-effort.
    for (const ws of listWorkspaces()) {
        if (ws.mcp_enabled) {
            writeWorkspaceAgentMcp(ws.path, true, workspaceEndpointUrl(ws.id));
        }
    }
    // Self-heal the `tynn` MCP entry of any workspace whose config is on disk but
    // unusable, offline and with no re-mint:
    //   - the OLD, broken `${TYNN_AGENT_TOKEN}` reference form, which Claude Code /
    //     Cursor REFUSE to load when the var is unset (a stale terminal, a subagent,
    //     a non-Genie shell), breaking "connect to Tynn" for EVERY agent there (the
    //     outage) — rewritten to the self-contained literal-token form;
    //   - a plaintext REMOTE url (`http://tynn.ai/…`, genie#201) — the bearer token
    //     in the clear, and a 301 the client follows into a 405, so the agent lists
    //     no tools at all. This loop is the ONLY thing that reaches workspaces
    //     provisioned before the write boundary existed: they count as already
    //     configured, so nothing would ever rewrite them.
    // Best-effort per workspace — never blocks or crashes boot.
    for (const ws of listWorkspaces()) {
        try {
            if (healTynnMcpEntry(ws.path)) ensureMcpGitignored(ws.path);
            if (syncWorkspaceCodexTynnMcp(ws.path)) ensureMcpGitignored(ws.path);
        } catch (e) {
            console.error('[tynn] mcp entry self-heal failed for', ws.path, e);
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
        // Phase 2b: a PARALLEL user-channel IssueWatch subscription runs ALONGSIDE
        // the workstation path above — a personal desktop rides its own
        // private-App.Models.User.{id} channel with no workstation row. Authorized
        // + reconciled via the Tynn SESSION cookie (session.defaultSession.fetch),
        // not the host proof. applyPushedDelta is idempotent, so a delta arriving
        // on both channels is safe. It never touches the shared service state
        // (owned by the workstation path) so the two never fight over it.
        let userChannelHandle: Awaited<ReturnType<typeof startUserChannelIssueWatch>> = null;
        let managedCredentialsHandle: Awaited<ReturnType<typeof startManagedCredentials>> = null;
        const sessionFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
            session.defaultSession.fetch(input as string, init)) as typeof fetch;
        const startIssueWatch = async () => {
            issueWatchHandle?.stop();
            issueWatchHandle = await startLocalWorkstation({
                inventory: async () => {
                    const workspaces = listWorkspaces();
                    const sites = await listLocalEnabledGenSites();
                    // projectId is the workspace's EFFECTIVE Tynn link, not the raw
                    // row column: a locally-scaffolded `.agi` envelope records the
                    // link only in project.json, so buildWorkstationInventory falls
                    // back to it via resolveTynnLinkForRow — otherwise the host
                    // workstation channel can't be matched and IssueWatch can't
                    // track the workspace (genie#91).
                    return buildWorkstationInventory(workspaces, sites);
                },
                log: (m) => console.log('[workstation]', m),
                // Late-bound on purpose: the managed-credential service starts
                // below, after this one, so read the handle at push time.
                onProviderCredentialChange: (event) =>
                    void managedCredentialsHandle?.onCredentialChange(event),
            });
            // The same session-bound fetch backs the MANUAL refresh
            // (`checkIssues(refresh: true)` and the UI button). Registered here
            // because `session.defaultSession.fetch` only exists once the app is
            // ready, and unregistered correctly answers "not signed in".
            setIssueWatchRefreshTransport({
                fetchImpl: sessionFetch,
                apiBaseUrl: () => new TynnBackend().host(),
            });
            userChannelHandle?.stop();
            userChannelHandle = await startUserChannelIssueWatch({
                fetchImpl: sessionFetch,
                log: (m) => console.log('[user-channel]', m),
            });
            // Tynn-managed provider credentials for agent terminals. Gated on the
            // `managed_credentials` setting (default OFF) — when off this is fully
            // dark: no keypair, no request. It rides the same signed-in lifecycle
            // as IssueWatch because it uses the same enrolled-workstation identity.
            managedCredentialsHandle?.stop();
            managedCredentialsHandle = await startManagedCredentials({
                log: (m) => console.log('[managed-credentials]', m),
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
                userChannelHandle?.stop();
                userChannelHandle = null;
                // Signing out is not a revoke — leave the materialized file alone
                // (the owner may sign back in) but stop watching for rotations.
                managedCredentialsHandle?.stop();
                managedCredentialsHandle = null;
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
        // The host reverse proxy's resolver: an opaque siteId → the loopback
        // target of a site this machine is SERVING — the SAME aggregation the
        // host publishes at `/api/sites/enabled`, so the listing a remote reads
        // and the target it then gets can never disagree. That single source is
        // also the SSRF/open-proxy guard: a remote supplies nothing but the id,
        // and an id nothing serves resolves to null.
        siteProxy: {
            resolveSite: (siteId) => resolveEnabledSite(siteId),
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
            scheduleInfo: () => getScheduleInfo(),
            runScheduleNow: (id) => runScheduleNow(id),
            createAgentTerminal: (opts) => createAgentTerminal(opts),
            // AMS agent RECORDS, so a REMOTE window manages the HOST's agents
            // rather than its own (genie #327). Same functions the IPC handlers
            // call -- one implementation, two transports.
            agentRecords: {
                list: (workspaceId) => agentRecordsList(workspaceId),
                create: (input) => agentRecordCreate(input),
                start: (workspaceId, name) => agentRecordStart(workspaceId, name),
                remove: (agentId, mode, handoff) => agentRecordDelete(agentId, mode, handoff),
                setDefault: (workspaceId, agentId) => agentRecordSetDefault(workspaceId, agentId),
                addRuntime: (agentId, provider) => agentRecordAddRuntime(agentId, provider),
                front: (agentId, runtimeId) => agentRecordFront(agentId, runtimeId),
                setAvatar: (agentId, avatar) => agentRecordSetAvatar(agentId, avatar),
            },
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
            installUpdate: (force?: boolean) => mobileInstallUpdate(force),
            checkUpdate: () => mobileCheckUpdate(),
            // The host's `.gen` dev sites — the containers its Dev Server is
            // serving — read by a remote over /api/sites/enabled for its header
            // `.gen` popover + Testing Browser resolver. The same source the
            // local IPC (`sites:all`) and the site-proxy resolver use, so a
            // remote window sees exactly what a local one computes.
            listEnabledSites: () => listLocalEnabledGenSites(),
        },
    }).catch((e) => console.error('[mobile] failed to start', e));
    // Docs viewer IPC (docs:list / docs:read). __dirname is the compiled main
    // bundle dir; resolveDocsDir uses it to find the bundled docs/ in both dev
    // and the packaged asar.
    registerDocsIpc(__dirname);
    // ADOPT the Dev Server containers that are already running (#234 P4) — and
    // start no CONTAINER. Two different reasons, both load-bearing:
    //
    //   - A service ENGINE carries `restart: unless-stopped`, so after a reboot
    //     it is up before Genie is, with zero known holders. Left unadopted the
    //     reference count is a lie, and the first workspace to acquire it later
    //     becomes its only holder — so that workspace's release stops an engine
    //     every other workspace is still using.
    //   - A SITE container easily outlives a Genie restart or an app update.
    //     Unadopted it keeps serving while `genSites()` does not know it exists,
    //     so `<name>.gen` resolves to nothing and the user sees a dead site that
    //     is, in fact, running.
    //
    // What is deliberately NOT here is a `reconcile()`: a workspace nobody asked
    // to serve must not begin serving because the app launched. This is the
    // counterpart of quitting without stopping anything — see `lifecycle.ts`.
    //
    // What `onBoot` DOES do beyond adopting is resume the sites the user has
    // ENABLED and which did not survive (genie#190, genie#216): a host-native site
    // has no container to outlive the quit at all, and a container site's process
    // is exec'd into a sandbox that a Docker reboot restarts empty. `enabled` is
    // the ask; a site nobody enabled is still never started.
    //
    // Deferred and fire-and-forget: nothing here is a reason to hold up startup,
    // and the push at the end is what lights the rail's sites icon on a cold
    // start, since nothing polls for it.
    void (async () => {
        // Hold the external-browser reconcile for the WHOLE restore (genie#225).
        // onBoot brings every enabled site back one at a time and each start fires
        // `onChanged`; without this the debounce elapses long before the last one
        // is up, so a reconcile — and its elevated hosts write, i.e. a UAC prompt —
        // fires mid-restore and another trails it. Suspended, the upgrade costs ONE
        // prompt carrying every site.
        const resumeHostBrowser = hostBrowserReconciler?.suspend();
        try {
            await devLifecycle()?.onBoot();
        } catch (e) {
            console.error('[dev-server] boot adoption failed', e);
        } finally {
            // In a finally: a failed restore must not leave reconciles suspended
            // for the rest of the session.
            await resumeHostBrowser?.();
        }
        broadcastDevServerChanged();
        // Adopt re-attached any browser-exposed host-native site that was already
        // running — bring its host Caddy/hosts/CA back in one pass. No-op (and no
        // prompt) when nothing is opted in.
        void hostBrowserReconciler?.runNow();
    })();
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
        // Cancel every armed schedule timer first — a fire mid-teardown would
        // spawn a pty we're in the middle of tearing down. The schedules
        // themselves live in the DB and are re-armed by startSchedules() on the
        // next launch, so nothing is lost.
        stopSchedules();
        const forUpdate = isQuittingForUpdate();
        const forReset = isWorkstationResetPending(app.getPath('userData'));
        const kind = hostBackendKind();
        const fullShutdown = forReset || !isHostBacked() ||
            (shouldKillHostForUpdate(forUpdate, kind) && detachedHostPinsBinary());
        if (fullShutdown) {
            const targets = listWorkspaces().flatMap((workspace) =>
                listWorkspaceAgents(workspace.id).flatMap((agent) => {
                    if (!agent.terminal_spec_id || !isTerminalLive(agent.terminal_spec_id)) return [];
                    const inboxAgentId = getTerminalSpec(agent.terminal_spec_id)?.meta?.agent_id;
                    return typeof inboxAgentId === 'string' && inboxAgentId
                        ? [{
                              agentId: agent.id,
                              inboxAgentId,
                              terminalId: agent.terminal_spec_id,
                          }]
                        : [];
                }),
            );
            await agentShutdownReadiness.begin(targets, 30_000);
        }
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
            if (forReset || (shouldKillHostForUpdate(forUpdate, kind) && detachedHostPinsBinary())) {
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
            destructive: !isHostBacked(),
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
 *   - `e2e-ghcaps`     → GithubCapabilitiesFlyout (per-install resolve flow),
 *   - `e2e-hosting`    → the Hosting Manager: the workstation settings section
 *     plus the per-workspace panel, against the fixture in main/e2e/hosting.ts.
 *   - `master`         → NOT a harness page: the REAL master window
 *     (renderer/pages/master.tsx), against the fixture in main/e2e/master.ts.
 *     The `${page}.html` load makes the product page reachable here directly,
 *     which is the whole value of that gate — nothing else mounts the app's own
 *     main window end to end.
 * Plain BrowserWindow, shown immediately so Playwright can attach to its first
 * window.
 */
function showE2EWindow(): void {
    // Allowlist the harness routes so a stray env value can't load an arbitrary
    // page; default to the issue-watch harness for back-compat.
    const requested = process.env.GENIE_E2E_PAGE ?? 'e2e-issuewatch';
    const ALLOWED = [
        'e2e-ghcaps',
        'e2e-issuewatch',
        'e2e-agent-access',
        'e2e-picker-layer',
        'e2e-hosting',
        'e2e-repo-panel',
        'e2e-terminal-recovery',
        'e2e-tynn-health',
        'e2e-agent-pulse',
        // The product page, not a harness (genie#228). See the doc comment.
        'master',
    ] as const;
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
    if (page === 'e2e-repo-panel') {
        // Seed the fixture git repo + workspace BEFORE the window loads; the
        // harness page discovers it via workspaces.list() on mount.
        try {
            seedRepoE2E();
        } catch (e) {
            console.error('[e2e] repo-panel seed failed', e);
        }
    }
    if (page === 'e2e-agent-pulse') {
        // Seed the fixture workspace BEFORE the window loads — the harness page
        // resolves its row by listing on mount — and expose the pulse emitter so
        // the spec can push activity on the REAL `agent-pulse` channel.
        try {
            seedAgentPulseE2E();
        } catch (e) {
            console.error('[e2e] agent-pulse seed failed', e);
        }
    }
    if (page === 'master') {
        // Seed the fixture workspaces + terminals BEFORE the window loads: the
        // real page lists them on mount and restores its launch grid from what it
        // finds, so a row that arrives afterwards is a row the floor never lays
        // out. Also resets the persisted layout + active workspace, since the E2E
        // profile is reused across runs.
        try {
            seedMasterE2E();
        } catch (e) {
            console.error('[e2e] master seed failed', e);
        }
    }
    if (page === 'e2e-terminal-recovery') {
        // Let the spec drive the host-loss watchdog's OWN emit path (genie#203):
        // the SAME broadcastToWindows + channel constants genie-adapter uses, so a
        // channel-string drift between emit (genie-adapter) and listen (preload)
        // surfaces as a failing E2E rather than a silent dead path.
        (globalThis as Record<string, unknown>).__GENIE_E2E_RECOVERY__ = {
            emitStatus: (state: RecoveryState) =>
                broadcastToWindows(TERMINAL_RECOVERY_STATUS_CHANNEL, { state }),
            reattach: (ids: string[]) => broadcastToWindows(TERMINAL_RECOVER_CHANNEL, { ids }),
        };
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

/**
 * Consent for fetching a container image the Dev Server needs (#234 P4).
 *
 * The seam's default is NO PULL — deliberately, so a caller that has not built
 * a consent surface cannot start a multi-gigabyte download by forgetting a
 * field. That default is right for a library and wrong for the desktop: without
 * this, clicking "Add Postgres" in the Site Manager fails with an instruction to
 * go and run `docker pull` in a terminal, which is a dead end dressed as an
 * error message.
 *
 * Asking is also the honest shape. An engine is 20 MB (Mailpit) to 600 MB
 * (MySQL) and the workspace dev image is larger still; that is the user's disk
 * and the user's bandwidth, and it is worth one question.
 */
async function confirmContainerImagePull(req: { image: string; reason: string }): Promise<boolean> {
    try {
        const { response } = await dialog.showMessageBox({
            type: 'question',
            title: 'Download a container image?',
            message: `Genie needs the image ${req.image}.`,
            detail: `${req.reason}\n\nIt is downloaded once and reused by every workspace that needs it afterwards.`,
            buttons: ['Download', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
        });
        return response === 0;
    } catch {
        // No window (headless, or a very early boot). Fail CLOSED, back to the
        // library default: report the image as missing with the command to run,
        // rather than silently downloading gigabytes nobody agreed to.
        return false;
    }
}

app.on('window-all-closed', () => {
    // Genie stays alive in the tray. Do nothing.
});

app.on('before-quit', () => {
    (app as any).isQuiting = true;
    unregisterShortcuts();
    // The Dev Server is deliberately NOT torn down here (#234 P4).
    //
    // beta.218's native hosting had to be: FrankenPHP and a native Postgres were
    // ordinary children of this process, and one left holding port 20431 would
    // break the next launch. A container is the opposite — it is not our child,
    // a service engine is created `restart: unless-stopped` precisely so it
    // outlives us, and the most common reason Genie quits is to APPLY AN UPDATE.
    // Killing a user's running dev servers to install a patch is the same
    // mistake as killing their terminals.
    //
    // What is not stopped here is re-ADOPTED on the next boot (`onBoot`), which
    // is the half of the pair that makes leaving them running safe rather than
    // merely convenient.
});

// Bridge for getting the active project context (used by capture window).
ipcMain.handle('app:get-current-project', async () => {
    // Capture window uses this to pre-select the project. Defaults to the
    // last-opened workspace, then to primary's project, then null.
    const { getLastOpenedProject } = require('./workspace/last-opened');
    return getLastOpenedProject();
});
