import { sameFlowWindow } from '../core/route.js';
import { browserSiteLabels } from '../core/browser-sites.js';
import { describeMcpTool } from '../core/mcp-tool-summaries.js';
import { terminalsWindowRoute } from '../core/workspace-window.js';
import { ConnectWatch, connectNotice } from '../core/connected-here.js';
import { guestAskNotice, newGuestAsks } from '../core/pair-confirm.js';
import type { TynnWatchEvent, TynnWatchKind, TynnWatchPort } from '../core/local-tynn-watch.js';
import { HeadroomFeed, headroomBufferMs } from '../core/headroom-board.js';
import type { Headroom, ReadingStamp } from '../core/headroom.js';
import { systemRootsPem } from './php-trust-host.js';
import { runServiceExec } from './service-exec.js';
import { MainErrorBook, installMainErrorPolicy, retryHostCopy } from '../core/main-errors.js';
import { forwardRendererConsole } from '../core/render-error.js';
import { siteAnswers } from './port-probe.js';
import { relayWorkstationOf, remoteFromSearch, remoteWindowSearch } from '../core/remote-window.js';
import { takeOverRouteOf } from '../core/take-over-route.js';
import { browserConnectionFor } from '../core/browser-connection.js';
import { drivablePages } from './page-navigation-electron.js';
import { livenessOf } from '../core/liveness.js';
import { CallerBook, sessionCallerOf } from './mcp-callers.js';
import type { Caller } from './mcp-tools.js';
import { BrowserWindow, ClipboardItem, Menu, Notification, Tray, app, clipboard, dialog, ipcMain, net, powerMonitor, safeStorage, session, shell, webContents } from 'electron';
import { configureWindowPages, loadWindowPage } from './window-pages.js';
import { electronClipboardPort, registerClipboardIpc } from './clipboard-ipc.js';
import { localProtocolDoor } from './local-protocol-door.js';
import { tunnelDoor, tunnelLinkOf, windowOpsHandler } from './window-tunnel.js';
import { guardWindowLinks } from './external-links.js';
import { WHATS_NEW_ROUTE, genieDocsUrl } from '../core/whats-new.js';
import { appMenuTemplate } from './app-menu.js';
import { FilesWindows } from './files-windows.js';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgentId, type AgentRecord } from '../core/identity.js';
import { createThroughAddAgent } from './mcp-tools-agents.js';
import { AGENT_PUSH_INTERVAL_MS } from './agent-push.js';
import { Coalescer, realSchedule } from '../core/coalesce.js';
import { OS_WORKSPACE, Registry } from './registry.js';
import { readFile } from 'node:fs/promises';
import { setProviderChoiceFile } from './provider-choice.js';
import { readMailSignal } from '../core/mail-actions.js';
import { windowSettings } from './window-settings.js';
import { windowFrontDoor } from './window-front-door.js';
import { EMPTY_FRONT_DOOR_WATCH, type FrontDoorWatchView } from '../core/front-door-watch.js';
import { windowApprovals } from './approvals-gate-protocol.js';
import { readThingSignal } from '../core/thing-sounds.js';
import { quitAnswer, quitPlan, quitSequence, runQuit, type QuitPorts } from '../core/quit.js';
import { windowLaunchFlags } from '../core/launch-flags.js';
import { hostDownAnswer, hostDownPlan } from '../core/host-down.js';
import { hostHashOf } from '../core/update-kind.js';
import { QUIT_DATA, answerSecondInstance, asksToQuit, launchDecision, type LaunchDecision } from '../core/quit-flag.js';
import { ActivationLedger, bringUp, onceShowable, showWhenReady, windowLabelOf, type Activation, type ActivationRequest } from '../core/window-activation.js';
import { viewDelivery, viewReaches, type ViewRequest } from '../core/view-requests.js';
import { genieUrlIn, signInCodeFrom, workstationOpenFrom } from '../core/tynn-sign-in.js';
import { settleStaleLegacyPairing, tynnPairingSource } from './tynn-account.js';
import { TYNN_HOST } from '../core/tynn.js';
import { githubSealedSources } from './github-account.js';
import { readGenie1Identity, workstationSealedSources } from './workstation-identity.js';
import { applyLinuxPasswordStore, passwordStoreBusNames, probeOwnedBusNames } from './linux-password-store.js';
import { readRememberedPasswordStore, rememberPasswordStore } from './password-store-memo.js';
import { unlockKeyringBeforeStores } from './linux-keyring.js';
import { osCipher } from './os-cipher.js';
import { reportProxyAnswers } from './proxy-report.js';
import type { SessionEngineClient } from './session-engine-client.js';
import { gatherSources } from './keychain-migration.js';
import { tynnAgentIdentities, type AgentSecrets } from './tynn-agent-identities.js';
import { legacyUnsealer, type LegacyUnsealer } from './legacy-unsealer.js';
import { outboundDialRefusal } from '../core/workstation-role.js';
import { actOnConnectLink, connectLinkDecisionOf } from '../core/connect-link.js';
import { remoteWindowAction, windowsLeftByAccountChange } from '../core/remote-window-policy.js';
import { mkdir, readFile as readFileText, writeFile as writeFileText } from 'node:fs/promises';
import { moveAgentFrontmatter, nodeAgentConfigFs } from './agent-config-host.js';
import { sweepLeftoverProvidersAsync } from './leftover-sweep.js';
import { openLifecycleLog } from './lifecycle-log.js';
import { StallWatchdog, timeIpcHandlers, watchOutboundCalls } from './stall-watchdog.js';
import { WindowCrashRecorder, startHeartbeat } from './window-crash-recorder.js';
import { RECOVER_REPORT, RECOVER_RESTART, pageMemorySampler, recoverRenderer, rendererErrorPage, type RendererNotice } from './renderer-recovery.js';
import { crashHeader, removeCrashRecord, writeCrashRecord } from './crash-records.js';
import { routeExecThroughSpawnHost, SpawnHostClient } from './spawn-host-client.js';
import * as diagnosticsChannel from 'node:diagnostics_channel';
import { getHeapStatistics } from 'node:v8';
import { Session as InspectorSession } from 'node:inspector';
import { stallStacksWanted, startStallProfiler } from './stall-profile.js';
import { setPrivateCredentialFailureLog } from './private-credentials.js';
import { systemProcessTree } from '../core/process-tree.js';
import { loginTerminalOf } from './login-host.js';
import { connectAgentEngine, type AgentEngine, type AgentEngineLink } from './agent-engine.js';
import { hostBuild } from './engine-launch.js';
import { materializeHostRuntime } from './host-runtime.js';
import { HostRestart, HostWait } from './host-wait-window.js';
import { scheduleScratchSweep } from './scratch-area.js';
import { callRefusal, ownProtocolClient } from './own-protocol-client.js';
import { ActivityFeeds } from './activity-feeds.js';
import { PauseAlerts } from '../core/account-pause.js';
import { Store } from './store.js';
import { composeWindowServices, type ComposeInput, type WindowServices } from './compose.js';
import { featureWindow } from './feature-window.js';
import { QuestionWindow } from './question-window.js';
import { RemoteQuestions } from './remote-questions.js';
import { electronQuestionWindow } from './question-window-electron.js';
import { readV1Settings } from './v1-settings.js';
import { readV1Catalog, readV1Knowledge } from './v1-import.js';
import { readV1Inbox } from './v1-inbox.js';
import { planV1Import, v1DefaultAgents } from '../core/v1-import.js';
import { v1Leftovers } from '../core/v1-reap.js';
import { TITLE_BAR_HEIGHT, mainWindowOptions, overlayColorsOk } from '../core/window.js';
import { createTray, loginName, trayImages as buildTrayImages, trayMenuTemplate, trayTooltip, trayUpdate, type TrayHandlers, type TrayItem } from './tray.js';
import { needsYouCount, type DeckItem } from '../core/deck.js';
import { limitWords } from '../core/limit-words.js';
import { genieWindowIcon } from './app-identity.js';
import { HIDDEN_ARG, showOnBoot } from '../core/tray-resident.js';
import { trayOnlyStep, trayProbeEnabled, type HostActivity } from '../core/tray-only.js';
import { tableWithin, terminalBusy, trayConfirm, trayConfirmed, type Stopping, type TrayAction } from '../core/tray-confirm.js';
import { panelRestart } from '../core/panel-restart.js';
import { LeftRunningMark } from './left-running.js';
import { wireCloseToTray, wireLoginItem, type LoginItemPort } from './tray-residence.js';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { caddyBinPath, userCaddyCopy } from './caddy-runtime.js';
import { execFileRunner } from './toolchain-runner.js';
import { latestIndex, type CommandRunner } from './toolchain-prober.js';
import { type Platform } from '../core/toolchain.js';
import { ensurePhpCaBundle, nodeToolchainFs, phpCaBundleNow, phpWorkerEnv, processEnv, restoreToolchainEnv, toolchainPaths } from './toolchain-ops.js';
import { nodeLinkFs, restoreDefaultsEnv } from './toolchain-defaults.js';
import { runElevatedBatch, type PrivilegedStep } from './elevate.js';
import { nodePhpVersionsFs, phpVersionsRoot, refreshAllManagedInis, refreshManagedIni, resolvePhpCgi, type PhpCaPort, type PhpCgiPorts, type PhpVersionsPorts } from './php-versions.js';
import { osPidAlive } from './process-supervisor.js';
import { BrowserPane } from './browser-pane.js';
import { electronBrowserView, followFrontDoorInPanes } from './electron-browser-view.js';
import { BrowserCookieBridge } from './browser-cookie-bridge.js';
import { BrowserPagesReplica } from './browser-pages-replica.js';
import type { BrowserPage } from './browser-service.js';
import { rerouteGenieBrowserSession, watchWorkspaceStores, workspaceBrowserSession } from './genie-browser-electron.js';
import { sitePanels, type LiveSitePanels } from './site-panels-electron.js';
import { FEATURE_CHANNELS } from '../renderer/bridge.js';
import { QUIT_DELAY_MS, UpdateHost } from './updater.js';
import { genieRoot, installDir, osaHomeDir, runtimeDir } from './paths.js';
import { osaHomeFiles, writeOsaHome } from '../core/osa-home.js';
import { omarchyFacts } from './omarchy-skills.js';
import { killProcessAsync, listProcessesAsync } from './process-list.js';
import { RESUME_AFTER_RESTART } from '../core/upgrade-drain.js';
import { restoreAfterRelaunch } from './relaunch-restore.js';
import { WindowSafeMode } from './window-safe-mode.js';
import { recordShutdown } from './shutdown-record.js';
import { FilesHost } from './files-host.js';
import { fileExporter } from './file-export.js';
import { removeSavedScrollback } from './saved-scrollback.js';
import { fileEventsOf } from '../core/files-panel.js';
import { gitFileStatus, gitShowHead, gitTreeStatus } from './git-ports.js';
import { withActionSignal } from './mcp-signal.js';
import type { Verification } from './mcp-server.js';
import { hostOnly, windowToolRunner } from './window-tools.js';
import type { TerminalsPort } from './mcp-tools-more.js';
import { EMPTY_HOST_SUMMARY, type HostSummary } from '../core/host-summary.js';
import { workspaceNameFor } from './workspace-names.js';
import { openWindowRegistryStore, registryChanges } from './window-registry-store.js';
import { watchRegistryRefresh } from './registry-refresh.js';
import type { ForwardedToolCall } from './mcp-host-tools.js';
import type { McpToolResult } from '@particle-academy/prism-mcp';
import type { InboxStore } from './inbox-store.js';
import type { AttentionStore } from './attention-store.js';
import type { KnowledgeStore } from './knowledge-store.js';
import { allGenieTools } from './mcp-registrations.js';
import { gappWindowsElectron } from './gapp-windows-electron.js';
import { genieToolDeps, toolRoster } from './genie-tool-deps.js';
import type { OpenInBrowser } from './hosting-actions.js';
import { TERMINAL_NEEDS_YOU } from '../core/terminal-surface.js';
import { clearGenieRunning, markGenieRunning } from './genie-running-file.js';
import type { IssueWatchRefreshAnswer } from './issue-watch-client.js';
import { IssueWatchReplica } from './issue-watch-replica.js';
import { followWorkspaceColors, WorkspaceColors } from './workspace-color-host.js';
import { nodeEnvelopeFs } from './envelope-sites-host.js';
import { installContextMenu, type MenuWebContents } from './context-menu.js';
import { tynnProjectIdOf, type IssueWatchPanelView, type IssueWatchSummary } from '../core/issue-watch.js';

/**
 * THE MAIN PROCESS.
 *
 * Owns the registry, the session host, the window, and the channels the renderer is allowed to
 * use. Nothing here renders and nothing here decides what a row says — those are `src/core`,
 * which is why they can be tested without Electron.
 *
 * ## No agent is ever attached to a pty, and this file is where that holds in practice
 *
 * There is no pty code in it. Not an unused helper, not a disabled branch, not a
 * `createAgentTerminal` with the spawn commented out. The previous build's ptys were created
 * **seventy lines before** anything decided which engine an agent would use, so removing the
 * pty *engine* changed nothing a user could see: agents still held ptys and still read
 * `claude · pty` on screen. The fix is structural — `AgentEngine` has no `'pty'` member, so
 * the mistake does not typecheck — and the habit that goes with it is that the process which
 * spawns agents has no terminal machinery in reach at all.
 *
 * Terminals arrive in P5, for shells, builds and services. They will not arrive here.
 */

/**
 * THE POLICY FOR AN ERROR NOBODY CAUGHT — the first statement, before anything below can throw (core/main-errors.ts).
 *
 * Without an `uncaughtException` listener Electron answers a stray throw with its "A JavaScript error occurred in the
 * main process" dialog, which on Linux is a modal GTK loop on this thread: on 2026-10-15 an uncaught EPIPE from the
 * pty froze all of Genie behind it. With these listeners the error is logged with its stack, recorded on the Deck as
 * Genie's own item (counted when it repeats, Dismiss to put it aside), and Genie keeps running — no dialog, no exit.
 * One raised before the window exists is on the Deck when the window first reads it. A `boot()` that rejects is not
 * this: Genie did not start, and `boot().catch` at the bottom says so and quits.
 */
const mainErrors = new MainErrorBook();
installMainErrorPolicy(process, mainErrors);
/** Make genie-host's copy again, for the Deck item's Try again (Tynn #693): its error, or `null` when it is made. Set at boot. */
let remakeHostCopy: () => Promise<string | null> = async () => 'Genie has not finished starting; try again in a moment';

const here = fileURLToPath(new URL('.', import.meta.url));
// Genie's windows load from http://genie.localhost:<port>, served from the build by this process (Tynn #683, main/window-pages.ts).
configureWindowPages({ root: join(here, '../renderer'), portFile: join(app.getPath('userData'), 'window-origin.json'), log: (line) => console.log(line) });

/**
 * A single instance, with no exception.
 *
 * The previous build short-circuited this lock under an env var so an E2E suite could run
 * beside a live Genie, and the measured result was two instances both opening windows on the
 * owner's desktop while real agents were mid-turn. There is no `GENIE_E2E` escape hatch here:
 * a second instance focuses the first. Verification happens on a VM, where there is no first
 * instance to collide with.
 *
 * `--quit` (core/quit-flag.ts) rides the same lock: a second launch with it asks the first to run the tray's Quit, and
 * a `--quit` that finds no Genie running exits without booting one. Neither ever creates a window: only a `boot`
 * launch reaches `boot()`. They EXIT (app.exit), never app.quit: a quit would run this process's before-quit — Genie's
 * shutdown, which ends by clearing the RUNNING Genie's genie-running file — in a process that owns nothing.
 */
/*
 * PRISM-ACP'S APPROVAL HOOK never reaches this code (genie#1235). From prism-acp 0.30.0 the hook Claude runs on every Bash
 * and PowerShell call starts Genie's runtime with ELECTRON_RUN_AS_NODE=1 for the hook process alone, so Electron runs
 * approve.cjs as Node and this main — the lock, `second-instance` — never runs (test/prism-hook-runs-as-node.test.ts).
 * main.ts's own hook branch (genie#1237) is gone with it. A second launch that carries a script still never raises Genie
 * (core/quit-flag.ts `secondInstanceAction`), as defence in depth.
 */
const launch: LaunchDecision = launchDecision({
    argv: process.argv,
    primary: app.requestSingleInstanceLock(asksToQuit(process.argv) ? { ...QUIT_DATA } : undefined),
});
if (launch.kind === 'exit') {
    console.log(`[genie] ${launch.reason}`);
    app.exit(0);
}
/*
 * THE LAST-KNOWN STATE ON EVERY EXIT PATH THIS PROCESS CAN CATCH (Tynn #386: window-crash-recorder.ts): a small record in
 * runtime/crash — the reason or code, the time, the last RSS, the running agents' names, never content — on `exit`, an
 * uncaught exception, an unhandled rejection, a renderer or the GPU gone, and before-quit (taken back by a quit that runs
 * to its end). A boot launch only: a second instance owns nothing. Synchronous, never throwing.
 */
const crashRecorder = new WindowCrashRecorder({
    pid: process.pid,
    rss: () => process.memoryUsage.rss(),
    agents: () => (registry && host ? registry.snapshot().agents.filter((a) => host!.probe(a.id as AgentId)?.running === true).map((a) => a.name) : []),
    write: (record) => writeCrashRecord(join(runtimeDir(genieRoot()), 'crash'), record),
    remove: removeCrashRecord,
    // The host's build as this window last heard it (its welcome); this Genie's version until it has linked.
    header: () => crashHeader(app.getVersion(), agentEngineLink?.client.welcome?.build ?? app.getVersion()),
    // The main window's page, as last sampled: what it had grown to when it ended (an oom, the owner's 2026-11-06).
    rendererMb: () => pageMemory.mb(),
});
if (launch.kind === 'boot') crashRecorder.install(process, app);
/** Window main's heartbeat to genie-host's hang watchdog (hang-watchdog.ts): started once the engine link is up. */
let heartbeatNow: { stop(): void; bye(): void } | null = null;

let window: BrowserWindow | null = null;
/**
 * The main window's page working set, as last REALLY read (app.getAppMetrics: a missing renderer or a 0 never overwrites a
 * real reading, and a page's load reads again until it gets one; renderer-recovery.ts `pageMemorySampler`).
 */
const pageMemory = pageMemorySampler({
    read: () => {
        const win = window;
        if (!win || win.isDestroyed()) return null;
        const pid = win.webContents.getOSProcessId();
        const metric = app.getAppMetrics().find((m) => m.pid === pid);
        return metric ? metric.memory.workingSetSize * 1024 : null;
    },
    later: (fn) => { setTimeout(fn, 250).unref?.(); },
});
/** The main window's page ended and was brought back (renderer-recovery.ts): the notice every snapshot carries. */
let rendererNotice: RendererNotice | null = null;
/** The door's tunnel to genie-host (Tynn #898 step 2d-4b): what this window owns is said down it on every change. */
let windowTunnelNow: { refreshWindow(): void } | null = null;
/** Only the window constructors using preload.cjs admit contents to this local frame door. */
// Which window a connection is decides what it may do (Tynn #578): main's own record, read when the page connects.
const localDoor = localProtocolDoor(ipcMain, { windowKind: (contents) => (isRemoteWindow(contents as Electron.WebContents) ? 'remote' : 'main'), onClosed: (reason) => rendererErrorLog?.(`local door closed: ${reason}`) });
/**
 * THE STALL WATCHDOG (beta.53 freezes; main/stall-watchdog.ts): main's held event loop, slow renderer requests and slow
 * outbound calls, the windows' own long tasks and frame gaps, hung renderers and gone child processes — each a line in
 * lifecycle.log. Every invoke handler is timed from here, before any is registered; the log is opened at boot.
 */
let stallLog: ((line: string) => void) | null = null;
/** Main's own stack, sampled cheaply and read on a block (main/stall-profile.ts); started at boot. */
let stallProfiler: { capture(ms: number): void; stop(): void } | null = null;
/**
 * THE SPAWN HOST (genie#1397): the child that creates every process main used to create on its own thread — the Docker
 * CLI (600 s of the owner's main in one beta.54 session, up to 18.3 s at a time), every other `execFileRunner` command,
 * `docker events`, and the supervisor's ptys (sites, workers, the front door). Started at boot; stopped last at quit.
 */
let spawnHostNow: SpawnHostClient | null = null;
/** The route the main window shows (its URL after `#`), or `null`: what a stall line and a heartbeat (#711) say. */
function mainRoute(): string | null {
    const url = window && !window.isDestroyed() ? window.webContents.getURL() : '';
    const at = url.indexOf('#');
    return at === -1 ? null : url.slice(at + 1);
}
const stallWatchdog = new StallWatchdog({
    log: (line) => stallLog?.(line),
    onMainStall: (ms) => stallProfiler?.capture(ms),
    routeOf: mainRoute,
});
timeIpcHandlers(ipcMain, stallWatchdog);
/** A window's name in the log: its page (`index`, `question`, `browser`…), from its URL. */
function windowNameOf(contents: Electron.WebContents): string {
    try {
        const page = new URL(contents.getURL()).pathname.split('/').pop() ?? '';
        return page.replace(/[.]html$/, '') || 'blank';
    } catch {
        return 'unknown';
    }
}
/** Electron's own hang signal for a window, into the log: `unresponsive`, then `responsive` with how long. */
function watchWindowHang(w: BrowserWindow): void {
    w.on('unresponsive', () => { if (!w.isDestroyed()) stallWatchdog.unresponsive(windowNameOf(w.webContents), true); });
    w.on('responsive', () => { if (!w.isDestroyed()) stallWatchdog.unresponsive(windowNameOf(w.webContents), false); });
}
/** The tray outlives every window; held so it is not garbage-collected into nothing. */
let tray: Tray | null = null;
/** The tray's handlers, kept so a held login (Tynn #794) can redraw its menu; and what it last showed as held. */
let trayHandlers: TrayHandlers | null = null;
let trayHeldKey = '';
/** The tray's two faces (tray.ts trayImages), and how many Deck items wait on the person — the Deck badge's own number. */
let trayImages: ReturnType<typeof buildTrayImages> | null = null;
let trayWaiting = 0;
/** The tray says which provider logins the rate limit holds, with Resume now — redrawn only when that CHANGES. */
/** One alert per paused login (core/account-pause.ts): the person is told once, however many of its agents stop. */
const pauseAlerts = new PauseAlerts();

function refreshTray(): void {
    // A PAUSED ACCOUNT ALERTS, window or no window (the owner, 2026-10-21: a payment failure paused his subscription and
    // nothing said so). Read here because every agent change refreshes the tray.
    const paused = host?.pausedProviders() ?? [];
    for (const provider of pauseAlerts.update(paused)) alertAccountPaused(provider);
    if (!tray || !trayHandlers) return;
    const held = (host?.heldLogins() ?? []).flatMap((l) => { const words = limitWords(l.view); return words ? [{ provider: l.provider, words }] : []; });
    // An update on offer leads the menu (Tynn #761).
    const update = trayUpdate(updates?.state() ?? null);
    // Signed-out logins (#967): named in the tray with their own `Log in to …`.
    const signedOut = host?.signedOutProviders() ?? [];
    // Claude Design's login (#1081): per machine, so one line however many agents wait on it.
    const designLogin = (host?.designLoginAgents().length ?? 0) > 0;
    // GENIE-HOST RUNNING (P1b): the tray says so, and WHAT it runs — what a person with no window open sees. Whether a
    // window is open changes the menu ("Just close the UI" only with one).
    const hostNow = agentEngineLink?.live === true ? hostActivityNow() : null;
    const uiOpen = window !== null && !window.isDestroyed();
    const key = JSON.stringify({ held, update, signedOut, paused, designLogin, waiting: trayWaiting, hostNow, uiOpen });
    if (key === trayHeldKey) return;
    trayHeldKey = key;
    trayMenuNow = trayMenuTemplate(trayHandlers, held, update, signedOut, paused, designLogin);
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuNow));
    trayTooltipNow = trayTooltip(held, signedOut, paused, designLogin, trayWaiting, hostNow);
    tray.setToolTip(trayTooltipNow);
    // THE DECK NEEDS YOU (the owner, 2026-10-26): the mark with a dot while anything waits on the person.
    if (trayImages) tray.setImage(trayWaiting > 0 ? trayImages.attention : trayImages.plain);
}

/** What the tray says and offers now (refreshTray): read by the tray probe, as Electron's Tray cannot be asked. */
let trayTooltipNow = 'Genie';
let trayMenuNow: TrayItem[] = [];

/** What genie-host runs now, as the tray says it and the tray-only rule counts it (core/tray-only.ts). */
function hostActivityNow(): HostActivity {
    const agents = registry && host ? registry.snapshot().agents.filter((a) => host!.probe(a.id as AgentId)?.running === true).length : 0;
    // The processes and the services are genie-host's, in its summary (Tynn #1045, 2g-4d-C).
    return { agents, terminals: hostSummaryNow.terminals.length, processes: hostSummaryNow.processes.length, services: hostSummaryNow.services.length, ...onTheClockNow(), browser: browserLinked ? 1 : 0 };
}

/** What waits on the host's clock, from genie-host's summary (core/tray-only.ts's rule). With no host, nothing outlives the window. */
function onTheClockNow(): { armedFlows: number; scheduledTasks: number } {
    if (agentEngineLink?.live !== true) return { armedFlows: 0, scheduledTasks: 0 };
    return { armedFlows: hostSummaryNow.armedFlows.length, scheduledTasks: hostSummaryNow.scheduledTasks.length };
}

/**
 * JUST CLOSE THE UI (P1b; the owner, 2026-11-02: "Keep the tray up … as long as any genie services are running, that tray
 * should be there so users can shut them down or restart if needed"). Every window closes — the main one and every other
 * (Take Over, files, remote, the Genie browser) — and this process stays as the tray: still the host's window client, so
 * the phone/remote link and the .gen front door keep working. Nothing of the host is touched. Open Genie (or a second
 * launch) builds the window again (revealMainWindow → mountMainWindow); with nothing left running, watchTrayOnly ends it.
 */
function closeUi(reason: string): void {
    leftRunning.set(true);
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
    window = null;
    browserPane = null;
    trayQuietSince = null;
    rendererErrorLog?.(`ui closed (${reason}): Genie stays in the tray`);
    refreshTray();
}

/**
 * What a Restart or a Shut down everything would stop, named (core/tray-confirm.ts): the running agents, every open
 * terminal (marked when a command runs in it — read from the process table), the kept processes, the active services and
 * the sites.
 */
function stoppingNow(table: Parameters<typeof terminalBusy>[1]): Stopping {
    const agents = registry && host ? registry.snapshot().agents.filter((a) => host!.probe(a.id as AgentId)?.running === true).map((a) => a.name) : [];
    const workspaces = registry?.snapshot().workspaces ?? [];
    const seen = new Map<string, number>();
    const terminalsOpen = hostSummaryNow.terminals.map((t) => {
        const n = (seen.get(t.workspaceId) ?? 0) + 1;
        seen.set(t.workspaceId, n);
        const ws = workspaces.find((w) => w.id === t.workspaceId);
        // A terminal whose pid has not come in yet runs no command it could be busy with.
        return { name: `${ws ? basename(ws.path) : t.workspaceId} · terminal ${n}`, busy: t.pid !== null && terminalBusy(t.pid, table) };
    });
    const clockFlows = agentEngineLink?.live === true ? [...hostSummaryNow.armedFlows] : [];
    const clockTasks = agentEngineLink?.live === true ? [...hostSummaryNow.scheduledTasks] : [];
    // The kept processes, the active services and the sites, as genie-host's summary names them (Tynn #1045, 2g-4d-C).
    return { agents, terminals: terminalsOpen, processes: [...hostSummaryNow.processes], services: [...hostSummaryNow.services], sites: [...hostSummaryNow.sites], flows: clockFlows, scheduled: clockTasks };
}

/** How long the tray's question waits for the busy marks' process table (read off main) before it is asked without them. */
const TRAY_TABLE_MS = 1_500;

/**
 * ALWAYS ASK (the owner, 2026-11-02): the tray's Restart and Shut down everything confirm first, every time — what will stop,
 * named; Cancel the default and the cancel; only the confirm button goes on. Not asked anywhere else: the quit dialog's own
 * answer, the tray-only exit, the OS ending the session, the upgrade.
 */
async function confirmTray(action: TrayAction): Promise<boolean> {
    const table = await tableWithin(() => systemProcessTree.read?.() ?? Promise.resolve(null), TRAY_TABLE_MS);
    const q = trayConfirm(action, stoppingNow(table));
    return trayConfirmed(dialog.showMessageBoxSync({ type: 'question', title: q.title, message: q.message, buttons: [...q.buttons], defaultId: q.defaultId, cancelId: q.cancelId }));
}

/**
 * RESTART (the tray, P1b): everything shut down as a quit does — the running set recorded first, so the agents that were
 * running start again (§7.6); genie-host ended — and Genie started again, in the tray (`--hidden`). Kept processes come
 * back by their own restore and restart policy; terminals end with their shells.
 */
function restartGenie(): void {
    rendererErrorLog?.('restart asked for from the tray');
    app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== HIDDEN_ARG), HIDDEN_ARG] });
    requestQuit('shut-down');
}

/** Since when a tray-only Genie has had nothing running (core/tray-only.ts); null while anything runs or a window is open. */
let trayQuietSince: number | null = null;
/** One look, every few seconds while genie-host runs: the tray says what runs, and a tray-only Genie with nothing left ends. */
function watchTrayOnly(): void {
    refreshTray();
    const step = trayOnlyStep({ uiOpen: window !== null && !window.isDestroyed(), activity: hostActivityNow() }, trayQuietSince, Date.now());
    trayQuietSince = step.quietSince;
    if (step.exit) {
        rendererErrorLog?.('tray only: nothing left running for a minute; shutting everything down');
        leftRunning.set(false);
        requestQuit('shut-down');
    }
}

/** Each provider's rate limit as the Dashboard header shows it, buffered (core/headroom-board.ts). */
const headroomFeed = new HeadroomFeed(() => headroomBufferMs(settingsNow.snapshot()));

/** The desktop notification for a login whose account the provider paused: what it said, and what to do. */
function alertAccountPaused(provider: string): void {
    const first = host?.pausedAgents(provider)[0];
    const pause = first ? host?.probe(first)?.accountPaused ?? null : null;
    const count = host?.pausedAgents(provider).length ?? 0;
    console.warn(`[genie] ${provider} account paused (${pause?.reason ?? 'unknown'}): ${count} agent(s) stopped`);
    if (!Notification.isSupported()) return;
    const n = new Notification({
        title: `${loginName(provider)}: account paused`,
        body: `${pause ? `${pause.words[0]!.toUpperCase()}${pause.words.slice(1)}` : 'The provider refused this account'}. Genie stopped ${count === 1 ? 'the agent' : `${count} agents`} on it. Check the subscription and its billing with ${loginName(provider)}, then use Try again.`,
    });
    n.on('click', () => { revealMainWindow('notification click: account paused'); });
    n.show();
}

/** The automatic update checks (§7, genie2#91): stopped on quit so no check fires into a closing app. */
let registry: Registry | null = null;
/** Each workspace's colour (genie#1300): read from and written to its project.json. */
let workspaceColors: WorkspaceColors | null = null;
/** Save to repo (Tynn #756): this workspace's project.json and repo files, saved against upstream. */
const NO_OFFERS = { ok: false as const, reason: 'Genie’s host is not running, so nothing is watching the repo' };
/**
 * ISSUEWATCH (Tynn #806; the host split, P5c): genie-host hears Tynn and holds the state — the latest entry per project,
 * when it arrived, what happened lately, the repo switches, the client's state. This window reads it through the replica
 * (issue-watch-replica.ts): what `checkIssues`, imDone's count line and the GitHub panel read for a workspace (its
 * project.json `tynn.projectId`).
 */
let issueWatchNow: IssueWatchReplica | null = null;
/**
 * THE LIVE BOARD (genie#1295 row B4; the host split, P5c): genie-host follows each open Tynn tab per view — one socket for
 * every board, released with this window's link — and its rings and live state come back for the views watching. Since P4
 * family 12 (Tynn #561) a view's watch is its local connection's (`tynn.watch` on the door, remote-host.ts), released with
 * it, and its signals reach only that connection.
 */
let tynnBoardDoor: { watch(viewId: string, workspaceId: string): Promise<boolean>; unwatch(viewId: string): void } | null = null;
/** Issues subscriptions belong to the host connection, just like the live board's. */
let tynnIssuesDoor: { watch(viewId: string, workspaceId: string): Promise<boolean>; unwatch(viewId: string): void } | null = null;
/** Features subscriptions (row F1) belong to the host connection, like the Issues queue's; no host, no live page. */
let tynnFeaturesDoor: { watch(viewId: string, workspaceId: string): Promise<boolean>; unwatch(viewId: string): void } | null = null;
/** The Tynn tab's live signals, to the local door's watch port (P4 family 12): never broadcast to every window. */
const tynnLive = new Set<(event: TynnWatchEvent) => void>();
const emitTynn = (kind: TynnWatchKind, workspaceId: string, signal: unknown): void => { for (const l of [...tynnLive]) l({ kind, workspaceId, signal }); };
const tynnDoorOf = (kind: TynnWatchKind) => (kind === 'board' ? tynnBoardDoor : kind === 'issues' ? tynnIssuesDoor : tynnFeaturesDoor);
/** The host API's Tynn watch port: one view per local window's watch; a board is followed only when it is linked. */
const tynnWatchPort: TynnWatchPort = {
    watch: async (kind, viewId, workspaceId) => {
        const door = tynnDoorOf(kind);
        if (door === null || (kind === 'board' && tynnProjectFor(workspaceId) === null)) return false;
        return door.watch(viewId, workspaceId);
    },
    unwatch: (kind, viewId) => { tynnDoorOf(kind)?.unwatch(viewId); },
    subscribe: (listener) => { tynnLive.add(listener); return () => { tynnLive.delete(listener); }; },
};
function tynnProjectFor(workspaceId: string): string | null {
    const workspace = (registry?.snapshot().workspaces ?? []).find((w) => w.id === workspaceId);
    let manifest: string | null = null;
    if (workspace) { try { manifest = readFileSync(join(workspace.path, 'project.json'), 'utf8'); } catch { manifest = null; } }
    return tynnProjectIdOf(manifest);
}
/** The workspace folders this run has already moved AGENT.md front matter out of (Tynn #694). */
const agentConfigsMoved = new Set<string>();
async function moveAgentConfigs(workspaces: readonly { id: string; path: string }[]): Promise<void> {
    const fs = nodeAgentConfigFs();
    for (const w of workspaces) {
        if (agentConfigsMoved.has(w.path)) continue;
        agentConfigsMoved.add(w.path);
        try {
            const moved = await moveAgentFrontmatter(fs, w.path);
            if (!moved.ok) console.warn(`[genie] agent config for ${w.id}: ${moved.reason}`);
            else if (moved.moved.length > 0) console.log(`[genie] agent config for ${w.id}: moved ${moved.moved.join(', ')} from AGENT.md front matter into project.json`);
        } catch (error) {
            console.warn(`[genie] agent config for ${w.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
/** Every workspace's GitHub panel (Tynn #806), as the features snapshot carries it. */
function issueWatchPanels(): Record<string, IssueWatchPanelView> {
    return issueWatchNow?.panels(registry?.snapshot().workspaces ?? [], tynnProjectFor, Date.now()) ?? {};
}
/** Have Tynn read a workspace's repos now (its project.json `tynn.projectId`): the host's call. */
async function issueWatchRefreshFor(workspaceId: string): Promise<IssueWatchRefreshAnswer> {
    if (tynnProjectFor(workspaceId) === null) return { ok: false, reason: 'this workspace is not linked to a Tynn project' };
    if (!issueWatchNow) return { ok: false, reason: 'IssueWatch is not running' };
    return issueWatchNow.refresh(workspaceId);
}
/** A Watched repos checkbox: Tynn's switch, set by the host, which reads the switches again (Tynn pushes the changed feed itself). */
async function issueWatchSetRepoFor(workspaceId: string, owner: string, repo: string, change: { enabled?: boolean; includeUpstream?: boolean }): Promise<unknown> {
    if (tynnProjectFor(workspaceId) === null || !issueWatchNow) return { ok: false, reason: 'IssueWatch is not running for this workspace' };
    return issueWatchNow.setRepo(workspaceId, owner, repo, change);
}
function issueWatchSummaryFor(workspaceId: string): IssueWatchSummary {
    const projectId = tynnProjectFor(workspaceId);
    return issueWatchNow?.summaryFor(projectId) ?? { state: 'stopped', linked: projectId !== null };
}
/**
 * WHAT GENIE-HOST RUNS, AS IT LAST SAID (Tynn #953, 2g-2): its live terminals, armed flows and scheduled tasks, kept by
 * main's own client (summary.watch). The tray's count, its Restart/Shut-down list and the quit plan read it synchronously.
 */
let hostSummaryNow: HostSummary = EMPTY_HOST_SUMMARY;
/**
 * MAIN'S OWN PROTOCOL CLIENT (Tynn #896, 2b-2b): what main itself asks of the host (the tray's Log in and Claude Design
 * login) is a protocol call answered by genie-host, one connection per call, tunnelled over the engine link like the
 * window's door once the link is composed. Before that a call is refused as still starting.
 */
const ownProtocol = ownProtocolClient();
/**
 * THE SETTINGS THIS WINDOW READS ARE GENIE-HOST'S, KEPT FROM settings.watch on main's own client (Tynn #998, 2g-4b1;
 * window-settings.ts): do not disturb, start minimized, the login item, the tray notice, the window tools, the terminal's cwd
 * tracking. Its writes go to genie-host over the protocol.
 */
const settingsNow = windowSettings(ownProtocol);
/** genie-host's front door, as its frontdoor.watch says it (Tynn #1046, 2g-4d-D1): what this window's browser reads. */
const frontDoorWatch = windowFrontDoor(ownProtocol);
/** How long boot waits for genie-host's front door before it builds the browser sessions with none (they follow it later). */
const FRONT_DOOR_BOOT_DEADLINE_MS = 10_000;
/** A window-run tool's approval: genie-host's one queue, over main's own client, with the approval's own deadline (Tynn #1006). */
const approvalsNow = windowApprovals(ownProtocol);
/** How long the boot waits for genie-host's settings before reading start minimized and the login item at their defaults. */
const SETTINGS_BOOT_DEADLINE_MS = 10_000;
// SWITCH ACCOUNT (Tynn #753): the provider's own login in its one home, in a window that shows the steps. The entry the UI calls.
/** Stops the deferred sweep of old scratch folders (scratch-area.ts); called on quit. */
let scratchSweepStop: (() => void) | null = null;
let filesHost: FilesHost | null = null;
let filesWindows: FilesWindows | null = null;
let host: AgentEngine | null = null;
/**
 * SAFE MODE AS THIS WINDOW READS IT (Tynn #386; window-safe-mode.ts): genie-host's, over the link. Opened once the link is known.
 */
let windowSafe: WindowSafeMode | null = null;
/** No genie-host could start: say what is wrong and how to fix it, then try again or leave. The window runs nothing itself (Tynn #415). */
async function stopForNoHost(reason: string | null): Promise<void> {
    const logFile = join(genieRoot(), 'logs', 'genie-host.log');
    const plan = hostDownPlan({ reason, logFile });
    for (;;) {
        const { response } = await dialog.showMessageBox({ type: 'error', title: plan.title, message: plan.message, detail: plan.detail, buttons: [...plan.buttons], defaultId: 0, cancelId: 2, noLink: true });
        const answer = hostDownAnswer(response);
        if (answer === 'open-log') { void shell.openPath(logFile); continue; }
        if (answer === 'retry') app.relaunch();
        app.exit(0);
        return;
    }
}
const windowSafeNow = (): boolean => windowSafe?.active() === true;
/** The link to `genie-host` (the host split, phase 1); `null` only before it is made, because a window with no host stops. */
let agentEngineLink: AgentEngineLink | null = null;
/** Electron reports no change of proxy settings: asked when a window links and when the machine wakes. */
let handProxyAnswers: (() => Promise<void>) | null = null;
function reportProxies(client: SessionEngineClient, log: (line: string) => void): Promise<void> {
    return reportProxyAnswers({
        hosts: [TYNN_HOST, 'https://github.com', 'https://api.github.com'],
        resolve: (url) => (url === TYNN_HOST ? session.fromPartition('persist:tynn') : session.defaultSession).resolveProxy(url),
        send: async (answers) => {
            const reply = await client.call('engine.proxyRemember', [answers]);
            if (!reply.ok) throw new Error(reply.reason);
        },
        log,
    });
}
/** Every agent's activity feed (core/activity-feed.ts): what the workspace Dashboard's lanes draw (beta.33 item 10). */
let activityFeeds: ActivityFeeds | null = null;

/** The Dashboard's comms cell (§4.1): AgentInbox traffic since the session started, bounded to the newest 2000 mails. */
/** The updater as this window reads and drives it: genie-host's, through a replica (P5b). */
let updates: (Pick<UpdateHost, 'state' | 'check' | 'download' | 'install' | 'refreshNotes' | 'onChange' | 'setChannel'> & { prepareQuit?: () => Promise<unknown>; forceDrain?: () => boolean | Promise<boolean>; cancelDrain?: () => void | Promise<void> }) | null = null;
/** Repeated quit requests cannot skip the pending safe-point wait or overwrite its final record. */
let quitPreparation: Promise<unknown> | null = null;
let updateQuitReady = false;
/**
 * ONE QUIT (core/quit.ts `quitSequence`): asked at most once, the running set recorded at most once (§7.6 — an
 * upgrade's drain records it itself, so the quit does not overwrite it with the empty list it leaves), the shutdown
 * run exactly once. Its `quitting` is what turns the main window's close from a hide into a real close.
 */
const quit = quitSequence();
/** That the person left the host running (P6): what brings it back at logon with the setting off. */
const leftRunning = new LeftRunningMark(runtimeDir(genieRoot()));

/**
 * THE QUIT a person asks for — the tray's Quit, and `Genie --quit` from outside (core/quit-flag.ts), one entry for both.
 * `app.quit()` runs before-quit, so the confirmation is asked only where it would be, and the shutdown runs once. The
 * tray's Shut down everything and Restart, and the tray-only exit (P1b), come with their answer: nothing is asked.
 */
function requestQuit(answer?: 'shut-down'): void {
    if (answer) quit.choose(answer);
    app.quit();
}

/**
 * A Take Over window: the OS frame (there is no Genie chrome to replace it), one terminal.
 * Loads the same renderer with the take-over route in its hash; `App` renders only the pane
 * for that route. Closing it ends the take-over — the window IS the session.
 */
function openTakeOverWindow(route: string, activation: Activation): Promise<'closed' | 'raised'> {
    const request = { activation, reason: `take-over window ${route}`, ledger: activationLedger, label: 'takeover' };
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && !remoteTakeOverWindows.has(w) && w.webContents.getURL().endsWith(`#${route}`)) { bringUp(w, request); return Promise.resolve('raised'); }
    }
    const win = takeOverWindow(route, request, null);
    // Settled when it closes: a Take Over TUI's or a sign-in's window is asked by genie-host (windowOps), which ends the TUI
    // or cancels the sign-in then (Tynn #896, #479), or ends a scratch terminal (#897, 2c-4): the person left the step.
    return new Promise((resolve) => win.on('closed', () => resolve('closed')));
}

/**
 * A TAKE OVER WINDOW: this machine's terminal (`remote` null), or another machine's (Tynn #529 part A) — then bound to
 * that machine by its query, with the ticket in main's own map for the window to read once. Never in the URL or title.
 */
function takeOverWindow(route: string, request: ActivationRequest, remote: { search: string; ticket: string } | null): BrowserWindow {
    const win = new BrowserWindow({
        width: 1100,
        height: 700,
        ...genieWindowIcon(here),
        backgroundColor: '#0a0a0c',
        show: false,
        webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // Links open in the browser (http(s) only), never in a Genie window (Tynn #763, main/external-links.ts).
    if (remote) {
        takeOverTickets.set(win.webContents.id, remote.ticket);
        remoteTakeOverWindows.add(win);
        const contentsId = win.webContents.id;
        win.on('closed', () => { takeOverTickets.delete(contentsId); remoteTakeOverWindows.delete(win); });
    }
    localDoor.admit(win.webContents);
    guardWindowLinks(win.webContents, (url) => { void shell.openExternal(url).catch(() => {}); });
    onceShowable(win, process.platform, () => showWhenReady(win, request));
    void loadWindowPage(win.webContents, 'index', remote ? { search: remote.search, hash: route } : { hash: route }).catch((error: unknown) => console.error(`[window-pages] ${String(error)}`));
    return win;
}

/**
 * ANOTHER MACHINE'S TERMINAL IN A TAKE OVER WINDOW HERE (Tynn #529 part A). The window driving that machine was answered
 * Take over with the terminal and a TICKET; this window connects to the same machine as that window's companion, with the
 * ticket. The ticket is a credential for one terminal: it is kept in main's own map for this window, never in its URL,
 * its title or a log, and the window reads it once.
 */
const takeOverTickets = new Map<number, string>();
const remoteTakeOverWindows = new Set<BrowserWindow>();
function openRemoteTakeOverWindow(url: string, terminalId: string, ticket: string, name: string | null, loginRoute: string | null = null): void {
    const search = remoteWindowSearch(url, name);
    if (remoteFromSearch(search) === null) return;
    const route = loginRoute ?? takeOverRouteOf(terminalId);
    const request = { activation: 'user-gesture' as const, reason: `remote take-over window ${route}`, ledger: activationLedger, label: 'takeover' };
    takeOverWindow(route, request, { search, ticket });
}

/**
 * A workspace's page in a window of its own, opened on `route` and told apart by it: asking again brings the open one up.
 * `onClosed` runs when it closes. The window loads the same renderer, which draws what the route names.
 */
function openRouteWindow(route: string, activation: Activation, label: string, size: { width: number; height: number }, onClosed?: () => void): void {
    const request = { activation, reason: `${label} window ${route}`, ledger: activationLedger, label };
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.webContents.getURL().endsWith(`#${route}`)) { bringUp(w, request); return; }
    }
    const win = new BrowserWindow({
        ...size,
        ...genieWindowIcon(here),
        backgroundColor: '#0a0a0c',
        show: false,
        webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // Links open in the browser (http(s) only), never in a Genie window (Tynn #763, main/external-links.ts).
    localDoor.admit(win.webContents);
    guardWindowLinks(win.webContents, (url) => { void shell.openExternal(url).catch(() => {}); });
    onceShowable(win, process.platform, () => showWhenReady(win, request));
    if (onClosed) win.on('closed', onClosed);
    void loadWindowPage(win.webContents, 'index', { hash: route }).catch((error: unknown) => console.error(`[window-pages] ${String(error)}`));
}

/** THE FILE PANEL IN ITS OWN WINDOW (§4.3): one per workspace; the route names it. Closing it docks the panel back. */
function openFilesWindow(route: string, activation: Activation): void {
    const workspaceId = route.split('/').pop() ?? '';
    openRouteWindow(route, activation, 'files', { width: 960, height: 720 }, () => filesWindows?.windowClosed(workspaceId));
}

/** A WORKSPACE'S TERMINALS IN A WINDOW OF ITS OWN (Tynn #706): the Dashboard's windows column. Nothing is tracked; closing it closes it. */
function openTerminalsWindow(route: string, activation: Activation): void {
    openRouteWindow(route, activation, 'terminals', { width: 1100, height: 720 });
}

/**
 * THE FLOW EDITOR IN ITS OWN WINDOW (genie#1204; Genie 1's genie#505 — its editor first lived in a modal card that clipped
 * the canvas). A real, resizable window per flow, whose whole client area is the canvas; opening a flow already open
 * brings its window up. A new flow's window moves to the flow's own route on its first save.
 */
function openFlowEditorWindow(route: string, activation: Activation): void {
    const request = { activation, reason: `flow editor ${route}`, ledger: activationLedger, label: 'flow' };
    for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        const url = w.webContents.getURL();
        if (!url.endsWith(`#${route}`) && !sameFlowWindow(url, route)) continue;
        // The flow is open already (Tynn #860): a link to one of its runs moves THAT window to the run, never a second window.
        if (!url.endsWith(`#${route}`) && route.includes('?run=')) void w.webContents.executeJavaScript(`window.location.replace(${JSON.stringify(`#${route}`)})`).catch(() => {});
        bringUp(w, request);
        return;
    }
    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 480,
        minHeight: 360,
        ...genieWindowIcon(here),
        backgroundColor: '#0a0a0c',
        show: false,
        webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // Links open in the browser (http(s) only), never in a Genie window (Tynn #763, main/external-links.ts).
    localDoor.admit(win.webContents);
    guardWindowLinks(win.webContents, (url) => { void shell.openExternal(url).catch(() => {}); });
    onceShowable(win, process.platform, () => showWhenReady(win, request));
    void loadWindowPage(win.webContents, 'index', { hash: route }).catch((error: unknown) => console.error(`[window-pages] ${String(error)}`));
}

function closeWindowAt(route: string): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.webContents.getURL().endsWith(`#${route}`)) w.close();
    }
}

/**
 * WHAT THE WINDOW SHOWS, asked for (genie#1265, core/view-requests.ts): the person's gesture navigates; an agent's action
 * pulses the workspace it acted in and moves nothing. Main changes the window's view through here and nothing else.
 */
function showToPerson(request: ViewRequest): void {
    const delivery = viewDelivery(request);
    // A navigation goes to the MAIN window only (genie#1302): broadcast, it turned an open flow editor, take-over or file
    // window into the main app too. A pulse moves nothing and still reaches every window.
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && viewReaches(delivery, { main: w === window })) w.webContents.send(delivery.channel, delivery.payload);
}

/** Pushed to EVERY window — a popped-out panel is a window too. */
function broadcast(channel: string, ...args: unknown[]): void {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

/**
 * Where GENIE 1 keeps its database: Chromium's userData (`%APPDATA%\genie`), not `~/.genie` —
 * Genie 2's own data root, which v1 never wrote to. The first release read `~/.genie/genie.db`,
 * found nothing, and reported "nothing to carry over" to an owner with 27 workspaces.
 */
/** A workspace's colour from its Settings (genie#1300): written to its project.json through Genie's writer. */
async function setWorkspaceColor(rawId: unknown, color: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
    const workspace = typeof rawId === 'string' ? registry?.workspace(rawId) ?? null : null;
    if (!workspace || !workspaceColors) return { ok: false, reason: 'name a workspace' };
    if (typeof color !== 'string') return { ok: false, reason: 'name a colour (#rrggbb)' };
    return workspaceColors.set(workspace.path, color);
}


/** The tray icon: shipped beside the app as an extra resource; the repo's build/ in a dev run; the embedded mark otherwise. */
function trayIconPath(): string | null {
    for (const p of [join(process.resourcesPath, 'tray-icon.png'), join(here, '..', '..', 'build', 'tray-icon.png')]) if (existsSync(p)) return p;
    return null;
}

function v1DatabaseFile(): string {
    return join(app.getPath('userData'), 'genie.db');
}

/**
 * IMPORT v1's WORKSPACES AND AGENTS, ONCE. The plan is pure (core/v1-import.ts); the marker file
 * in Genie's data root is what makes "once" true across restarts; what was skipped is written
 * there too and logged, because a silent partial import is a missing workspace nobody can explain.
 */
async function importFromV1(theRegistry: Registry): Promise<void> {
    const marker = join(genieRoot(), 'v1-import.json');
    // Once — but beta.7's import did not carry v1's hibernation, so a marker without `hibernationApplied` gets
    // ONE amendment pass that puts v1-hibernated workspaces to sleep; after that the marker says so and nothing
    // here runs again (a person who wakes a workspace in Genie 2 must not find it asleep at the next boot).
    // Genie 1's DEFAULT AGENTS (role = 'workspace') were not carried either: a marker without `defaultsApplied` gets ONE
    // pass that designates them where a workspace has none — after that a default chosen in Genie 2 is never overwritten.
    let prior: { hibernationApplied?: boolean; defaultsApplied?: boolean } | null = null;
    if (existsSync(marker)) {
        try { prior = JSON.parse(readFileSync(marker, 'utf8')) as { hibernationApplied?: boolean; defaultsApplied?: boolean }; } catch { prior = {}; }
        if (prior?.hibernationApplied === true && prior.defaultsApplied === true) return;
    }
    const catalog = readV1Catalog(v1DatabaseFile());
    const plan = planV1Import(
        catalog,
        { workspaces: theRegistry.listWorkspaces().map((w) => ({ id: w.id, asleep: w.asleep === true })), agents: theRegistry.listAgents().map((a) => ({ workspaceId: a.workspaceId, name: a.name })) },
        (p) => existsSync(p),
    );
    if (prior === null) {
        for (const w of plan.workspaces) await theRegistry.addWorkspace({ id: w.id, path: w.path, ...(w.asleep ? { asleep: true } : {}) });
        for (const a of plan.agents) await theRegistry.register({ workspaceId: a.workspaceId, provider: a.provider, name: a.name, instructions: a.instructions });
    }
    const hibernate = prior?.hibernationApplied === true ? [] : plan.hibernate;
    for (const id of hibernate) await theRegistry.setAsleep(id, true);
    let defaults = 0;
    if (prior?.defaultsApplied !== true && catalog !== null) {
        for (const [workspaceId, agentId] of Object.entries(v1DefaultAgents(catalog.agents, theRegistry.listAgents()))) {
            // Only where nobody CHOSE one: the first agent the import registered is the default automatically (Tynn #1015).
            if (theRegistry.chosenDefaultAgentOf(workspaceId) !== null) continue;
            if ((await theRegistry.setDefaultAgent(workspaceId, agentId)).ok) defaults += 1;
        }
    }
    const result = { at: new Date().toISOString(), sawV1: catalog !== null, workspaces: prior === null ? plan.workspaces.length : 0, agents: prior === null ? plan.agents.length : 0, hibernated: plan.workspaces.filter((w) => w.asleep).length + hibernate.length, hibernationApplied: true, defaultsApplied: true, defaults, skipped: prior === null ? plan.skipped : [] };
    await writeFileText(marker, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[genie] v1 import: ${catalog === null ? 'no v1 database' : `${plan.workspaces.length} workspaces, ${plan.agents.length} agents`}${plan.skipped.length ? `; skipped ${plan.skipped.length}: ${plan.skipped.join(' | ')}` : ''}`);
}

/**
 * REAP v1's RUNTIME. The owner's first real upgrade left 73 of v1's processes running — shells
 * orphaned by v1's dead pty host, caddy site servers, php, node — because §7.2's teardown stops
 * what runs from the install directory and v1's runtime lives under userData. The rule is
 * core/v1-reap.ts; this applies it, pid by pid, and writes what it did to `~/.genie/v1-reap.json`.
 * Runs at every boot for v1's runtime binaries (provable by path). Orphaned INTERACTIVE shells are taken only on the boot
 * that imports Genie 1 — at any other boot an orphaned shell is somebody's background work: on 2026-10-13 this killed two
 * of the owner's running scripts.
 */
async function reapV1Runtime(includeShells: boolean): Promise<void> {
    const userData = app.getPath('userData');
    const roots = ['runtime', 'toolchain', 'pty-host'].map((d) => join(userData, d));
    // Read and ended OFF the loop (beta.53 freezes: this listing was a PowerShell run on main at every boot, ~3 s on Windows).
    const victims = v1Leftovers(await listProcessesAsync(), { roots, selfPid: process.pid, includeShells });
    if (victims.length === 0) return;
    const ended = await Promise.all(victims.map(async (v) => ((await killProcessAsync(v.pid)) ? v : null)));
    const killed = ended.filter((v) => v !== null);
    const report = { at: new Date().toISOString(), found: victims.length, killed: killed.length, victims: victims.map((v) => ({ pid: v.pid, executable: v.executable, why: v.why })) };
    await writeFileText(join(genieRoot(), 'v1-reap.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(`[genie] reaped v1's runtime: ${killed.length} of ${victims.length} (${victims.filter((v) => v.why === 'orphaned shell').length} orphaned shells, ${victims.filter((v) => v.why === 'v1 runtime binary').length} v1 binaries)`);
}

/** Where a window's render errors are written (core/render-error.ts): the lifecycle log, once boot has opened it. */
let rendererErrorLog: ((line: string) => void) | null = null;

function createWindow(show: boolean, search?: string): BrowserWindow {
    const win = new BrowserWindow({
        // The frame — hidden OS title bar, the native window buttons drawn over our 36 px bar on
        // Windows/Linux, a minimum size — is core/window.ts, where a test holds it. The owner's
        // first run had none of it: a window that could not be moved, resized or closed.
        ...mainWindowOptions(process.platform),
        // Genie's own icon on the window and its taskbar button — installed and dev alike (main/app-identity.ts).
        ...genieWindowIcon(here),
        backgroundColor: '#0a0a0c',
        show: false,
        webPreferences: {
            preload: join(here, 'preload.cjs'),
            // Expose the page's existing bridge to native harnesses; no product behavior changes.
            additionalArguments: process.env.GENIE_PAGE_PROBE === '1' ? ['--genie-page-probe'] : [],
            // The renderer gets `window.genie` and nothing else: no Node, no `require`, no
            // `ipcRenderer`. A renderer with Node integration is a renderer where a prompt
            // injection reaches the filesystem — and this one displays agent-authored text.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // A site panel is a <webview> (P2b): the main window alone, every one decided by main (site-webview-guard.ts).
            webviewTag: !search,
        },
    });
    // Links open in the browser (http(s) only), never in a Genie window (Tynn #763, main/external-links.ts).
    localDoor.admit(win.webContents);
    guardWindowLinks(win.webContents, (url) => { void shell.openExternal(url).catch(() => {}); });
    // The renderer's console reaches no file, so main writes the lines Genie keeps: the composer-focus log (genie#1235,
    // core/composer-focus.ts) and a surface's render error (parity audit #7), which also goes to the lifecycle log.
    win.webContents.on('console-message', (details) => forwardRendererConsole(details.message, { out: (l) => console.log(l), err: (l) => console.error(l), log: (l) => rendererErrorLog?.(l) }));

    // Paint when there is something to paint. A visible empty frame that then fills in is the
    // app looking broken for the length of a load. Start minimised (or a `--hidden` sign-in launch)
    // keeps it in the tray: the tray's Open shows it.
    // Shown active: this is the launch the person made (boot) or the remote window they asked for (genie#1235).
    if (show) onceShowable(win, process.platform, () => showWhenReady(win, { activation: 'user-gesture', reason: search ? 'remote window' : 'launch', ledger: activationLedger, label: search ? 'remote' : 'main' }));

    // A remote host's window carries the host in its query (core/remote-window.ts); the main window carries none.
    void loadWindowPage(win.webContents, 'index', search ? { search } : undefined).catch((error: unknown) => console.error(`[window-pages] ${String(error)}`));
    return win;
}

/**
 * A WINDOW PER REMOTE HOST (Genie 1's remote.open; Tynn #819): the host's own window, so the local Genie stays open. One
 * per host. Only a ws:// or wss:// URL, or a Tynn `relay:<id>`, is a host; anything else opens nothing.
 *
 * What Open does with one that already exists is core/remote-window-policy.ts (genie#1278, M0 finding 2): a Tynn relay
 * window belongs to the ACCOUNT whose grant it holds — another account's is replaced by a fresh connection, a dropped
 * one of this account is asked to reconnect, a live one is brought forward. An account change closes the relay windows
 * opened under another account (`closeRelayWindowsOfOtherAccounts`).
 */
const remoteWindows = new Map<string, BrowserWindow>();
/** A window driving ANOTHER host: never the host's own window, whatever it asks (genie#1354). */
const isRemoteWindow = (sender: Electron.WebContents): boolean => [...remoteWindows.values(), ...remoteTakeOverWindows].some((w) => !w.isDestroyed() && w.webContents === sender);
/** What the host's own file picker picked: the only host paths the person's AgentInbox may attach (host-picks.ts). */

/** The Tynn account each relay window was opened under (accountKeyOf). */
const remoteWindowAccount = new Map<BrowserWindow, string | null>();
/** The Tynn account genie-host is signed in to, as its summary says (Tynn #954, 2g-3a); `null` = signed out. */
const tynnAccountKeyNow = (): string | null => hostSummaryNow.tynnAccountKey;
function openRemoteWindow(url: string, name?: string | null): void {
    // The machine's NAME rides with the window (Genie 1's openWorkstationById: "The display name drives the host window
    // title"): its connecting screen says it, never the raw `relay:<id>`.
    const search = remoteWindowSearch(url, name);
    if (remoteFromSearch(search) === null) return;
    const open = remoteWindows.get(url);
    const exists = open !== undefined && !open.isDestroyed();
    const account = tynnAccountKeyNow();
    const action = remoteWindowAction({
        exists,
        // Whether its link is up is the window's own to know: asked to reconnect, it does nothing while connected (Tynn #941).
        relay: relayWorkstationOf(url) !== null,
        openedBy: exists ? remoteWindowAccount.get(open) ?? null : null,
        account,
    });
    if (exists && action === 'replace') {
        remoteWindows.delete(url);
        open.destroy();
    }
    if (exists && (action === 'focus' || action === 'reconnect')) {
        // Asked for by the person: the rail's Open, or a Tynn share link they clicked.
        bringUp(open, { activation: 'user-gesture', reason: 'remote window', ledger: activationLedger, label: 'remote' });
        if (action === 'reconnect') open.webContents.send('genie:remote-reconnect');
        return;
    }
    const win = createWindow(true, search);
    remoteWindows.set(url, win);
    remoteWindowAccount.set(win, account);
    win.on('closed', () => { if (remoteWindows.get(url) === win) remoteWindows.delete(url); remoteWindowAccount.delete(win); });
}
/** The Tynn account changed: a relay window opened under another account holds that account's grant, and goes. */
function closeRelayWindowsOfOtherAccounts(): void {
    const account = tynnAccountKeyNow();
    const windows = [...remoteWindows].filter(([, w]) => !w.isDestroyed()).map(([key, w]) => ({ key, relay: relayWorkstationOf(key) !== null, openedBy: remoteWindowAccount.get(w) ?? null }));
    for (const key of windowsLeftByAccountChange(windows, account)) {
        const win = remoteWindows.get(key);
        remoteWindows.delete(key);
        if (win && !win.isDestroyed()) win.destroy();
    }
}

/**
 * Every request to put a window in front, and the focus diagnostic that reads it (genie#1235): main's
 * `browser-window-focus` logs which window took the keyboard and what asked for it.
 */
const activationLedger = new ActivationLedger();

/**
 * Bring the main window back FOR THE PERSON: the tray, a menu, a Genie notification they clicked, a second launch they
 * made, the sign-in they finished in the browser. A hidden window needs `show()` — `focus()` alone does nothing to a
 * window that is not on screen. ONLY a gesture of theirs may call this (genie#1235); an agent or a job calls
 * `attractMainWindow`. `reason` names the gesture in the focus log.
 */
function revealMainWindow(reason: string): void {
    leftRunning.set(false);
    // Tray-only (P1b, "Just close the UI"): the person asked for Genie — the window is built again, the same host.
    if (!window || window.isDestroyed()) { mountMainWindow(true, reason); return; }
    bringUp(window, { activation: 'user-gesture', reason, ledger: activationLedger, label: 'main' });
}

/**
 * The main window, wanted by an agent or a job (an `openFileForUser`): never shown, restored or focused — its taskbar
 * button flashes when the person is elsewhere, and what it wanted is waiting when they come (genie#1235).
 */
function attractMainWindow(reason: string): void {
    // No window (tray-only): an agent or a job never builds one — what it wanted waits for the person to open Genie.
    if (!window || window.isDestroyed()) return;
    bringUp(window, { activation: 'background', reason, ledger: activationLedger, label: 'main' });
}

/*
 * TYNN SIGN-IN COMING BACK (the owner, 2026-10-19: the way Genie 1 did it). Genie registers genie:// with the OS; the
 * browser's genie://oauth/callback?token=… arrives as a second launch's argv (Windows, Linux), as `open-url` (macOS), or
 * as THIS launch's argv when Genie was not running. A URL that arrives before the account is open waits for it.
 */
/** The Tynn and GitHub accounts, the keyring card and this machine's registration are genie-host's (Tynn #959, 2g-3b): main holds none. */
/** Late-bound: main's boot has reached its own client's watches; genie:// links wait for it (they reach genie-host's account). */
let ownProtocolTunnelled = false;
/** What Tynn says this machine is (genie#1278 W5) is genie-host's, in its summary (hostSummaryNow, Tynn #954): a drone until said. */
/** A secret's move, said where it can be read afterwards: names and states, never a value. */
const keychainLog = (line: string): void => { console.error(`[keychain] ${line}`); try { openLifecycleLog(runtimeDir(genieRoot()))(`keychain ${line}`); } catch { /* the console has it */ } };
/** agents.json is read here for its seals only: no key is asked of a keychain from this process. */
const NO_KEYCHAIN_HERE: AgentSecrets = {
    probe: async () => ({ ok: false, reason: 'this window keeps no keychain' }),
    get: async () => ({ kind: 'unavailable', reason: 'this window keeps no keychain' }),
    set: async () => ({ ok: false, reason: 'this window keeps no keychain' }),
};
/**
 * WHAT AN OLDER GENIE SEALED (Tynn #959, 2g-3b; legacy-unsealer.ts): the agents' keys in agents.json, the Tynn pairing,
 * GitHub's tokens and this machine's workstation key, and Genie 1's record of this machine. Only this process has
 * Electron's safeStorage (os-cipher.ts: no keyring, no secret; basic_text is never a keyring), so it opens them once and
 * hands them to genie-host, which keeps them in its own keychain. Per the owner's split ruling ("Electron pieces live in
 * the launcher"), this moves to the launcher in split step 6.
 */
const unsealer: LegacyUnsealer = legacyUnsealer({
    sources: () => {
        const cipher = osCipher(safeStorage, process.platform);
        const tynnFile = join(genieRoot(), 'credentials', 'tynn.json');
        const tynnLegacyFile = join(genieRoot(), 'tynn.json');
        return gatherSources([
            { file: 'agents.json', covers: 'tynn/agent/', sources: () => tynnAgentIdentities({ file: join(genieRoot(), 'agent-credentials', 'agents.json'), secrets: NO_KEYCHAIN_HERE }).legacyKeys(cipher) },
            { file: 'tynn.json', covers: 'tynn/pairing', sources: async () => {
                await settleStaleLegacyPairing({ file: tynnFile, legacyFile: tynnLegacyFile, log: (line) => keychainLog(line) }).catch(() => {});
                return [tynnPairingSource({ file: tynnFile, legacyFile: tynnLegacyFile, cipher, log: (line) => keychainLog(line) })];
            } },
            { file: 'github.json', covers: 'github/', sources: () => githubSealedSources({ file: join(genieRoot(), 'github.json'), cipher, v1Settings: () => readV1Settings(v1DatabaseFile()) }) },
            { file: 'workstation.json', covers: 'workstation/', sources: () => workstationSealedSources({ file: join(genieRoot(), 'workstation.json'), cipher }) },
        ]);
    },
    // GENIE 1'S RECORD OF THIS MACHINE (genie#1278 adopt on sign-in): its genie.db in the userData both share, its key
    // decrypted with this Genie's safeStorage (same userData, same OS key). genie-host registers with it once.
    genie1Identity: async () => readGenie1Identity(readV1Settings(v1DatabaseFile()), osCipher(safeStorage, process.platform)),
    call: (method, args) => ownProtocol.call(method, args),
    // Its lines already say [keychain]; the log says it once.
    log: (line) => keychainLog(line.startsWith('[keychain] ') ? line.slice('[keychain] '.length) : line),
});
let pendingGenieUrl: string | null = genieUrlIn(process.argv);

function registerGenieProtocol(): void {
    // The entry path must be absolute for a dev launch (`electron .`), or the OS resolves it against its own cwd.
    if (process.defaultApp) {
        if (process.argv.length >= 2 && process.argv[1]) app.setAsDefaultProtocolClient('genie', process.execPath, [resolvePath(process.argv[1])]);
    } else {
        app.setAsDefaultProtocolClient('genie');
    }
}

function openGenieUrl(url: string): void {
    if (!ownProtocolTunnelled) { pendingGenieUrl = url; return; }
    // A Tynn share link, opened (Tynn #839): Tynn's page opens genie://workstation/open?id=… — its window, over the relay.
    const workstation = workstationOpenFrom(url);
    if (workstation) { openRemoteWindow(`relay:${workstation.id}`, workstation.name); return; }
    const code = signInCodeFrom(url);
    if (code === null) { console.log('[genie] a genie:// URL Genie does not handle was ignored'); return; }
    revealMainWindow('genie:// sign-in link');
    // The code goes to genie-host's Tynn account, the way Settings' code box sends it (feature-machine.ts integrations.tynnCode).
    void ownProtocol.call('features.act', [{ kind: 'integrations.tynnCode', code }]).then((answer) => {
        const why = callRefusal(answer) ?? (answer.ok ? tynnMessageOf(answer.value) : null);
        if (why) console.warn(`[tynn] ${why}`);
    });
}
/** What genie-host's Tynn account said about a sign-in it did not complete (Settings shows the same words). */
const tynnMessageOf = (data: unknown): string | null => {
    const message = (data as { integrations?: { tynn?: { message?: unknown } } | null } | null)?.integrations?.tynn?.message;
    return typeof message === 'string' && message !== '' ? message : null;
};

/** The OS side of "launch at sign-in" (main/tray-residence.ts holds the decisions). */
const loginItemPort: LoginItemPort = {
    setLoginItemSettings: (s) => app.setLoginItemSettings({ openAtLogin: s.openAtLogin, ...(s.path !== undefined ? { path: s.path } : {}), ...(s.args !== undefined ? { args: [...s.args] } : {}) }),
    getLoginItemSettings: (o) => app.getLoginItemSettings({ ...(o.path !== undefined ? { path: o.path } : {}), ...(o.args !== undefined ? { args: [...o.args] } : {}) }),
    exists: (file) => existsSync(file),
    writeFile: (file, content) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content, 'utf8'); },
    removeFile: (file) => unlinkSync(file),
};

/** Where an agent runs: its workspace's path. The OS agent runs in the user's data directory. */
function cwdFor(record: AgentRecord): string {
    // The OSA belongs to the workstation: it runs in its own home, written at boot from its baked-in instructions.
    if (record.workspaceId === OS_WORKSPACE) return osaHomeDir(genieRoot());
    const workspace = registry?.snapshot().workspaces?.find((w) => w.id === record.workspaceId);
    return workspace?.path ?? app.getPath('userData');
}

let services: WindowServices | null = null;
// What the boot probe of genie-host's MCP server said (§6.4 "native transport verified at boot").
let mcpVerified: Verification | null = null;
/** Genie's MCP endpoint: genie-host serves it (P3.1). */
let hostMcpEndpoint: { url: string; token: string } | null = null;
const mcpEndpointNow = (): { url: string; token: string } | null => hostMcpEndpoint;
/** Tell genie-host what its MCP server needs of this window (P3.1), coalesced; a no-op until the tools are built. */
/** A window tool's call, forwarded by genie-host's MCP server; refused until the tools are built. */
let windowToolRun: ((call: ForwardedToolCall) => Promise<McpToolResult>) | null = null;
/** openFileForUser calls that arrived before the tools were built: shown as soon as they are. */
const openFilesLater: ForwardedToolCall[] = [];
/** The two variables every terminal gets once the server listens; GENIE_TERMINAL_ID is minted by the pty port itself. */
/** Every tool Genie's MCP serves (name and description), set once the registrations exist. */
let mcpToolList: readonly { name: string; description: string }[] = [];
/** The agents' MCP caller keys (one per agent, for the run). */
const sessionCallers = new CallerBook();
/** An agent session calling Genie's MCP, by its caller key: the agent and its workspace, now. */
function sessionCaller(key: string): Caller | null {
    return registry ? sessionCallerOf(sessionCallers, key, registry, osaHomeDir(genieRoot())) : null;
}
let browserPane: BrowserPane | null = null;
/** Installed apps' windows (Tynn #595): this process opens them, on sessions the host mints. */
let gappWindowsNow: ReturnType<typeof gappWindowsElectron> | null = null;
/**
 * THE GENIE BROWSER IS ITS OWN PROCESS (the host split, P2b), asked through the host, which starts it. This window builds no
 * browser window, for this machine's sites or another workstation's (Tynn #585). The site panels are webviews here by design.
 */
function askBrowser(args: readonly unknown[]): Promise<{ ok: true } | { ok: false; error: string }> {
    if (agentEngineLink?.live !== true) return Promise.resolve({ ok: false as const, error: 'Genie’s host is not connected' });
    return agentEngineLink.client.browserCall('open', args).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
}
/** `anchor`: the Genie window that asked, which the browser window opens over (Tynn #739). */
const openLocalBrowser = (url: string | undefined, activation: Activation, anchor: { x: number; y: number; width: number; height: number } | null = null) => askBrowser(anchor ? [url ?? null, activation, null, anchor] : [url ?? null, activation]);
/** The Genie browser process's pages, for the `pages` tool. */
const browserPages = new BrowserPagesReplica((pageId, method, args) => agentEngineLink?.client.browserCall('pageCall', [pageId, method, args]) ?? Promise.reject(new Error('no host')));
/** This window's side of each workspace's cookie sync. Set once the services are composed. */
let cookieBridge: BrowserCookieBridge | null = null;
/** This window's connection to the host, as the browser service calls it. */
let browserConnection: string | null = null;
/** Whether the Genie browser's own process is linked to the host. */
let browserLinked = false;
/** What a browser needs, said whenever it changes and whenever the link comes back. Set once the services are composed. */
let publishBrowserFacts: () => void = () => {};

/**
 * Where "latest" comes from, per tool (toolchain-prober.ts `latestIndex`): every command it runs goes through the same
 * platform routing as the probe and the update, so on Windows `npm outdated -g` reaches npm.cmd through cmd.exe.
 */
/** Genie 2's own toolchain data: the CA bundle and its ini, the remembered PATH order (toolchain-ops.ts). */
const toolchainDataDir = (): string => join(genieRoot(), 'genie2-toolchain');
/** T4: where Genie's managed PHP versions live, and how a site's pin finds one (read at each start — no cache). */
const phpVersionsBase = (): Pick<PhpVersionsPorts, 'platform' | 'root' | 'fs' | 'ca'> => ({ platform: process.platform as PhpVersionsPorts['platform'], root: phpVersionsRoot(toolchainDataDir()), fs: nodePhpVersionsFs(), ca: phpCa });
/**
 * The CA bundle every managed php.ini names (genie#1334, toolchain-ops.ts): Windows' exported roots under Genie's
 * toolchain directory, Linux's system bundle. The export is Genie 1's read-only one, two minutes at most (its timeout).
 */
const phpCaPorts = () => ({ platform: process.platform as Platform, fs: nodeToolchainFs(), dataDir: toolchainDataDir(), run: ((binary, args) => execFileRunner(binary, args, { timeoutMs: 120_000 })) as CommandRunner });
const phpCa: PhpCaPort = { current: () => phpCaBundleNow(phpCaPorts()), ensure: () => ensurePhpCaBundle(phpCaPorts()) };
/**
 * What a site start reads (genie#1043 part B): the managed versions, and Genie's toolchain PHP — PATH as the workers get
 * it, Genie's toolchain roots (Genie 1's, under the shared userData; Genie 2's own), and the opcache file cache's home.
 */
const phpCgiBase = (): PhpCgiPorts => ({
    ...phpVersionsBase(),
    toolchainPhp: { path: process.env['PATH'] ?? '', genieRoots: [join(app.getPath('userData'), 'toolchain'), toolchainDataDir()], cacheDir: join(toolchainDataDir(), 'php-opcache') },
});
let featureEffectNow: ((connectionId: string, method: string, args: unknown[]) => Promise<unknown>) | null = null;
/**
 * WINDOW-LOCAL CLIENT OPERATIONS genie-host asks of this window (Tynn #898 step 2d-4b; window-tunnel.ts): Delete moves a
 * file to the OS trash (Tynn #844), and an app's window opens here (Tynn #595). The path is checked against this
 * machine's workspaces again, whoever asked.
 */
const windowOps = windowOpsHandler({
    trash: (absolutePath) => shell.trashItem(absolutePath),
    // Open with / Show in file manager on THIS machine's screen, for a client on another machine (Tynn #912, 2f-1).
    openPath: (absolutePath) => shell.openPath(absolutePath),
    reveal: (absolutePath) => { shell.showItemInFolder(absolutePath); },
    workspaces: () => registry?.snapshot().workspaces ?? [],
    openApp: async (packageId, preview) => {
        if (!gappWindowsNow) throw new Error('Genie is still starting; try again in a moment.');
        await gappWindowsNow.open(packageId, preview ? { preview: true } : undefined);
    },
    // A Take Over terminal genie-host started for this window (Tynn #896): its window, here, for as long as it is open.
    openTerminalWindow: (route) => openTakeOverWindow(route, 'user-gesture'),
});
/** The ForceTheQuestion window's controller (question-window.ts); set once the services are composed. */
let questionWindow: QuestionWindow | null = null;
/** Who else wants the feature snapshot on change: the remote host's event stream. */


async function boot(): Promise<void> {
    // genie:// — Tynn's sign-in hands its code back through it (openGenieUrl above).
    registerGenieProtocol();
    // The store this launch actually got, written down for the next (a probe can come back empty — genie#588).
    // Only a store that gave a key is remembered; the remembered store failing to give one is forgotten (a selected store
    // is not a working one: password-store-memo.ts).
    // A LOCKED KEYRING, ASKED FIRST (Tynn story #388): Electron reads its store's availability once, so the keyring is asked to
    // unlock — its own dialog — before anything here reads it. An unlocked one answers at once; no Secret Service, at once too.
    if (process.platform === 'linux') await unlockKeyringBeforeStores((line) => console.log(`[genie] ${line}`));
    if (process.platform === 'linux') rememberPasswordStore(genieRoot(), safeStorage.getSelectedStorageBackend(), safeStorage.isEncryptionAvailable());
    // BEFORE anything is spawned (the pty host, sessions, sites): the PATH order and PHP's CA ini a Check and repair
    // chose, so everything Genie starts inherits them. Two file reads; nothing runs (toolchain-ops.ts).
    restoreToolchainEnv({ platform: process.platform as Platform, env: processEnv, fs: nodeToolchainFs(), dataDir: toolchainDataDir() });
    // Each language's chosen default goes first for everything Genie starts (main/toolchain-defaults.ts, plan TC3a).
    restoreDefaultsEnv({ platform: process.platform as Platform, toolchainDir: toolchainDataDir(), fs: nodeLinkFs(process.platform as Platform), env: processEnv });
    // BEFORE any PHP starts (genie#1334): Genie's managed PHP has a CA bundle, and every managed version's php.ini names
    // it — the one `current/php` points at too, which no site start rewrites. A file read when the bundle is there; the
    // one-time read-only root-store export (Windows) when it is not. Never fatal: without a bundle PHP starts as before.
    try {
        await phpCa.ensure();
        refreshAllManagedInis(phpVersionsBase());
    } catch (error) {
        console.error('[genie] could not give managed PHP a CA bundle', error);
    }
    // Genie's data root is ~/.genie on every version (paths.ts); `userData` stays Chromium's.
    const store = new Store(genieRoot());
    // Doctor mode reads this: that normal Genie is running, and which agents it has started (none yet) — doctor starts
    // an agent beside it only in an awake workspace where none of those is running (core/genie-running.ts).
    markGenieRunning(genieRoot(), []);
    // A local binding as well as the module-level one, so the callback below closes over a
    // Registry rather than a `Registry | null` that TypeScript cannot narrow inside a closure.
    const theRegistry = new Registry(store);
    registry = theRegistry;
    theRegistry.setWorkspaceNamer(workspaceNameFor);
    // WORKSPACE COLOURS (genie#1300): every workspace has one — its project.json's `appearance.color`, or a palette colour
    // Genie writes there (main/workspace-color-host.ts). A pass runs when the estate changes: at once for a workspace
    // without a colour (one just added), and at most every 5 s otherwise, so an agent's edit of the colour is picked up.
    const colors = new WorkspaceColors({ fs: nodeEnvelopeFs(), mayReadFolder: (path) => theRegistry.workspaceStates().find((w) => w.path === path)?.asleep !== true, onChanged: () => theRegistry.touch(), log: (line) => console.log(`[genie] ${line}`) });
    workspaceColors = colors;
    theRegistry.setWorkspaceColorer((path) => colors.colorOf(path));
    // The colour passes (main/workspace-color-host.ts `followWorkspaceColors`, shared with genie-host, Tynn #956): the rail's
    // order, so the colours beside each other differ; this window is the one that WRITES them.
    followWorkspaceColors(theRegistry, colors, {
        log: (line) => console.warn(`[genie] ${line}`),
        // AGENT CONFIG INTO project.json (Tynn #694): the first time this Genie reads a workspace, any AGENT.md front
        // matter is moved into its project.json `agents` and stripped from the file. After the colour pass, so the
        // two never write one project.json at once; once per folder per run (a later move is a no-op anyway).
        after: (current) => moveAgentConfigs(current.filter((w) => theRegistry.workspaceStates().find((s) => s.path === w.path)?.asleep !== true)),
    });
    // THE PLAN KEEPALIVE runs in genie-host now (main/host-plan-keepalive.ts, Tynn #754): it reads the sessions there.
    /*
     * THE SPAWN LEDGER AND THE LIFECYCLE LOG (hosting plan 1.5 / 1.6). Every agent run's processes are written down as
     * they start and forgotten when a stop VERIFIES they ended; whatever a previous Genie left running — a crash, a
     * Task-Manager kill, an installer — is ended here, BEFORE anything is started or restored, from that record only
     * (pid, start time and name must all match). Every spawn, end, refusal and sweep is a line in lifecycle.log.
     */
    const lifecycleLog = openLifecycleLog(runtimeDir(genieRoot()));
    setProviderChoiceFile(join(runtimeDir(genieRoot()), 'provider-programs.json'));
    rendererErrorLog = lifecycleLog;
    setPrivateCredentialFailureLog(lifecycleLog);
    lifecycleLog(`boot pid=${process.pid} version=${app.getVersion()}`);
    stallLog = lifecycleLog;
    if (stallStacksWanted(process.env)) stallProfiler = startStallProfiler(new InspectorSession(), lifecycleLog);
    stallWatchdog.start();
    watchOutboundCalls(diagnosticsChannel, stallWatchdog);
    ipcMain.on('genie:renderer-stall', (event, report: unknown) => stallWatchdog.renderer(report, windowNameOf(event.sender)));
    app.on('child-process-gone', (_event, details) => stallWatchdog.processGone(details));
    app.on('render-process-gone', (_event, contents, details) => stallWatchdog.processGone({ type: `renderer:${windowNameOf(contents)}`, reason: details.reason, exitCode: details.exitCode }));
    for (const w of BrowserWindow.getAllWindows()) watchWindowHang(w);
    app.on('browser-window-created', (_event, w) => watchWindowHang(w));
    /*
     * WHAT THE AGENT ENGINE TELLS AND ASKS ITS OWNER — the same callbacks wherever the engine runs: in `genie-host` (the
     * host split, phase 1 — main/genie-host.ts, the default) or, as the fallback, in this process.
     */
    const engineCallbacks = {
        // Each turn's number is kept on the agent's record as the turn starts, so its next session numbers on at once.
        onTurnNumbered: (agentId: AgentId, n: number) => { void registry?.setLastTurn(agentId, n); },
        // Each plan is kept on the agent's record as it arrives, so its next run (after a relaunch too) shows it at once.
        onPlan: (agentId: AgentId, steps: readonly { content: string; status: string }[]) => { void registry?.setPlan(agentId, steps); },
        // What an agent did (Tynn #766 C): pushed to every window, which plays the sound chosen for it.
        onAction: (agentId: AgentId, kind: string) => { broadcast('genie:action', { agentId, kind }); },
        // THE DASHBOARD HEADER'S RATE LIMITS: a reading inside its provider's buffer (the host setting) is ignored here, in
        // main — one comparison, nothing pushed; one that clears it is pushed once, to every window.
        onHeadroom: (provider: string, room: Headroom, stamp?: ReadingStamp) => headroomFeed.offer(provider, room, stamp),
        // Each agent starts with its workspace's managed-service variables, by allow-list (the owner, 2026-10-16).
        /**
         * THE LINE THAT MAKES RESUME REAL.
         *
         * The session layer resumed whatever `resumeSessionId` it was handed, the registry can
         * store a thread id, and nothing connected the two — so every restart began a fresh
         * conversation while every test about resume passed. §0.4's shape again: a finished
         * capability behind a missing connection.
         *
         * A rejected write is reported rather than thrown: the agent is mid-turn and working,
         * and taking its session down over a failed disk write would cost the user the thing
         * the write was meant to protect. What it costs instead is resume, which is why it is
         * said out loud here.
         */
        // AN ELEVATION GENIE-HOST'S HOSTING NEEDS (P5a): the hosts file, the trust store — raised HERE, the way this window always
        // raised them; the host never prompts on its own.
        onFeatureEffect: (connectionId: string, method: string, args: unknown[]) => featureEffectNow ? featureEffectNow(connectionId, method, args) : Promise.reject(new Error('this caller’s window is still starting')),
        // WHAT ONLY THIS WINDOW CAN DO FOR GENIE-HOST (Tynn #898 step 2d-4b): Electron's trash, an app's window.
        onWindowOp: (op: string, args: unknown[]) => windowOps(op, args),
        elevate: (steps: readonly PrivilegedStep[]) => runElevatedBatch(process.platform, steps, (plan) => execFileRunner(plan.command, plan.args, { timeoutMs: 300_000 })),
        // Which php-cgi a site's pin runs, for the hosting replica's synchronous check: the same toolchain as the host's.
        phpCgiFor: (pin: string | undefined) => resolvePhpCgi(pin, phpCgiBase()),
        onToolCall: (call: ForwardedToolCall) => (windowToolRun ? windowToolRun(call) : Promise.resolve({ text: `${call.name}: Genie's window is still starting; call it again in a moment. Nothing was done.`, isError: true })),
        // openFileForUser made while no window was here: shown now (once the tools are built).
        onOpenFileLater: (call: ForwardedToolCall) => { if (windowToolRun) void windowToolRun(call); else openFilesLater.push(call); },
        // A tool's moment, from the host's own tools: the glow, the thumbs-up, the action on the agent's row.
        onToolSignal: (raw: unknown) => {
            const signal = raw as { kind?: string; terminalId?: string; agentId?: string; action?: string; tool?: string; reason?: string; workspaceId?: string; agentName?: string; sound?: string; title?: string; body?: string };
            // A terminal an agent started needs the person (Tynn #722): a Show terminal notice in the window they are using — the
            // focused one, else the main window — and never a navigation (core/view-requests.ts).
            if (signal.kind === 'terminal-needs-you' && typeof signal.workspaceId === 'string' && typeof signal.terminalId === 'string') {
                const target = BrowserWindow.getFocusedWindow() ?? window;
                if (target && !target.isDestroyed()) target.webContents.send('genie:action', { agentId: null, kind: TERMINAL_NEEDS_YOU, workspaceId: signal.workspaceId, terminalId: signal.terminalId, agentName: signal.agentName ?? 'An agent' });
            } else if (signal.kind === 'limit-alert' && typeof signal.title === 'string' && typeof signal.body === 'string') broadcast('genie:action', { agentId: null, kind: 'limit-alert', sound: typeof signal.sound === 'string' ? signal.sound : 'synth', title: signal.title, body: signal.body });
            // How an account switch came out (Tynn #482): every window shows it, with Retry when nothing changed.
            else if (signal.kind === 'account-switch') broadcast('genie:action', { agentId: null, kind: 'account-switch', outcome: (raw as { outcome?: unknown }).outcome });
            // Something about the accounts changed in the host (Claude Design's authorization, Tynn #480): windows read them again.
            else if (signal.kind === 'accounts-changed') broadcast('genie:action', { agentId: null, kind: 'accounts-changed' });
            else if (signal.kind === 'glow' && typeof signal.terminalId === 'string') broadcast('genie:glow', signal.terminalId);
            // Mail between agents (genie#1209, Tynn #766 C2a; Tynn #998): genie-host keeps the inbox and says each; only what reads goes on.
            else if (signal.kind === 'mail') { const mail = readMailSignal((raw as { mail?: unknown }).mail); if (mail) broadcast('genie:action', mail); }
            // What genie-host runs, each change with its sound (Tynn #766 C2b; genie-host says them since Tynn #1045): only what reads goes on.
            else if (signal.kind === 'thing') { const thing = readThingSignal((raw as { thing?: unknown }).thing); if (thing) broadcast('genie:action', thing); }
            else if (signal.kind === 'action' && typeof signal.agentId === 'string') broadcast('genie:action', { agentId: signal.agentId, kind: signal.action, ...(signal.tool ? { tool: signal.tool } : {}), ...(signal.reason ? { reason: signal.reason } : {}) });
        },
        onThreadId: (agentId: AgentId, threadId: string) => {
            void theRegistry.recordThread(agentId, threadId).then((result) => {
                if (!result.ok) console.error(`[genie] could not record the thread id: ${result.reason}`);
            });
        },
        // A provider switch's carry-over went (Tynn story #380): the next prompt does not carry it again.
        onCarryOverSent: (agentId: AgentId) => { void theRegistry.clearCarryOver(agentId); },
        onRedockSent: (agentId: AgentId, at: string) => { void theRegistry.clearRedock(agentId, at).catch(() => lifecycleLog(`redock reorientation acknowledgement could not be saved for ${agentId}; it remains pending on disk`)); },
        // Genie's own words went into the agent's thread (genie#1519): its record says so, for the next launch.
        markGenieWords: (agentId: AgentId) => { void theRegistry.markGenieWords(agentId); },
    };
    /*
     * THE AGENT ENGINE IN ITS OWN PROCESS (the host split, phase 1; the owner, 2026-10-31: "the actions agents take should
     * not be routed through my UI … All work should be handled on the host side"). Every session — its provider, its ACP
     * parsing, its ledger, its thread writes, its containment — runs in `genie-host`; this process keeps a replica it reads
     * synchronously and sends commands to. A window that freezes, crashes or restarts no longer stops an agent, and an
     * agent's work no longer runs on the thread that routes the person's keystrokes. There is no in-process mode (the owner,
     * 2026-11-01: "we split host from UI for good").
     */
    {
        // P6: the host runs from a copy under Genie's home, so an update doesn't have to end it. Only the first run of a new
        // Electron copies the runtime; every failure answers the install, with the reason.
        const hostBuildNow = hostBuild(app.getVersion(), join(here, 'host.js'));
        const hostCopyInput = { packaged: app.isPackaged, platform: process.platform, execPath: process.execPath, electronVersion: process.versions.electron ?? 'unknown', appRoot: app.getAppPath(), unpackedRoot: `${app.getAppPath()}.unpacked`, hostHash: hostHashOf(hostBuildNow) ?? hostBuildNow.replace(/[^A-Za-z0-9._-]/g, '_'), genieHome: genieRoot(), log: lifecycleLog };
        const hostRuntime = await materializeHostRuntime(hostCopyInput);
        // Its own Deck item (Tynn #693): the error alone is the item's folded detail; the words are core/main-errors.ts's.
        if (hostRuntime.error !== null) mainErrors.record('host-copy', new Error(hostRuntime.cause ?? hostRuntime.error));
        remakeHostCopy = () => materializeHostRuntime(hostCopyInput).then((made) => (made.error === null ? null : made.cause ?? made.error));
        // STARTING GENIE'S HOST, SAID (Tynn #700): a slow first start shows a window of its own that says so, until the link
        // is up; from 60 s it also offers Open the log and Restart Genie's host (host-wait-window.ts).
        let hostWaitWindow: BrowserWindow | null = null;
        const hostRestart = new HostRestart();
        const hostWait = new HostWait({
            open: () => {
                const win = new BrowserWindow({
                    ...genieWindowIcon(here),
                    width: 460, height: 190, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, title: 'Genie', backgroundColor: '#111111', autoHideMenuBar: true,
                    webPreferences: { preload: join(here, 'host-wait-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
                });
                guardWindowLinks(win.webContents, (url) => { void shell.openExternal(url).catch(() => {}); });
                hostWaitWindow = win;
                void loadWindowPage(win.webContents, 'host-wait').catch((error: unknown) => console.error(`[window-pages] ${String(error)}`));
            },
            update: (view) => { if (hostWaitWindow && !hostWaitWindow.isDestroyed()) hostWaitWindow.webContents.send('host-wait:show', view); },
            close: () => { if (hostWaitWindow && !hostWaitWindow.isDestroyed()) hostWaitWindow.destroy(); hostWaitWindow = null; },
        }, {
            openLog: () => shell.openPath(join(genieRoot(), 'logs', 'genie-host.log')).then((failed) => failed || null),
            restart: () => hostRestart.request(),
        });
        ipcMain.handle('host-wait:current', () => hostWait.current());
        ipcMain.handle('host-wait:act', (_event, action: unknown) => (action === 'open-log' || action === 'restart' ? hostWait.act(action) : undefined));
        agentEngineLink = await connectAgentEngine({
            // WHAT THE OS SAYS ABOUT PROXIES, handed to the host each time this window links to it (host-https-fetch.ts).
            onLinked: (client) => {
                handProxyAnswers = () => reportProxies(client, lifecycleLog);
                void handProxyAnswers();
                publishBrowserFacts();
                // How the host starts its updater helper (P5b): this executable, in a dev run this app's path, and the switches this
                // window was started with that an Electron needs to start at all here (the sandbox, the display, the password store).
                // This window says it is one (Tynn #898): genie-host's install, whoever asks it, spares it and waits for it to go.
                void client.updates().announce().catch(() => {});
                void client.updates().publishLaunch({ file: process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--updater', ...windowLaunchFlags(process.argv)] }).catch(() => {});
                void client.browserCall('whoami', []).then((id) => { browserConnection = String(id); }, () => {});
                cookieBridge?.relinked();
                client.onBrowserEvent((event) => {
                    if (event.kind === 'pages') browserPages.apply(event.pages);
                    if (event.kind === 'browserUp') browserLinked = event.up;
                    if (event.kind === 'cookies' || event.kind === 'cookiesWanted') cookieBridge?.onEvent(event);
                    if (event.kind === 'poppedBack' && window && !window.isDestroyed()) window.webContents.send('site-panel:popped-back', event.panelKey);
                });
                void client.browserCall('browserUp', []).then((up) => { browserLinked = up === true; }, () => {});
                void client.browserCall('pagesNow', []).then((pages) => { browserPages.apply(pages as BrowserPage[]); }, () => {});
            },
            callbacks: engineCallbacks,
            launch: {
                runtimeDir: runtimeDir(genieRoot()),
                logsDir: join(genieRoot(), 'logs'),
                // The host's build: this version, and the host bundle's own bytes — a rebuilt host is a new host.
                build: hostBuildNow,
                hostScript: hostRuntime.hostScript,
                execPath: hostRuntime.execPath,
                genieHome: genieRoot(),
                // What only Electron knows, for the host's hosting (hosting-inputs.ts): Genie 1's folder (its database, CA and
                // toolchain), the app data folder, and the resources folder with the bundled Caddy.
                env: { ...process.env, GENIE_V1_USERDATA: app.getPath('userData'), GENIE_APPDATA: app.getPath('appData'), GENIE_RESOURCES: process.resourcesPath, GENIE_INSTALL_EXEC: process.execPath },
                log: lifecycleLog,
                onWaiting: (elapsedMs) => hostWait.progress(elapsedMs),
                restart: hostRestart,
            },
            onError: (kind, error) => mainErrors.record(kind, error),
            agentName: (id) => registry?.find(id)?.name ?? id,
            log: lifecycleLog,
        });
        hostWait.done();
        ipcMain.removeHandler('host-wait:current');
        ipcMain.removeHandler('host-wait:act');
        // THE WINDOW NEVER RUNS HOST WORK (Tynn #415): with no host it says what is wrong and how to fix it, and stops here.
        if (agentEngineLink === null) {
            await stopForNoHost(hostRuntime.error);
            return;
        }
        host = agentEngineLink.client;
        // THE HEARTBEAT (Tynn #386): every second, its pid and RSS, a notification; the client drops it while unlinked.
        heartbeatNow = startHeartbeat({
            send: (beat) => agentEngineLink?.client.heartbeat(beat),
            pid: process.pid,
            rss: () => process.memoryUsage.rss(),
            // The main window's page beside it: genie-host's rss line says what grew (bringBackItsPage samples it).
            rendererRss: () => pageMemory.bytes(),
            // WHICH WINDOW, AND HOW NEAR ITS LIMIT (Tynn issue #711): a lost record names it by its route, and says its heap.
            route: mainRoute,
            heap: () => { const h = getHeapStatistics(); return { used: h.used_heap_size, limit: h.heap_size_limit }; },
        });
    }
    /*
     * EVERY PROCESS THIS WINDOW STARTS IS STARTED BY GENIE-HOST (the host split, P2.1; plan §11a): #1405's spawn host is
     * the HOST's child now (two profiles: processes, terminals), reached over the engine link — so sites, queue workers
     * and open terminals outlive this window, and what a previous window left running is taken back below.
     * BEFORE anything runs a command: every execFileRunner call from here on is created there, never on main.
     */
    {
        const engineLink = agentEngineLink.client;
        // MAIN'S OWN CLIENT, ON THE SAME LINK (Tynn #896, 2b-2b): the tray's calls are admitted by genie-host as this machine's
        // window, labelled Genie's tray. A protocol door on the link, never a listener (core/ipc-inventory.ts).
        // `own`: genie-host admits this door's connections as main's own client, the only caller keychain.adoptLegacy takes.
        // Tunnelled here, before the registry loads (Tynn #1007, 2g-4e): the registry is read and written over it.
        tunnelDoor(ownProtocol.door, tunnelLinkOf(agentEngineLink.client), { own: true });
        // The settings this window reads, from genie-host, as soon as its own client can ask (Tynn #998, 2g-4b1).
        settingsNow.start();
        frontDoorWatch.start();
        // THE REGISTRY'S FILES ARE GENIE-HOST'S (P3.2): this window's model reads and writes them over the one protocol (Tynn
        // #1007, 2g-4e: registry.read, registry.write), and re-reads them when registry.watch says another window (or the host)
        // wrote: two windows, one registry. Before its load and the Genie 1 import, below, which write through genie-host.
        theRegistry.useStore(await openWindowRegistryStore(ownProtocol));
        watchRegistryRefresh(registryChanges(ownProtocol), theRegistry, (error) => console.error('[registry] Background refresh failed; waiting for the next host update.', error));
        // This window reaches the `processes` child (exec and streams). Supervised processes and terminals are the host's
        // own (P3.3b, P3.3e): their state comes by replica, so nothing here is taken back after a loss.
        const processes = new SpawnHostClient({ entry: '', link: engineLink.spawnLink('processes'), log: lifecycleLog });
        engineLink.onSpawnFrame('processes', (frame) => processes.linkFrame(frame));
        const reconcile = (): Promise<unknown> => processes.linkUp();
        engineLink.onLink(
            () => { void reconcile().catch((error: unknown) => lifecycleLog(`spawn host reconcile failed reason=${error instanceof Error ? error.message : String(error)}`)); },
            (why) => { processes.linkDown(why); },
        );
        // The link is already up (it came up in connectAgentEngine): the first reconcile is now, before any command runs.
        // What it lists is genie-host's own to keep (P3.3b, P3.3e): this window adopts no pty (Tynn #1043).
        await reconcile().catch((error: unknown) => { lifecycleLog(`spawn host list failed reason=${error instanceof Error ? error.message : String(error)}`); });
        spawnHostNow = processes;
    }
    routeExecThroughSpawnHost(spawnHostNow);

    // Healthy means this process is up and answering, which is the only claim the local
    // workstation chip can honestly make from in here. A real health model belongs with
    // remote workstations, where there is something to be unreachable.
    await registry.load({ name: hostname(), healthy: true });
    // The agent host reads each agent's record per call (genie#1188) from its own registry (Tynn #954): nothing is pushed.
    // EVERY CHAT'S UNSENT DRAFT (genie#1261) is genie-host's, and so is pruning it when its agent goes (Tynn #997, 2g-4a:
    // host-draft-prune.ts): main prunes nothing.
    // The OSA's home (~/.genie/osa): its baked-in instructions and the diagnostics skill, replaced where they differ.
    await writeOsaHome({
        dir: osaHomeDir(genieRoot()),
        // On an Omarchy host, Omarchy's own agent skills come with it (main/omarchy-skills.ts); elsewhere, nothing about Omarchy.
        files: osaHomeFiles('normal', { version: app.getVersion(), platform: process.platform, installDir: installDir(process.execPath), genieHome: genieRoot(), userData: app.getPath('userData'), omarchy: await omarchyFacts() }),
        fs: {
            read: async (p) => { try { return await readFileText(p, 'utf8'); } catch { return null; } },
            write: async (p, text) => { await mkdir(dirname(p), { recursive: true }); await writeFileText(p, text, 'utf8'); },
        },
    }).catch((error: unknown) => { console.error(`[genie] the OSA's home could not be written: ${(error as Error).message}`); });
    // The boot that imports Genie 1 is the one whose pty host just died — the only boot its orphaned shells are reaped.
    const importBoot = !existsSync(join(genieRoot(), 'v1-import.json'));
    await importFromV1(theRegistry);
    await reapV1Runtime(importBoot);
    registry.setProbe((id) => host?.probe(id) ?? null);

    // THE WORKSPACE'S TERMINAL LIMIT (beta.33), read live from the workspace's settings on this workstation.
    // Interactive terminals run in genie-host's `terminals` child when there is a host (their output is never read here);
    // the open ones a previous window left running are taken back with what they printed.
    // THE TERMINALS ARE GENIE-HOST'S (P3.3e): their shells and scrollback outlive this window; it drives them by replica.
    // SCROLLBACK IS NOT SAVED (the owner, 2026-11-02): what an older Genie left is deleted, and nothing writes it again.
    await removeSavedScrollback(genieRoot(), lifecycleLog);
    // THE FILE PANEL (§4.3): one host; attribution is the agents' own tool events, looked up live.
    filesHost = new FilesHost({
        // Each opened file carries its git state (the persona's `· committed`).
        gitStatus: gitFileStatus,
        gitShowHead,
        gitTree: gitTreeStatus,
        // Delete goes to the OS trash (Tynn #844), never an erase.
        trash: (absolutePath) => shell.trashItem(absolutePath),
        workspace: (id) => registry?.workspace(id) ?? null,
        agentsOf: (workspaceId) => (registry?.agentsOf(workspaceId) ?? []).map((a) => ({ id: a.id, name: a.name })),
        eventsOf: (agentId) => {
            const record = registry?.find(agentId as AgentId);
            if (!record || !host) return [];
            // One event per tool CALL, its rows folded (files-panel.ts): row by row, no Claude edit was ever attributed.
            return fileEventsOf(host.rowsFor(record.id), { id: record.id, name: record.name });
        },
    });
    // WHAT CHANGED ON DISK, AND GIT, are genie-host's to watch and say (host-local-watches.ts): the Files panel hears them
    // over the one protocol, and this window keeps no watch of its own (Tynn #1043).
    // The popped-out panels (§4.3): tracked here, pushed as the whole list.
    // The Files panel's pop-out button: the person's click (genie#1235).
    filesWindows = new FilesWindows({ openWindow: (route) => openFilesWindow(route, 'user-gesture'), closeWindow: closeWindowAt });
    filesWindows.onChange((list) => broadcast('genie:files-windows-changed', list));
    /*
     * TAKE OVER (§1) is genie-host's: it opens the TUI and asks this window for a window on it (Tynn #896). Whether a
     * question's agent is still waiting, its session or its Take Over terminal, is judged by genie-host's own Deck, which
     * the question window and the tray read (deck.watch, Tynn #941 2f-2).
     */

    /*
     * UPDATES (§7), GENIE-HOST'S (the host split, P5b; updates-host.ts). The host holds the state, checks on its schedule —
     * and with no window open downloads what it finds — and runs the install: the agents drained, its hosting stopped, the
     * teardown scan, then its updater helper (Genie's own executable in its `--updater` mode) waits for every Genie process
     * to be gone and runs the installer. This window reads the host's state through a replica and sends the person's check,
     * download, install and channel. When the host answers an install it is on its way out: this window quits, asking
     * nothing, and records nothing over the record the host's drain wrote.
     */
    {
        const replica = agentEngineLink.client.updates();
        replica.onInstalling(() => {
            lifecycleLog('update: the host is installing; this window quits');
            updateQuitReady = true;
            quit.markRecorded();
            quit.choose('shut-down');
            setTimeout(() => { app.quit(); }, QUIT_DELAY_MS);
        });
        // Why the last install did not happen (the host read its record): said on the Deck, in words, with the log's path.
        replica.onFailedInstall((notice) => {
            mainErrors.record('update-failed', new Error(`Genie’s update was not installed: ${notice.reason} The details are in ${notice.log}.`));
        });
        updates = replica;
    }
    updates.onChange(() => { refreshTray(); });
    // Every copy button writes through main (main/clipboard-ipc.ts): in a sandboxed window the page's clipboard can fail silently.
    registerClipboardIpc(ipcMain, electronClipboardPort(clipboard, ClipboardItem));
    // The native window buttons follow the theme (the owner: "not following color theme"): the renderer sends the
    // theme's own bar colours whenever the theme changes; they are applied to the window that sent them.
    const overlayApplied = new Map<number, { color: string; symbolColor: string }>();
    ipcMain.handle('genie:window-overlay-colors', (event, color: unknown, symbolColor: unknown) => {
        if (process.platform === 'darwin' || !overlayColorsOk(color, symbolColor)) return false;
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) return false;
        win.setTitleBarOverlay({ color: color as string, symbolColor: symbolColor as string, height: TITLE_BAR_HEIGHT });
        overlayApplied.set(event.sender.id, { color: color as string, symbolColor: symbolColor as string });
        return true;
    });
    // What the window's buttons were last painted with — read by the real-window smoke and by diagnostics.
    ipcMain.handle('genie:window-overlay-colors-current', (event) => overlayApplied.get(event.sender.id) ?? null);


    /*
     * The terminal handlers. Every argument is `unknown` and narrowed here — the renderer is
     * sandboxed and its values are not trusted. A terminal is opened for a WORKSPACE, which is
     * looked up in the registry: an unknown workspace is refused, and there is no way to name
     * an agent through this surface.
     */
    // GENIE'S SCRATCH (P7): the folders under `<root>/cache/tmp` of Genies that are gone
    // are swept deferred, and the sweep is stopped on quit.
    scratchSweepStop = scheduleScratchSweep(genieRoot(), { log: (line) => console.warn(line) });
    // THE SIGN-INS (Tynn #896) are protocol calls answered by genie-host (host-sign-ins.ts): the provider's own login, opened
    // on the window that asked (windowOps terminal.window), for the host's owner. Genie never handles a credential.

    // THE HEADER'S TERMINAL BUTTON (Tynn story #378) is genie-host's since 2c-4 (#897): terminals.scratch, in this window.
    // RIGHT-CLICK A FILE (Tynn #841): the host OS's own app for it, or its file manager — a path confined to the workspace.
    ipcMain.handle('genie:files-open-external', async (_event, workspaceId: unknown, path: unknown) => {
        const abs = typeof workspaceId === 'string' && typeof path === 'string' ? filesHost?.absolute(workspaceId, path) ?? null : null;
        if (!abs) return { ok: false, reason: 'that file is not in this workspace' };
        const failed = await shell.openPath(abs);
        return failed === '' ? { ok: true } : { ok: false, reason: failed };
    });
    ipcMain.handle('genie:files-reveal', (_event, workspaceId: unknown, path: unknown) => {
        const abs = typeof workspaceId === 'string' && typeof path === 'string' ? filesHost?.absolute(workspaceId, path) ?? null : null;
        if (!abs) return { ok: false, reason: 'that file is not in this workspace' };
        shell.showItemInFolder(abs);
        return { ok: true };
    });
    // EXPORT… (genie#1264): the OS save dialog, parented to the window that asked (a popped-out panel too); main streams the
    // file to the chosen place. Only the workspace and path cross in — the destination comes from the dialog alone.
    const exporter = fileExporter({
        files: { absolute: (workspaceId, path) => filesHost?.absolute(workspaceId, path) ?? null },
        saveDialog: (options, asker) => {
            const parent = asker instanceof BrowserWindow && !asker.isDestroyed() ? asker : window;
            return parent && !parent.isDestroyed() ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
        },
        downloads: () => app.getPath('downloads'),
    });
    ipcMain.handle('genie:files-export', (event, workspaceId: unknown, path: unknown) =>
        typeof workspaceId === 'string' && typeof path === 'string' ? exporter.export(workspaceId, path, BrowserWindow.fromWebContents(event.sender)) : { ok: false, reason: 'bad arguments' });
    // The rail's Browser row (beta.35 item 36): the Genie browser window, a typed address checked by its own rule.
    // WHICH BROWSER is decided by the window that asked (core/browser-connection.ts): this machine's sites, or — for a window
    // driving a Tynn workstation — that workstation's, over that window's own relay channel. Never by what it says.
    // A window driving a Tynn workstation opens THAT workstation's browser over its own session (deviceLink.openBrowser,
    // genie-host's, on the channel it owns; Tynn #941 2f-2). Here only this machine's own windows open this machine's.
    ipcMain.handle('genie:browser-window-open', async (event, address: unknown) => {
        const at = typeof address === 'string' ? address : undefined;
        const remoteUrl = [...remoteWindows].find(([, w]) => !w.isDestroyed() && w.webContents === event.sender)?.[0] ?? null;
        const conn = browserConnectionFor({ remoteUrl, relays: [] });
        if (conn.kind !== 'local') return { ok: false, error: conn.kind === 'refused' ? conn.reason : 'This window opens its workstation’s browser over its own connection.' };
        // The window that asked: the browser opens over it, on its display, never on whichever is primary (Tynn #739).
        const anchor = BrowserWindow.fromWebContents(event.sender)?.getBounds() ?? null;
        return openLocalBrowser(at, 'user-gesture', anchor);
    });
    // THE DASHBOARD'S WINDOWS COLUMN (Tynn #706): a workspace's terminals view in a window of its own; a second ask brings it up.
    ipcMain.handle('genie:terminals-popout', (_event, workspaceId: unknown) => { if (typeof workspaceId === 'string' && workspaceId !== '') openTerminalsWindow(terminalsWindowRoute(workspaceId), 'user-gesture'); });
    ipcMain.handle('genie:files-popout', (_event, workspaceId: unknown) => { if (typeof workspaceId === 'string') filesWindows?.popOut(workspaceId); });
    // A drone never connects out (audit M-b): refused HERE, from the role main read from Tynn, not only hidden in the window.
    // TAKE OVER FROM ANOTHER MACHINE (Tynn #529 part A): this machine's window on that host's terminal; a drone opens none.
    ipcMain.handle('genie:remote-takeover-open', (_event, url: unknown, terminalId: unknown, ticket: unknown, name: unknown, route: unknown) => {
        if (typeof url !== 'string' || typeof terminalId !== 'string' || typeof ticket !== 'string' || ticket === '') return { ok: false, reason: 'not a Take Over window' };
        const refused = outboundDialRefusal(hostSummaryNow.workstationRole, url);
        if (refused) return { ok: false, reason: refused };
        // A sign-in's window shows its steps (Tynn #896): its login route, when it is that same terminal's.
        openRemoteTakeOverWindow(url, terminalId, ticket, typeof name === 'string' ? name : null, typeof route === 'string' && loginTerminalOf(route) === terminalId ? route : null);
        return { ok: true };
    });
    // The Take Over window's ticket, read ONCE: the read deletes it.
    ipcMain.handle('genie:takeover-ticket', (event) => {
        const ticket = takeOverTickets.get(event.sender.id) ?? null;
        takeOverTickets.delete(event.sender.id);
        return ticket;
    });
    ipcMain.handle('genie:remote-open-window', (_event, url: unknown, name: unknown) => { if (typeof url !== 'string') return; const refused = outboundDialRefusal(hostSummaryNow.workstationRole, url); if (refused) return { ok: false, reason: refused }; openRemoteWindow(url, typeof name === 'string' ? name : null); });
    /*
     * The tailnet socket is dialled by the remote window's renderer, which main otherwise never sees: every WebSocket an
     * app window opens (they share the default session; the Genie browser has its own) is cancelled while this machine
     * is a drone. Main's own sockets (the relay, Pusher) are Node's and do not pass through here. A desktop window no longer
     * dials: genie-host does, and refuses a drone first (device-link-protocol.ts); this stays as defence in depth for anything
     * else a window opens.
     */
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: outboundDialRefusal(hostSummaryNow.workstationRole, details.url) !== null }));
    // THE TYNN NETWORK, AS A MEMBER (Tynn #837; Genie 1's workstation:connectable / workstation:open): the workstations
    // Tynn lists, and a connection to one — the grant and its proof key minted and held HERE, never in the window.
    // A PASTED SHARE LINK (genie#1278 C1; Genie 1's connect-dispatch): genie-host decides what it is, against the Tynn it is
    // signed in to and the role Tynn gave this machine (tynnNetwork.classifyLink, Tynn #896 2b-4), never one a window sends;
    // this window opens what it decided, the invite in the browser or the workstation in its own window.
    ipcMain.handle('genie:connect-link', async (_event, text: unknown) => {
        const asked = await ownProtocol.call('tynnNetwork.classifyLink', [String(text ?? '')]);
        if (!asked.ok) return { ok: false, note: asked.reason };
        const decided = connectLinkDecisionOf(asked.value);
        if (decided === null) return { ok: false, note: 'Genie could not read what that link is; try again in a moment.' };
        return actOnConnectLink(decided, {
            openExternal: async (url) => { try { await shell.openExternal(url); return true; } catch { return false; } },
            openWorkstation: (id, name) => openRemoteWindow(`relay:${id}`, name ?? null),
        });
    });
    // ANOTHER MACHINE (P3.4 cut e, audit M-e; Tynn #552): genie-host dials it, refuses a drone, and holds the token and the
    // grant; a window's channel is its own protocol session's since 2f-2 (Tynn #941, device-link-protocol.ts). main holds none.
    ipcMain.handle('genie:files-bringback', (_event, workspaceId: unknown) => { if (typeof workspaceId === 'string') filesWindows?.bringBack(workspaceId); });
    ipcMain.handle('genie:files-windows', () => filesWindows?.list() ?? []);

    // A provider's program (Tynn #577) is genie-host's since 2c-3 (#897): providers.chooseProgram, picked on its disk.

    /*
     * THE FEATURE SERVICES — every store, the Flow scheduler, the supervisor, the site manager and
     * the .gen front door, composed once (compose.ts). The v1 settings carry-over runs here on first
     * run, from v1's own database under the same ~/.genie.
     */
    // THE BACKGROUND PROCESSES THE PERSON KEEPS (§6.6, process-book.ts): opened once the services are composed;
    // until then every snapshot is the supervisor's alone. Late-bound so no closure below can meet it uninitialised.
    // genie-host's when it runs (P3.3c): the book and its scheduler there, this window's replica here.
    // The features' ports: the kept processes, and every workspace's GitHub panel (Tynn #806).
    // The Tynn this Genie uses: Help → Genie documentation opens its docs (Tynn #762).
    const tynnHost = (): string => TYNN_HOST;
    // Every snapshot — pushed or answered — carries the Tynn account (late-bound: it opens once the services are composed).
    // The host's switch (Tynn #820) and, on Windows, its firewall rule (Genie 1's allowFirewall) — Settings → Remote access.
    // TAILSCALE FROM GENIE (Tynn #821; Genie 1's tailscale.status / up + openAuth / install). A sign-in link or a download
    // page opens in the browser (https only); a node that comes online re-applies the remote-access switch.
    let requestFeaturePush = (): void => {};
    // THE HOST'S SOCKET (§6.8): fancy-ws on the Tailscale IPv4 only; with no Tailscale nothing listens and Settings says why.
    /*
     * REMOTE ACCESS IS GENIE-HOST'S (Tynn #409, host split P5d.1): with genie-host linked, IT listens on the tailnet, pairs,
     * and holds the baton and the lock; this window starts no listener, opens no device store, and keeps no replica of it
     * (Tynn #997, 2g-4a): Settings draws it from genie-host's features, and the notifications below read remote.watch.
     */
    // Genie's Caddy RUNS from a per-user copy under ~/.genie, refreshed when the bundled binary's hash changes — never
    // from the install dir, which an NSIS update replaces under a running front door (Genie 1's genie#265).
    const bundledCaddy = caddyBinPath(process.resourcesPath, process.platform);
    const caddyCopy = bundledCaddy === null ? null : await userCaddyCopy(bundledCaddy, join(runtimeDir(genieRoot()), 'caddy-bin'));
    if (caddyCopy?.error) console.error(`[caddy] ${caddyCopy.error}`);
    /*
     * APPS AND SCRIPTS REPORT TO AGENTS (genie#1345; the owner, FTQ q_eb705239): a loopback door a Genie-hosted site, a
     * kept process or a script key posts into an agent's AgentInbox through (main/app-inbox-service.ts). It listens BEFORE
     * composition, so the sites compose starts are handed their own credential at their first start. Its port is
     * remembered (a script outside Genie keeps one address); the keys are app-inbox-keys.ts's.
     */
    // THE APP INBOX's door and keys are genie-host's (P5a.2 ruling 3; Tynn #584): every window reaches them over the protocol.
    // THE STORES AGENTS WRITE TO are genie-host's when it runs (the host split, P3.1): this window composes against its
    // replicas of them.
    // SAFE MODE, genie-host's (Tynn #386).
    windowSafe = WindowSafeMode.open({ link: agentEngineLink.client });
    const engineForStores = agentEngineLink;
    const composeWith = (input: ComposeInput) => composeWindowServices({ ...input, agentStores: engineForStores.client.stores() });
    const composed: WindowServices = await composeWith({
        // A workspace's trust verdict moved (genie#1519): the trust step is pushed. genie-host's TrustVerdicts compare its agents.
        onTrustVerdict: () => { requestFeaturePush(); },
        // AgentInbox's automatic reply to a paused recipient reads the live sessions (genie#1515): the emergency stores only.
        inboxSession: (id) => host?.probe(id) ?? null,
        userData: genieRoot(),
        // No host: this window's own flows, sites and engines start nothing by themselves in safe mode (Tynn #386).
        safeMode: windowSafeNow,
        safeModeLeft: (listener) => { windowSafe?.onChange((view) => { if (!view.active) listener(); }); },
        // Said in the remote welcome (P10.1e): the same build the host's engine welcome says.
        build: hostBuild(app.getVersion(), join(here, 'host.js')),
        // THE PROCESS SUPERVISOR IS GENIE-HOST'S (P3.3b): sites, workers and the front door run — and restart — there, with
        // or without this window; a window restart neither starts them twice nor stops them.
        supervisor: agentEngineLink.client.supervisor(),
        // GENIE'S HOSTING IS GENIE-HOST'S (P5a): the front door, the engines and the site routes are built there and kept with
        // the UI closed; this window reads them (the front door's port and CA arrived before the link was ready) and drives
        // them through the replica.
        hosting: agentEngineLink.client.hosting(),
        // FLOWS ARE GENIE-HOST'S (P3.3d): an armed flow fires on its clock with no window; this window edits, arms and runs
        // them through the replica.
        flowsEngine: { flows: agentEngineLink.client.flows(), scheduler: agentEngineLink.client.flows() },
        // The supervisor's liveness check asks the OS too (P2): a pty the engine still holds for a dead process is a crash.
        pidAlive: osPidAlive,
        v1Settings: () => readV1Settings(v1DatabaseFile()),
        // Genie 1's knowledge graph, from the same database, read-only; the store decides whether it still needs it.
        v1Knowledge: () => readV1Knowledge(v1DatabaseFile()),
        // Genie 1's AgentInbox history and its attachment bytes, read-only; the inbox decides whether it still needs them.
        v1Inbox: () => readV1Inbox(v1DatabaseFile()),
        // Genie 1's service engines, TAKEN OVER in place (same containers, volumes, credentials, ports) and its sandbox/site
        // containers stopped — beside importFromV1/reapV1Runtime in spirit, but here because the engine registry is born in
        // composition and must hold them before sites and kept processes read a workspace's env (main/v1-services.ts).
        v1Services: { database: v1DatabaseFile() },
        // Genie 1's FLOWS (its `flows` table), brought over ONCE as DISARMED canvas flows (main/v1-flows.ts, genie#1204).
        v1Flows: { database: v1DatabaseFile() },
        // Genie's own Caddy — the per-user copy above (caddy-runtime.ts); null in a dev tree without one.
        caddyBin: caddyCopy?.path ?? null,
        // A started site is `starting` until its port answers, then running and routed (parity audit #9; Genie 1's
        // readiness wait, main/port-probe.ts).
        siteProbe: (port, options) => siteAnswers(port, options),
        // Each site's php-cgi gets Genie's CA ini directory once Check and repair has written one — read at each start.
        phpWorkerEnv: () => phpWorkerEnv(processEnv),
        // The system roots for PHP's trust bundle, beside Genie's own CA (main/php-trust-host.ts).
        phpSystemRoots: () => systemRootsPem(process.platform, (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } }, toolchainPaths(toolchainDataDir()).bundle),
        // A php site's pin (T4): unpinned runs PATH php-cgi (Genie's toolchain PHP with opcache on, genie#1043); pinned
        // runs that Genie-managed version or is refused.
        resolvePhpCgi: (pin) => resolvePhpCgi(pin, phpCgiBase()),
        // Right before a php site's php-cgi starts: a pinned version's ini brought current, the opcache cache's directory.
        preparePhpCgi: (pin) => refreshManagedIni(pin, phpCgiBase()),
        // Genie 1's `.gen` CA, already in this machine's trust store: ADOPTED (copied) when Genie 2 has no CA of its own, so
        // an upgrade serves https://<name>.gen trusted with no prompt (main/gen-ca.ts). Genie 1's userData, and its mirror.
        v1CaDirs: [...new Set([join(app.getPath('userData'), 'host-gen'), join(app.getPath('appData'), 'Genie', 'host-gen')])],
        frontDoorPort: 0,
        mcpEndpoint: () => mcpEndpointNow(),
        mcpVerification: () => mcpVerified,
        mcpTools: () => mcpToolList,
        // The live roster, late-bound: the human's inbox resolves, names and counts from the same agents the MCP tools do.
        // A plain list, never `registry.snapshot()`: the snapshot builds the Deck's items, which ask this roster for
        // names — reading the snapshot here recursed until the stack overflowed (CI's real window, #161).
        roster: () => registry?.listAgents() ?? [],
        workspaceSlugs: () => registry?.workspaceSlugs() ?? new Map(),
        refusalForRecipient: (text) => registry?.mailRefusal(text) ?? null,
        inboxParticipantVisible: (id) => registry?.mailParticipantVisible(id) ?? true,
        inboxVisibilityVersion: () => registry?.mailVisibilityVersion(),
        // Each site's own app credential (genie#1345), under its workspace's switch — compose never puts it in the service env.
        // The registered workspaces, whose envelopes declare the sites Hosting lists and serves (§6.6); a plain
        // list for the same reason as the roster. Their changes (added, removed, hibernated, woken) re-sync the sites.
        workspaces: () => registry?.workspaceStates() ?? [],
        onWorkspacesChange: (listener) => registry?.subscribe(() => listener()) ?? (() => {}),
        // The rail's namer, so a question in the Deck and its window names the workspace the way the rail does.
        workspaceName: workspaceNameFor,
        // ...and its colour (genie#1300), so the question window and the approval toasts show it beside the name.
        workspaceColor: (path) => workspaceColors?.colorOf(path) ?? null,
        // Is the agent that asked still waiting: its live session (session host) or its Take Over terminal. A question
        // whose agent has neither, or whose running session started after it was asked, is STALE on the Deck.
    });
    services = composed;
    /*
     * THIS WINDOW IS SERVED BY GENIE-HOST (Tynn #898 step 2d-4b): each connection the door admits rides the engine link
     * to genie-host's RemoteHost, admitted there as this machine's window. main serves none of it; the window's browser
     * pane is said for the main window's connection, and again on every change.
     */
    const windowTunnel = tunnelDoor(localDoor, tunnelLinkOf(agentEngineLink.client), {
        browser: (connectionId) => {
            const contents = localDoor.contentsFor(connectionId);
            return contents && contents.id === window?.webContents.id ? browserPane?.state() ?? null : null;
        },
        // The main window's "the page came back" notice is its own: said for its connection only (gate renderer-crash B3/B4).
        notice: (connectionId) => {
            const contents = localDoor.contentsFor(connectionId);
            return contents && contents.id === window?.webContents.id ? rendererNotice : null;
        },
    });
    // main's own client was tunnelled before the registry loaded, and its settings watch started there (Tynn #1007, 2g-4e).
    // What genie-host runs, as the tray and the quit read it, kept as it changes (Tynn #953, 2g-2).
    // ...and this machine's role and its Tynn account (Tynn #954, 2g-3a): another account (or none) closes the relay windows
    // opened under the last one, which hold its grants (M0 finding 2).
    ownProtocol.watchSummary((summary) => {
        const before = hostSummaryNow;
        if (summary.tynnAccountKey !== hostSummaryNow.tynnAccountKey) { hostSummaryNow = summary; closeRelayWindowsOfOtherAccounts(); }
        hostSummaryNow = summary;
        refreshTray();
        // genie-host's keychain can keep secrets now (Tynn #959): what an older Genie sealed is handed over again.
        unsealer.summary(before, summary);
    });
    /*
     * WHAT AN OLDER GENIE SEALED (Tynn #959, 2g-3b; legacy-unsealer.ts): only this process has Electron's safeStorage, so it
     * unseals each old copy once, hands it to genie-host over its own protocol client, and deletes the copies genie-host
     * names. It keeps no secret. Per the owner's split ruling ("Electron pieces live in the launcher"), this moves to the
     * launcher in split step 6.
     */
    void unsealer.run();
    // A sign-in that came back before main's own client could reach genie-host's account (this launch's argv, an early second launch).
    ownProtocolTunnelled = true;
    if (pendingGenieUrl !== null) { const url = pendingGenieUrl; pendingGenieUrl = null; openGenieUrl(url); }
    windowTunnelNow = windowTunnel;
    // Browser/UI facts this window owns: its pane and its notice are said down the tunnel, where genie-host reads its
    // features again (genie-host's own sources invalidate them too: its Tynn and GitHub accounts, its relay role, …).
    const pushFeatures = () => {
        windowTunnel.refreshWindow();
    };
    requestFeaturePush = pushFeatures;
    // Who is connected and which devices are paired redraw as they change; "Pair this device?" appears at once, and a
    // window not in front asks for attention (taskbar flash / urgency) WITHOUT taking focus (q_8c07b142).

    // A share-link guest waiting to be let in (Tynn #731) also gets a desktop notification, once: the window may be hidden
    // in the tray, and the ask lapses in two minutes.
    // SOMEONE CONNECTED TO THIS MACHINE (Tynn #726, consent): a desktop notice for each arrival, whether or not a window
    // is open (the windows carry the banner while anyone stays). A Pilot over the relay is never asked to pair, so
    // without this the person at this machine was never told.
    // Both read genie-host's remote.watch on main's own client (Tynn #997, 2g-4a): who is here and who asks, as it changes.
    const guestAsksSeen = new Set<string>();
    let pairRequestsSaid = '';
    const arrivals = new ConnectWatch();
    const flashWindows = (): void => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.isVisible() && !w.isFocused()) w.flashFrame(true); };
    ownProtocol.watchRemote((view) => {
        const requestsKey = JSON.stringify(view.pairRequests);
        if (requestsKey !== pairRequestsSaid) {
            pairRequestsSaid = requestsKey;
            pushFeatures();
            const fresh = newGuestAsks(guestAsksSeen, view.pairRequests);
            if (view.pairRequests.length > 0) {
                flashWindows();
                if (Notification.isSupported()) {
                    for (const request of fresh) {
                        const notice = guestAskNotice(request);
                        const n = new Notification({ title: notice.title, body: notice.body });
                        n.on('click', () => { revealMainWindow('notification click: guest asks'); });
                        n.show();
                    }
                }
            }
        }
        const arrived = arrivals.next(view.connections);
        if (arrived.length === 0) return;
        flashWindows();
        if (!Notification.isSupported()) return;
        for (const label of arrived) {
            const notice = connectNotice(label, view.hostName);
            const n = new Notification({ title: notice.title, body: notice.body });
            n.on('click', () => { revealMainWindow('notification click: connected'); });
            n.show();
        }
    });
    // The Services and Hosting tabs redraw when an AGENT acts through its `services` / `sites` tools, not only when the
    // person does (their own action answers with the snapshot; an agent's has nobody to answer but this push).


    // THE KEYRING CARD, THE TYNN AND GITHUB ACCOUNTS AND THIS MACHINE'S REGISTRATION ARE GENIE-HOST'S (Tynn #959, 2g-3b): it
    // rechecks them itself when its keychain comes back (keyring-service.ts onReady) and registers with Genie 1's record
    // when the unsealer hands it over. What only Electron knows is said here once, for the log.
    if (process.platform === 'linux') console.log(`[genie] this window's password store: backend ${safeStorage.getSelectedStorageBackend()}, encryption ${safeStorage.isEncryptionAvailable() ? 'available' : 'unavailable'}`);
    // WHAT AGENTS RUN, EACH CHANGE WITH ITS OWN SOUND ROW (Tynn #766 C2b) is said by genie-host, which runs them (Tynn #1045,
    // 2g-4d-C): a `thing` tool signal, handed on above (onToolSignal).
    // GENIE'S BROWSER FOR A SITE'S OPEN — the Hosting row's and an agent's `sites open` alike (hosting-actions.ts
    // `openSite` checks the site is served first): the Genie browser WINDOW comes up with the site in a new tab (beta.35
    // item 36 — Genie 1's own window). The person sees what the agent opened; nothing opens outside Genie.
    // WHO ASKED decides whether it may take the keyboard (genie#1235): the Hosting row's Open is the person's click and
    // brings the window up; an agent's `sites open` opens it behind whatever the person is doing.
    const openInBrowserFor = (activation: Activation): OpenInBrowser => async (url) => {
        // The person's click (a site row's Open): over the Genie window they clicked in (Tynn #739); an agent's: no anchor.
        const anchor = activation === 'user-gesture' ? BrowserWindow.getFocusedWindow()?.getBounds() ?? null : null;
        const opened = await openLocalBrowser(url, activation, anchor);
        return opened.ok ? { ok: true } : { ok: false, reason: opened.error };
    };
    // AN AGENT'S `sites open` (genie#1265): in the background, and the workspace the site belongs to pulses for the person.
    const agentOpensSite: OpenInBrowser = async (url) => {
        const r = await openInBrowserFor('background')(url);
        const host = ((): string | null => { try { return new URL(url).host.toLowerCase(); } catch { return null; } })();
        const site = r.ok && host ? frontDoorNow.sites.find((s) => s.host.toLowerCase() === host) : undefined;
        if (site) showToPerson({ activation: 'background', workspaceId: site.workspaceId, reason: 'sites open' });
        return r;
    };
    // THE PROCESS BOOK AND ITS SCHEDULER ARE GENIE-HOST'S (P3.3c): what the person keeps running is restored there, and a
    // scheduled task fires on its clock, with or without this window. Every window manages them over the protocol; this
    // process reads only what its tray says (hostSummaryNow, Tynn #953).
    // UPDATE CHANNEL (the owner, 2026-10-12): genie-host's updater follows the setting itself (genie-host.ts), since Tynn #998.
    // GENIE'S OWN MCP SERVER (§6.9): every tool registered, the loopback listening, the boot probe recorded.
    {
        // A Take Over terminal, or an agent SESSION by its caller key (`mcp-callers.ts`); anything else is nobody.
        // A flow's tool steps run in genie-host, under its own callers (genie-host.ts `flowCallers`): none is resolved here.
        // A caller genie-host vouched for, for a tool it forwarded here (P3.1): its session keys are the host's now.
        const vouchedCallers = new Map<string, Caller>();
        const resolveCaller = (terminalId: string) => vouchedCallers.get(terminalId) ?? sessionCaller(terminalId);
        // The stores agents write to: genie-host's when it runs — its own tools write them there, and in this window they
        // are never reached (hostOnly says so if anything tries).
        // Every agent, the OS agent included: a tool finds its caller here (genie-tool-deps.ts `toolRoster`, Tynn story #385).
        const roster = () => toolRoster(registry!);
        // ONE builder for the tools' wiring (genie-tool-deps.ts) — doctor mode builds its agent's tools with it too.
        const registrations = withActionSignal(allGenieTools(genieToolDeps({
            // agentinbox list: whether each peer is running, read-only — never started by asking (core/liveness.ts).
            liveness: (id) => livenessOf(host?.probe(id as AgentId) ?? null, host?.rowsFor(id as AgentId).at(-1)?.at ?? null),
            inbox: hostOnly<InboxStore>('the AgentInbox'),
            attention: hostOnly<AttentionStore>('attention (questions, imDone, lists)'),
            knowledge: hostOnly<KnowledgeStore>('the knowledge graph'),
            settings: settingsNow,
            // ONE approval queue: genie-host's (a window tool's ask goes there).
            approve: (caller, action, detail, call) => approvalsNow.gate(caller, action, detail, call),
            roster,
            workspaceSlugs: () => registry?.workspaceSlugs() ?? new Map(),
            refusalForRecipient: (text) => registry?.mailRefusal(text) ?? null,
            resolveCaller,
            // createAgent: any agent asks, the person approves in the Deck, the registry registers (genie-host's own since Tynn #1015).
            agents: {
                defaultAgentOf: (workspaceId) => registry?.defaultAgentOf(workspaceId) ?? null,
                // genie-host's Add agent, as the form calls it (the window's registry is its replica).
                create: createThroughAddAgent(async (method, args) => { const answer = await ownProtocol.call(method, args); return answer.ok ? answer.value : answer; }, (id) => registry?.find(id as AgentId) ?? null),
            },
            // workspaceTabs (beta.35 item 36): the workspace's tabs setting (every window reloads it), and its sites' hosts.
            workspaceTabs: {
                write: (workspaceId, raw) => { void settingsNow.setFor(workspaceId, 'workspace_tabs', raw).catch((error: unknown) => console.error(`[genie] workspace tabs could not be saved: ${error instanceof Error ? error.message : String(error)}`)); showToPerson({ activation: 'background', workspaceId, reason: 'workspaceTabs' }); },
                sites: (workspaceId) => frontDoorNow.sites.filter((s) => s.workspaceId === workspaceId).map((s) => s.host),
            },
            // pages (browser rebuild step 7): the Genie browser's tabs and the live site panels, each drivable.
            pages: { open: () => [...drivablePages(), ...browserPages.list()] },
            userActive: () => powerMonitor.getSystemIdleTime() < 120,
            glow: (terminalId) => { broadcast('genie:glow', terminalId); return true; },
            // A sound row of its own (Tynn #766 C2a): the window plays genie:action by its kind.
            thumbsUp: (caller, reason) => { broadcast('genie:action', { agentId: caller.agentId, kind: 'thumbsup', reason }); },
            issueWatch: { forWorkspace: (workspaceId) => issueWatchSummaryFor(workspaceId), refresh: (workspaceId) => issueWatchRefreshFor(workspaceId), recheckSignIn: () => { void ownProtocol.call('tynn.recheck', []); } },
            // In GENIE (genie#922): that workspace's file panel on the file, and Genie brought forward — never the OS's default app.
            openFile: async ({ workspaceId, path, line }) => { attractMainWindow('openFileForUser'); showToPerson({ activation: 'background', workspaceId, file: path, line, reason: 'openFileForUser' }); return { ok: true }; },
            // The `plan` tool: into the caller's own session, so its Active Plan column shows it.
            reportPlan: (agentId, steps) => host?.reportPlan(agentId as AgentId, steps) ?? false,
            // ...and read back from the agent's record, where every plan is kept across restarts (identity.ts `plan`).
            readPlan: (agentId) => registry?.find(agentId as AgentId)?.plan ?? null,
            // manageTerminals, processes and flows are genie-host's own tools, never run here (mcp-host-tools.ts HOST_NATIVE_TOOLS;
            // Tynn #953): their stores are the host's, said so if anything here ever asks.
            terminals: hostOnly<TerminalsPort>('the terminals'),
            // The agents' `services` / `sites` tools act on the same composition the Services and Hosting tabs do.
            hosting: composed,
            // `sites open` shows the site in the same browser the Hosting row's Open does — without taking focus (genie#1235)
            // or the tab on screen, and the site's workspace pulses (genie#1265).
            openInBrowser: agentOpensSite,
            // …and `sites` / `services` act only in a trusted workspace (Tynn #753): the verdict as last read, as a shell call reads it.
            workspaceTrusted: (workspaceId) => !composed.untrustedNow({ workspaceId }),
            // `services exec`: a one-off command with the workspace's service variables (main/service-exec.ts).
            serviceExec: runServiceExec,
            // The plugins' tools are GENIE-HOST'S (ADF A3, Tynn #447): its MCP server offers and runs them with no window.
            plugins: { tools: () => [], guard: () => null, run: async () => ({ ok: false, reason: "a plugin's tool runs in Genie's host, not this window" }) },
        })), resolveCaller, (agentId, kind, tool) => broadcast('genie:action', { agentId, kind, tool }));
        // The host's own tools run in genie-host, a flow's steps among them: of those only `sites open` runs here (Tynn #1043).
        const engineLink = agentEngineLink?.client ?? null;
        mcpToolList = registrations.map((r) => describeMcpTool(r.definition.name, r.definition.description ?? '', r.visible !== undefined));
        if (engineLink) {
            /*
             * GENIE'S MCP SERVER IS GENIE-HOST'S (the host split, P3.1; plan §11d): agents keep its tools when this window
             * closes. This window runs the tools that still need it (forwarded), and tells the host what those need of the
             * registry and settings until P3.2 — the first time starts the host's server.
             */
            windowToolRun = windowToolRunner(() => registrations, vouchedCallers);
            for (const call of openFilesLater.splice(0)) void windowToolRun(call);
            // Whether the person is at the computer, for ForceTheQuestion's "they are away": said every half minute over main's
            // own client (Tynn #1044). genie-host names its workspaces and finds Genie 1's database itself.
            const sayPresence = (): void => { void ownProtocol.call('window.view', [{ userActive: powerMonitor.getSystemIdleTime() < 120 }]); };
            sayPresence();
            setInterval(sayPresence, 30_000).unref?.();
            const status = await engineLink.mcpStatus();
            hostMcpEndpoint = status?.endpoint ?? null;
            mcpVerified = status?.verified ?? { ok: false, reason: 'genie-host did not start its MCP server' };
            if (status) mcpToolList = status.tools;
        }
        // THE WORKSPACE AGENT FILES are genie-host's to keep, window or no window (Tynn #898 step 2e-2: host-workspace-files.ts).
        pushFeatures();
    }
    // RESTORE AFTER A RELAUNCH OR UPGRADE (§7.6): only with the ONE setting on; starts spaced three seconds apart; what the
    // user stopped was not running at quit, so it is not in the list. Each agent leaves the saved list once its start went
    // through (Tynn #754), so a crash mid-restore starts nobody twice and a shutdown mid-restore loses nobody waiting.
    // The agents a shutdown cut off mid-turn are resumed WHATEVER the setting (Genie cancelled their turn, not you) and
    // told to continue; the rest only with the setting on, unprompted.
    // SAFE MODE (Tynn #386): genie-host said so before ready; then nobody is started or resumed and both lists are KEPT.
    void restoreAfterRelaunch({
        safeMode: windowSafeNow,
        pending: () => registry!.beginRestore(),
        started: (agentId) => registry!.restoreStarted(agentId as AgentId),
        name: (agentId) => registry?.find(agentId as AgentId)?.name ?? agentId,
        // NO AGENT DRIVEN BY TWO PROCESSES (Tynn #796): a provider a previous Genie left running on an agent's session
        // (its quit cut short by an installer, a crash) ends BEFORE any agent here is started or resumed.
        // The ledger sweep at boot ends what this Genie's predecessors RECORDED; this one still ends a provider a Genie
        // from before the ledger (beta.32 and earlier) left on an agent's thread. Read off the loop (beta.53 freezes).
        // NEVER from a window that ADOPTED a running agent host: its providers are the host's live agents, not leftovers.
        // Only a host this window STARTED (or replaced) has no live agents yet; adopted or unreachable hosts hold live ones.
        beforeStart: async () => {
            if (agentEngineLink?.how === 'started' || agentEngineLink?.how === 'replaced') await sweepLeftoverProvidersAsync((registry?.listAgents() ?? []).map((a) => ({ name: a.name, threadId: a.threadId })), undefined, lifecycleLog);
        },
        schedule: (fn, ms) => { setTimeout(fn, ms); },
        start: async (agentId, resume) => {
            const record = registry?.find(agentId as AgentId);
            if (!record) return;
            if (!host) throw new Error('no agent host');
            const engine = host;
            // A refused start (Genie shutting down, a previous run still stopping) did not start: the agent stays saved for
            // the next launch (Tynn #754), and a mid-turn one's prompt is still kept as owed for its Restart (genie#1238).
            const started = await engine.start(record, cwdFor(record));
            if (!started.ok) {
                if (resume) await engine.recordOwed(record.id, RESUME_AFTER_RESTART, 'genie');
                throw new Error(started.reason);
            }
            // A start that was refused has no session to take the resume prompt: it is KEPT as owed, and the agent's
            // Restart delivers it (genie#1238). It used to be dropped, and the interrupted work with it.
            if (resume && !(await engine.prompt(record.id, RESUME_AFTER_RESTART, 'genie'))) await engine.recordOwed(record.id, RESUME_AFTER_RESTART, 'genie');
        },
        log: lifecycleLog,
    });
    registry.setRendererNotice(() => rendererNotice);
    // Listening (or the reason not) reaches Settings → Workstation as soon as it is known.
    // Remote access is genie-host's (Tynn #820, #409): it applies the switch at boot and on every change of `remote_access`.
    // THE DECK, ITS SIGNALS AND EACH AGENT'S LAST HANDOFF are genie-host's (the question window and the tray read deck.watch,
    // and every window draws the host's features): the window registry built them too, and nothing read them. main reads only
    // its registry's agents and workspaces (Tynn #998, 2g-4b1: test/split-2g4b1-settings-watch.test.ts holds the proof).
    // §6.4 THE INBOX PUSH (main/inbox-push.ts): Genie itself puts the notice into the agent's session, for every provider.
    // NOBODY HAS TO TYPE (genie#1379): every agent with a session is told after the coalescing window — a busy one at its
    // next step, as typed input arrives (genie#1411). An app's message starts a stopped agent only if it is automated and
    // the app wake cap allows; a turn only apps' mail opens is spent from that cap, and past it the mail waits for the window.
    // With genie-host the MAIL WAKE is the host's (P3.2, host-mail-wake.ts): an agent is told, and a stopped one started,
    // with no window.
    // THE WORKSPACE'S APPS AND SCRIPTS CARD (genie#1345): this host's own local window; a key is
    // never minted for a window driving another machine. Rotate / Revoke / Allow restart the source so it starts with
    // its new credential, or none.
    // The same code as genie-host's own answers (host-owner-ops.ts, Tynn #898 step 2d-3b), over this window's replicas.
    // ISSUEWATCH AND THE LIVE BOARD (Tynn #806, genie#1295 B4; the host split, P5c): genie-host's. It hears Tynn on its own
    // account and tells the linked workspace's agents through its own wake, window or no window; this window reads the state,
    // plays the sounds the host says to play now, and follows its boards per view.
    {
        const engineClient = agentEngineLink.client;
        issueWatchNow = engineClient.issueWatch();
        tynnBoardDoor = { watch: (viewId, workspaceId) => engineClient.tynnBoardWatch(viewId, workspaceId), unwatch: (viewId) => { void engineClient.tynnBoardUnwatch(viewId); } };
        engineClient.onTynnBoardEvent((event) => { emitTynn('board', event.workspaceId, event.signal); });
        tynnIssuesDoor = { watch: (viewId, workspaceId) => engineClient.tynnIssuesWatch(viewId, workspaceId), unwatch: (viewId) => { void engineClient.tynnIssuesUnwatch(viewId); } };
        engineClient.onTynnIssuesEvent((event) => { emitTynn('issues', event.workspaceId, event.signal); });
        tynnFeaturesDoor = { watch: (viewId, workspaceId) => engineClient.tynnFeaturesWatch(viewId, workspaceId), unwatch: (viewId) => { void engineClient.tynnFeaturesUnwatch(viewId); } };
        engineClient.onTynnFeaturesEvent((event) => { emitTynn('features', event.workspaceId, event.signal); });
    }
    // The panel follows the host's state; a batch's sounds (one per kind, core/alerts.ts) are played by the window like any action.

    issueWatchNow?.onSound((kind) => { broadcast('genie:action', { agentId: null, kind }); });
    // The human's conversation is in the features snapshot (an observed agent's chat): new mail and read receipts
    // push it, so a reply or a "read 14:07" lands without anyone polling.


    // MAIL BETWEEN AGENTS ON THE BOARD (genie#1209, Tynn #766 C2a): genie-host says each send and read (a `mail` tool signal).
    const ownFeatureUi = featureWindow(localDoor, {
        openFlowEditor: route => openFlowEditorWindow(route, 'user-gesture'),
        openExternal: async url => { if (!/^https:\/\//i.test(url)) throw new Error('only an HTTPS sign-in page can be opened'); await shell.openExternal(url); },
        openInBrowser: openInBrowserFor('user-gesture'),
        rendererNotice: { dismiss: async () => { rendererNotice = null; registry?.touch(); windowTunnelNow?.refreshWindow(); return { ok: true as const }; } },
        browser: {
            snapshot: () => browserPane?.state() ?? { url: null, canGoBack: false, canGoForward: false },
            navigate: async url => { if (!browserPane) throw new Error('this caller has no browser pane'); const shown = await browserPane.show(url); if (!shown.ok) throw new Error(shown.reason); },
            back: () => browserPane?.back(), forward: () => browserPane?.forward(), reload: () => browserPane?.reload(),
        },
        mainErrors: {
            deckItems: () => mainErrors.deckItems(),
            dismiss: (id) => mainErrors.dismiss(id),
            retryHostCopy: (id) => retryHostCopy(mainErrors, id, () => remakeHostCopy()),
            openLog: (id) => {
                if (id && !mainErrors.list().some((error) => error.id === id && (error.kind === 'uncaught-exception' || error.kind === 'unhandled-rejection'))) return Promise.resolve('This error is no longer available.');
                const path = id ? join(genieRoot(), 'logs', 'genie-browser.log') : join(runtimeDir(genieRoot()), 'lifecycle.log');
                return shell.openPath(path).then((failed) => failed || null, () => 'The log could not be opened. Try again from Genie’s logs folder.');
            },
            report: async (id) => {
                if (!mainErrors.list().some((error) => error.id === id && (error.kind === 'uncaught-exception' || error.kind === 'unhandled-rejection'))) return 'This error is no longer available.';
                const query = new URLSearchParams({ title: `[v${app.getVersion()}] Genie recovered from an internal error`, body: 'What were you doing when this happened?\n\nWhat did you expect, and what happened instead?\n\nTechnical details remain in your local Genie log. Review any details you choose to share before submitting this issue.' });
                try { await shell.openExternal(`https://github.com/Renaissance-Analytics/genie/issues/new?${query}`); return null; }
                catch { return 'The draft could not be opened. Try again, or open Genie’s GitHub issues page.'; }
            },
        },
    }, () => window?.webContents.id ?? null);
    featureEffectNow = ownFeatureUi;
    // THE FORCETHEQUESTION WINDOW (§6.3; the owner, 2026-10-14: "a window that opens on top of all other windows"). It
    // reads the SAME items Pending Questions (the Deck) shows and answers through the same action, so the two stay one
    // workflow: a question asked opens it; one answered in either place leaves both.
    // THE CONNECTED MACHINE'S QUESTIONS (Tynn #726): a window driving another machine reports that machine's live
    // questions; they join this window and its queue, and an answer goes back through that window to the host's own
    // features.act (main/remote-questions.ts).
    /** genie-host's Deck as it last said (deck.watch, Tynn #941 2f-2); empty until it does. */
    let hostDeckNow: readonly DeckItem[] = [];
    // The tray follows the Deck: the badge's own count (core/deck.ts needsYouCount) of this window's error notices and the
    // host's Deck, redrawn only when it changes.
    const refreshTrayWaiting = (): void => {
        const waiting = needsYouCount([...mainErrors.deckItems(), ...hostDeckNow]);
        if (waiting !== trayWaiting) { trayWaiting = waiting; refreshTray(); }
    };
    const remoteQuestions = new RemoteQuestions({
        send: (sender, request) => {
            const contents = webContents.fromId(sender);
            if (!contents || contents.isDestroyed()) return false;
            contents.send('genie:remote-question-act', request);
            return true;
        },
    });
    const questionReporters = new Set<number>();
    ipcMain.on('genie:remote-questions', (event, host: unknown, items: unknown) => {
        if (typeof host !== 'string' || !Array.isArray(items)) return;
        const sender = event.sender.id;
        if (remoteQuestions.report(sender, host, items)) questionWindow?.changed();
        if (questionReporters.has(sender)) return;
        questionReporters.add(sender);
        event.sender.once('destroyed', () => { questionReporters.delete(sender); if (remoteQuestions.drop(sender)) questionWindow?.changed(); });
    });
    ipcMain.on('genie:remote-question-acted', (event, id: unknown, outcome: unknown) => {
        if (typeof id === 'string') remoteQuestions.settle(event.sender.id, id, outcome);
    });
    questionWindow = new QuestionWindow({
        // genie-host's Deck (deck.watch, Tynn #941 2f-2): the same questions every window's Pending Questions shows, judged
        // stale there; and the connected machine's (Tynn #726).
        items: () => [...hostDeckNow, ...remoteQuestions.items()],
        open: electronQuestionWindow({ here, preload: join(here, 'question-preload.cjs'), controller: () => questionWindow, workspacePath: (id) => registry?.workspace(id)?.path ?? null,
            // Its page reaches genie-host over the one protocol, on this door like every Genie window (Tynn #912, 2f-1): this
            // machine's answers and Dismiss (features.act), and its question's files and visuals (questions.*).
            admit: (contents) => { localDoor.admit(contents); },
            // Only ANOTHER machine's question crosses to main (Tynn #726): through the window driving that machine.
            owns: (id) => remoteQuestions.owns(id),
            // Its visuals (Tynn #835): read from that machine's board, through the window driving it.
            visuals: (item) => remoteQuestions.visuals(item),
            openInFiles: (workspaceId, path) => { revealMainWindow('question: Open in Files'); showToPerson({ activation: 'user-gesture', route: `genie://workspace/${encodeURIComponent(workspaceId)}?files=${encodeURIComponent(path)}`, reason: 'question: Open in Files' }); } }),
        // ANOTHER MACHINE'S question, answered or dismissed on that machine, with the person's notes (Tynn #726). This
        // machine's are the page's own features.act over the one protocol (Tynn #912, 2f-1): main answers none of them.
        answer: (item, selections, notes) => remoteQuestions.act(item, { kind: 'deck.answerForm', selections, notes }),
        dismiss: (item, notes) => remoteQuestions.act(item, { kind: 'deck.dismiss', notes }),
        // Do Not Disturb (Settings → General) is the ONE thing that keeps the window shut (the owner, 2026-10-15: "If DnD
        // is not turned on then FTQ always opens for every agent"). Read at every change; the agent is still told the DND
        // reply at once (attention-store.ts), and the question waits in Pending Questions.
        dnd: () => settingsNow.snapshot().do_not_disturb === true,
    });
    // The host's Deck as it changes: the question window, and the tray's count (Tynn #941, 2f-2).
    ownProtocol.watchDeck((items) => {
        hostDeckNow = items;
        questionWindow?.changed();
        refreshTrayWaiting();
    });
    // Do Not Disturb turned OFF, by hand or on its schedule, opens what waited (Tynn #721).
    settingsNow.onChange((key) => { if (key === 'do_not_disturb') questionWindow?.changed(); });
    // Questions already waiting when Genie starts come up too.
    questionWindow.changed();
    ipcMain.handle(FEATURE_CHANNELS.browserBounds, (_event, raw: unknown) => {
        const b = raw as { x: number; y: number; width: number; height: number };
        if (!browserPane || typeof b?.width !== 'number') return;
        // A zero-sized box means the surface is not on screen: hide rather than paint over another surface.
        if (b.width === 0 || b.height === 0) browserPane.hide();
        else browserPane.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
    });
    // The tray follows this window's registry (its agents) and the host's Deck as it says.
    registry.subscribe(() => { refreshTrayWaiting(); });
    // An error the main process caught and survived (the policy at the top of this file) reaches the tray's waiting count at
    // once, directly: no longer through the window registry's Deck, which nothing read (Tynn #998, 2g-4b1).
    mainErrors.onChange(() => { refreshTrayWaiting(); });
    let published = '';
    /*
     * A ledger row can change a Dashboard cell — a plan step, a context figure — so the estate-wide snapshot is refreshed
     * too: at most every AGENT_PUSH_INTERVAL_MS, the first at once (core/coalesce.ts). Per event it read every agent's
     * session and pushed the whole estate to the window many times a second for one busy agent (the owner, 2026-10-20).
     */
    const estate = new Coalescer<'estate'>({ intervalMs: AGENT_PUSH_INTERVAL_MS, flush: () => registry?.touch(), schedule: realSchedule, now: () => Date.now() });
    // EVERY AGENT'S ACTIVITY FEED (beta.33 item 10): built from the session host's own ledgers and pushed to the window as
    // each session changes — what the workspace Dashboard's lanes draw. Never polled; one small feed per agent.
    activityFeeds = new ActivityFeeds({ host });
    host.subscribe((agentId) => {
        refreshTray();
        // Which agents are started, for doctor mode — rewritten only when that set changes.
        const started = host?.startedIds().sort() ?? [];
        if (started.join(',') !== published) { published = started.join(','); markGenieRunning(genieRoot(), started); }
        estate.request('estate');
    });

    // TRAY-RESIDENT (core/tray-resident.ts): start minimised keeps the window in the tray at boot; closing it hides it
    // (Windows, Linux) and Genie keeps running — the agents, the terminals, the services. A quit is asked for.
    // S7: each .gen site at its own https origin — the pane's session routes *.gen to the in-app front door and trusts
    // Genie's CA for .gen hosts only (electron-browser-view.ts). Without a CA, .gen pages are refused and the reason logged.
    // THE FRONT DOOR AS IT IS NOW (P5a.2): genie-host's, so it can come back on another port or with another CA. Every
    // browser session reads these, and is routed again when they change. Said by genie-host on frontdoor.watch (Tynn #1046),
    // and waited for here, so the sessions and the site panels are made with the real front door.
    await frontDoorWatch.ready(FRONT_DOOR_BOOT_DEADLINE_MS);
    frontDoorNow = frontDoorWatch.now();
    if (frontDoorNow.caPem === null) console.error(`[genie] browser: .gen sites cannot open in the Genie Browser: ${frontDoorNow.caReason ?? 'genie-host said no CA'}`);
    gappWindowsNow = gappWindowsElectron({ sessions: () => agentEngineLink?.client.gappSessions() ?? null, frontDoor: () => frontDoorNow, preload: join(here, 'gapp-preload.cjs'), ledger: activationLedger });
    // A change of the port or the CA routes every session again; a change of the routes or the sites only is said to the
    // browser again (its hosts, their workspaces and labels): routes too now, which compose's sites change missed.
    frontDoorWatch.onChange((view, moved) => {
        frontDoorNow = view;
        if (moved) {
            console.log(`[genie] browser: the front door is on :${view.port} now${view.caPem === null ? ` with no CA (${view.caReason ?? 'none said'})` : ''}`);
            followFrontDoorInPanes();
            rerouteGenieBrowserSession({ frontDoorPort: view.port, caPem: view.caPem });
            gappWindowsNow?.reroute();
        }
        publishBrowserFacts?.();
    });
    // LIVE SITE PANELS: a <webview> in the MAIN window, whichever window that is now (P1b: it can be closed and built again),
    // in the store of the site's own workspace.
    livePanels = sitePanels({ window: () => window, genieHome: genieRoot(), frontDoorPort: frontDoorNow.port, caPem: frontDoorNow.caPem, enabledHosts: () => frontDoorNow.routes.map((r) => r.host), workspaceOfHost: (host) => frontDoorNow.sites.find((s) => s.host.toLowerCase() === host.toLowerCase())?.workspaceId ?? '_shared', openInWindow: (url, activation) => { void openLocalBrowser(url, activation); }, browserCall: (method, args) => (agentEngineLink?.live === true ? agentEngineLink.client.browserCall(method, args) : null), restart: panelRestart(confirmTray, restartGenie) });
    mainWindowDeps = { frontDoorPort: () => frontDoorNow.port, caPem: () => frontDoorNow.caPem, routes: () => frontDoorNow.routes, settings: settingsNow, pushFeatures: () => { pushFeatures(); } };
    // Start minimized and the login item are read as genie-host says them, not as defaults: its settings first (a host that
    // does not answer is waited for no longer than the deadline, and then the defaults stand).
    await settingsNow.ready(SETTINGS_BOOT_DEADLINE_MS);
    mountMainWindow(showOnBoot({ startMinimized: settingsNow.snapshot().start_minimized === true, argv: process.argv }));
    // LAUNCH AT SIGN-IN: adopt Genie 1's entry, apply at boot, follow every change.
    void wireLoginItem(settingsNow, loginItemPort, {
        platform: process.platform,
        packaged: app.isPackaged,
        execPath: process.execPath,
        appImage: process.env.APPIMAGE ?? null,
        configHome: process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0 ? process.env.XDG_CONFIG_HOME : join(homedir(), '.config'),
    }, leftRunning);
    trayHandlers = {
        onUpdate: () => { revealMainWindow('tray: update'); },
        onTaskManager: () => { revealMainWindow('tray: Task Manager'); showToPerson({ activation: 'user-gesture', route: 'genie://hosting?tab=processes', reason: 'tray: Task Manager' }); },
        // New scratch terminal (Tynn #761; the owner, 2026-10-19: in Genie's own workspace): home folder, its own window.
        // A signed-out login named in the tray (#967): its own login, in a window of its own.
        // genie-host starts the provider's own login and asks this window to open it (Tynn #896, 2b-2b); Genie never
        // touches a credential, and closing the window cancels the login there.
        onProviderLogin: (provider) => {
            void ownProtocol.call('logins.provider', [provider]).then((r) => { const why = callRefusal(r); if (why) console.error('[genie] provider login:', why); });
        },
        // Claude Design's login (#1081): the same login window, running the interactive `claude`.
        onDesignLogin: () => {
            void ownProtocol.call('logins.design', []).then((r) => { const why = callRefusal(r); if (why) console.error('[genie] Claude Design login:', why); });
        },
        // Genie's own (null): genie-host opens it in the home folder and asks this window process to show it (#897, 2c-4).
        onScratchTerminal: () => {
            void ownProtocol.call('terminals.scratch', [null]).then((r) => { const why = callRefusal(r); if (why) console.error('[genie] scratch terminal:', why); });
        },
        onOpen: () => { revealMainWindow('tray: Open'); },
        onSettings: () => { revealMainWindow('Settings'); showToPerson({ activation: 'user-gesture', route: 'genie://settings', reason: 'Settings' }); },
        onCheckUpdates: () => { void updates?.check(); },
        onQuit: () => { requestQuit(); },
        // QUIT KEEPS THE HOST (P1b): with genie-host, the tray offers the quit's two answers instead of Quit.
        // ALWAYS ASK (the owner, 2026-11-02): Restart and Shut down everything confirm first, every time.
        ...(agentEngineLink ? { onCloseUi: () => { closeUi('tray'); }, onRestart: () => { void confirmTray('restart').then((ok) => { if (ok) restartGenie(); }); }, onShutDown: () => { void confirmTray('shut-down').then((ok) => { if (ok) { leftRunning.set(false); requestQuit('shut-down'); } }); }, uiOpen: () => window !== null && !window.isDestroyed() } : {}),
        onResumeLimit: (provider) => { host?.resumeLimit(provider); refreshTray(); },
        // A paused account named in the tray: Try again brings its agents back.
        // TRY AGAIN for a paused account (Tynn #896, 2b-3): genie-host's accountRetry, named by an agent the provider stopped.
        onAccountRetry: (provider) => {
            const agent = host?.pausedAgents(provider)[0];
            if (!agent) return;
            void ownProtocol.call('accountRetry', [agent]).then((r) => { const why = callRefusal(r); if (why) console.error('[genie] account retry:', why); });
        },
    };
    trayImages = buildTrayImages(trayIconPath());
    tray = createTray(trayHandlers, trayWaiting > 0 ? trayImages.attention : trayImages.plain);
    trayMenuNow = trayMenuTemplate(trayHandlers);
    // THE TRAY PROBE — ONLY for the VM proof (scripts/quit-keeps-host-cdp.mjs, over the main process's inspector), and ONLY
    // in a launch with GENIE_TRAY_PROBE=1 (core/tray-only.ts trayProbeEnabled): every real launch has none. Electron's Tray
    // cannot be asked what it shows, nor clicked from outside: whether it is there, what it says, its menu — and an item's
    // own click, the very handler the menu runs. On the main process's globalThis, which no renderer (context-isolated,
    // sandboxed), no IPC handler, remote method or MCP tool reaches; nothing else in src/ names it (a source guard).
    if (trayProbeEnabled(process.env)) {
        (globalThis as Record<symbol, unknown>)[Symbol.for('genie.tray')] = {
            present: () => tray !== null && !tray.isDestroyed(),
            tooltip: () => trayTooltipNow,
            labels: () => trayMenuNow.map((i) => i.label ?? '-'),
            click: (label: string) => { const item = trayMenuNow.find((i) => i.label === label && i.click); item?.click?.(); return item !== undefined; },
        };
    }
    // GENIE'S APPLICATION MENU (Tynn #759, main/app-menu.ts): without one Electron's default is in force, and its Ctrl+W
    // closes — on this window, hides — Genie from any field. Settings… on Ctrl+, (⌘, on macOS).
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, app.getVersion(), {
        onSettings: () => { revealMainWindow('Settings'); showToPerson({ activation: 'user-gesture', route: 'genie://settings', reason: 'Settings' }); },
        onCheckUpdates: () => { void updates?.check(); },
        onQuit: requestQuit,
        onCloseWindow: () => { (BrowserWindow.getFocusedWindow() ?? window)?.close(); },
        onOpenRepo: () => { void shell.openExternal('https://github.com/Renaissance-Analytics/genie'); },
        // HELP (Tynn #762): Genie's documentation is the Tynn docs site; What's new opens over the page, again.
        onDocs: () => { void shell.openExternal(genieDocsUrl(tynnHost())); },
        onWhatsNew: () => { revealMainWindow('menu: What is new'); showToPerson({ activation: 'user-gesture', route: WHATS_NEW_ROUTE, reason: 'menu: What is new' }); },
        onReportIssue: () => { void shell.openExternal(`https://github.com/Renaissance-Analytics/genie/issues/new?title=${encodeURIComponent(`[v${app.getVersion()}] `)}`); },
    })));
    // THE GENIE BROWSER WINDOW (beta.35 item 36): the same front door and CA, its own session; the sites read at each use.
    cookieBridge = new BrowserCookieBridge({
        call: (method, args) => (agentEngineLink?.live === true ? agentEngineLink.client.browserCall(method, args) : Promise.resolve(null)),
        me: () => browserConnection,
        openStore: (workspaceId) => workspaceBrowserSession({ genieHome: genieRoot(), workspaceId, side: 'window', frontDoorPort: frontDoorNow.port, caPem: frontDoorNow.caPem }).ses,
    });
    watchWorkspaceStores(cookieBridge);
    publishBrowserFacts = () => {
        if (agentEngineLink?.live !== true) return;
        const facts = {
            frontDoorPort: frontDoorNow.port,
            caPem: frontDoorNow.caPem,
            hosts: frontDoorNow.routes.map((r) => r.host),
            workspaceOf: Object.fromEntries(frontDoorNow.sites.map((s) => [s.host.toLowerCase(), s.workspaceId])),
            siteLabels: browserSiteLabels(frontDoorNow.routes.map((r) => r.host), frontDoorNow.sites, Object.fromEntries((registry?.snapshot().workspaces ?? []).map((w) => [w.id, w.name ?? basename(w.path)]))),
            launch: { file: process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--genie-browser', ...process.argv.filter((a) => /^--(no-sandbox|ozone-platform=|password-store=|genie-browser-debug-port=)/.test(a))] },
        };
        void agentEngineLink.client.browserCall('publish', [facts]).catch((error: unknown) => { rendererErrorLog?.(`the browser's facts could not be published: ${error instanceof Error ? error.message : String(error)}`); });
    };
    // A site's or a route's change is said again by frontDoorWatch.onChange, above (Tynn #1046).
    publishBrowserFacts();
    // TRAY-ONLY (P1b): while genie-host runs, one look every few seconds — what the tray says, and whether a tray-only
    // Genie with nothing left running ends (core/tray-only.ts).
    if (agentEngineLink) setInterval(watchTrayOnly, 5_000).unref?.();
}

/** What a (re)built main window needs from boot: set once the services are composed. */
/** The front door's port and Genie's CA as the browser sessions use them now (P5a.2); set once the services are composed. */
let frontDoorNow: FrontDoorWatchView = EMPTY_FRONT_DOOR_WATCH;
let mainWindowDeps: { readonly frontDoorPort: () => number; readonly caPem: () => string | null; readonly routes: ConstructorParameters<typeof BrowserPane>[1]; readonly settings: Parameters<typeof wireCloseToTray>[1]['settings']; readonly pushFeatures: () => void } | null = null;
/** The live site panels (once per process); each main window attached as it is built. */
let livePanels: LiveSitePanels | null = null;

/**
 * THE MAIN WINDOW, BUILT — at boot, and again after "Just close the UI" (P1b) when the person opens Genie from the tray or
 * launches it again. Everything bound to ONE window is bound here, every time: its close (hide to the tray), the OS ending
 * the session, the Genie Browser pane, the site panels. Everything else reads `window` when it runs.
 */
function mountMainWindow(show: boolean, reason = 'launch'): void {
    const deps = mainWindowDeps;
    if (!deps) return;
    window = createWindow(show);
    // TRAY-RESIDENT (core/tray-resident.ts): start minimised keeps the window in the tray at boot; closing it hides it
    // (Windows, Linux) and Genie keeps running — the agents, the terminals, the services. A quit is asked for.
    wireCloseToTray(window, {
        platform: process.platform,
        quitting: () => quit.quitting,
        settings: deps.settings,
        notify: (notice) => {
            if (!Notification.isSupported()) return;
            const n = new Notification({ title: notice.title, body: notice.body });
            n.on('click', () => { revealMainWindow('notification click'); });
            n.show();
        },
    });
    // Windows ends a session (shutdown, restart, sign-out) WITHOUT a before-quit (Electron documents it): quit on the
    // way out so the shutdown runs, without a question nothing could answer.
    window.on('session-end', () => { quit.force(); app.quit(); });
    browserPane = new BrowserPane(electronBrowserView(window, { frontDoorPort: deps.frontDoorPort, caPem: deps.caPem }), deps.routes);
    // What the page did (a link, a redirect, back/forward) is the address bar and the history buttons — pushed, not polled.
    // A hidden pane reports no url; the surface keeps the last page it showed.
    browserPane.onChange((state) => {
        if (state.url === null) return;

        deps.pushFeatures();
    });
    livePanels?.attach(window);
    bringBackItsPage(window);
    if (reason !== 'launch') rendererErrorLog?.(`window built again (${reason}): the same host`);
    refreshTray();
}

/**
 * THE MAIN WINDOW'S PAGE, BROUGHT BACK WHEN IT ENDS (renderer-recovery.ts; the owner's black window of 2026-11-06, an oom
 * with main alive and nothing reloading the page for 3.5 hours). Its memory is sampled for the beat and the crash record;
 * an end reloads it (capped), a reload that throws builds the window again, and past the cap the plain page's two links —
 * Restart Genie, Send a crash report — build the window again here, the same host, the notice kept for its report.
 */
function bringBackItsPage(win: BrowserWindow): void {
    // As soon as the page has loaded (retried until its renderer reads a real value), and on the 5 s tick.
    pageMemory.sample();
    win.webContents.on('did-finish-load', () => { pageMemory.loaded(); });
    const sampler = setInterval(() => { pageMemory.sample(); }, 5_000);
    sampler.unref?.();
    win.on('closed', () => { clearInterval(sampler); });
    const rebuild = (why: string): void => {
        if (window !== win) return;
        window = null;
        try { win.destroy(); } catch { /* gone already */ }
        mountMainWindow(true, why);
    };
    recoverRenderer({
        contents: win.webContents,
        rendererMb: () => pageMemory.mb(),
        onReloaded: (notice) => { rendererNotice = notice; registry?.touch(); windowTunnelNow?.refreshWindow(); },
        onGaveUp: (notice) => { rendererNotice = notice; windowTunnelNow?.refreshWindow(); },
        errorPage: rendererErrorPage,
        recreate: () => { rebuild('renderer recovery: the reload failed'); },
        log: (line) => { rendererErrorLog?.(line); },
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (url !== RECOVER_RESTART && url !== RECOVER_REPORT) return;
        event.preventDefault();
        rebuild(url === RECOVER_REPORT ? 'renderer recovery: Send a crash report' : 'renderer recovery: Restart Genie');
    });
}

// A second launch shows the first one's window — hidden in the tray included. `Genie --quit` is the tray's Quit instead,
// run AFTER this handler returns (core/quit-flag.ts `answerSecondInstance`): its question is a synchronous modal, and
// asked in here it left the asking launch unanswered until it had Genie terminated as hung (exit code 2, no shutdown).
// macOS hands a genie:// URL to the running app as open-url, not as a second launch.
app.on('open-url', (event, url) => {
    event.preventDefault();
    openGenieUrl(url);
});

// THE FOCUS LOG (genie#1235): every time a Genie window takes the keyboard, which one, and the request that came just
// before it — or that none did. The owner's "Genie keeps taking focus" is then one line in the log away from its cause.
app.on('browser-window-focus', (_event, focused) => {
    if (!focused.isDestroyed()) console.log(activationLedger.explain(windowLabelOf(focused.webContents.getURL()), Date.now()));
});

app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    answerSecondInstance(argv, additionalData, { quit: requestQuit, reveal: () => { revealMainWindow('second launch'); }, defer: (run) => { setImmediate(run); }, open: openGenieUrl });
});

/**
 * Every agent session ends with the app, and none is revived on the way out.
 *
 * The NEXT launch starts again exactly the agents that were running at quit (always — there is no
 * setting since 2026-10-20). There is no second branch here that revives anything "because the
 * window went away" — that branch, in a previous build, resurrected eleven agents the owner
 * had deliberately stopped: what the person stopped is not running at quit, so it stays stopped.
 */
/** EVERY SHUTDOWN — a quit or an upgrade — records who comes back, before any session ends (main/shutdown-record.ts). */
function recordShutdownNow(): Promise<unknown> {
    const reg = registry;
    const live = host;
    if (!reg || !live) return Promise.resolve();
    return recordShutdown({
        agents: () => reg.snapshot().agents,
        probe: (id) => live.probe(id),
        pending: () => reg.pendingRestore(),
        markRunningAtQuit: (ids) => reg.markRunningAtQuit(ids),
        markInterruptedAtQuit: (ids) => reg.markInterruptedAtQuit(ids),
    });
}

/** Tailscale on this machine as last read (Tynn #821): at boot and after every Connect or Install. */

app.on('before-quit', (event) => {
    // A launch that never booted (a second instance, a `--quit` with no Genie running) owns nothing to shut down — and
    // clearing the genie-running file below would clear the RUNNING Genie's. It exits without a quit; this is the guard.
    if (launch.kind !== 'boot') return;
    if (quitPreparation !== null) { event.preventDefault(); return; }
    // An install already owns the shutdown/restore record. Its onInstalling callback quits this
    // window once the report is returned at `restarting`, never in the middle of the agent wait.
    const installing = updates?.state();
    if (installing?.phase === 'installing' && installing.installing?.reason !== 'quit' && !updateQuitReady) { event.preventDefault(); return; }
    // QUIT CONFIRMATION (§6.5): defaults to the safe thing. Asked once; a confirmed quit proceeds. The steps and their
    // once-only guarantees are core/quit.ts `quitSequence`; a cancelled quit changes nothing — the window keeps hiding.
    const step = quit.beforeQuit({
        ready: host !== null && registry !== null,
        plan: () => {
            const running = registry!.snapshot().agents.filter((a) => host!.probe(a.id as AgentId)?.running === true).map((a) => a.name);
            // QUIT KEEPS THE HOST (P1b): while genie-host runs them, the agents, terminals and kept processes can outlive this
            // window — the question then has two answers. After an upgrade's drain the host is gone: nothing is kept, as before.
            // The kept processes are counted from genie-host's summary (Tynn #1045, 2g-4d-C).
            return quitPlan({ runningAgents: running, liveTerminals: hostSummaryNow.terminals.length, host: agentEngineLink?.live === true ? { keptProcesses: hostSummaryNow.processes.length, ...onTheClockNow() } : null });
        },
        ask: (plan) => quitAnswer(plan, dialog.showMessageBoxSync({ type: 'question', title: plan.title, message: plan.message, buttons: [...plan.buttons], defaultId: 0, cancelId: 0 })),
    });
    if (step === 'cancel') { event.preventDefault(); return; }
    if (step === 'close-ui') { event.preventDefault(); closeUi('the quit’s answer'); return; }
    crashRecorder.beforeQuit();
    scratchSweepStop?.();
    scratchSweepStop = null;
    // §7.6: remember who was running, BEFORE anything is stopped; the write finishes, then the quit resumes.
    if (step === 'record') {
        event.preventDefault();
        // The window remains responsive: pending names and Quit now use the same progress surface
        // as an upgrade. Record AFTER the wait so only turns actually cut off are resumed.
        revealMainWindow('waiting for agents before quitting');
        quitPreparation = Promise.resolve(updates?.prepareQuit?.())
            .catch((error: unknown) => { console.warn('[quit] safe-point wait failed', error); })
            .then(() => recordShutdownNow())
            .catch(() => { /* an unsaved list means no restore, never a blocked quit */ })
            .finally(() => { quitPreparation = null; app.quit(); });
        return;
    }
    // The shutdown already ran (a second quit request arrived while the running set was being written): nothing twice.
    if (step === 'pass') return;
    // HELD until the sessions' last rows are written (bounded): Electron exits WITHOUT running what is still queued, so
    // a reply the stop closes, or a turn's last row still landing, was lost with its thread's lock file left behind
    // (measured 0 of 20 kept, omarchy-test 2026-10-21). The quit resumes when runQuit is done, as a 'pass'.
    // "Just close the UI" (P1b) stops no agent, closes no terminal and never ends the host: core/quit.ts runQuit.
    event.preventDefault();
    // runQuit runs to its end: the drain bounded inside it, then the host ended, itself bounded (agent-engine.ts). A race
    // around the whole of it let the window exit before the host was told to end (ss-repeat5, 2026-11-05).
    void runQuit(quitPorts, { drainMs: QUIT_WRITES_MS })
        .catch(async () => { try { await updates?.cancelDrain?.(); } catch { /* the host may already be gone */ } })
        // No host: this window was the run, and its clean end writes the marker, last (Tynn #386). With a host: nothing.
        .finally(() => { crashRecorder.cleanQuit(); heartbeatNow?.bye(); app.quit(); });
});

/** How long a quit waits for a killed provider to report its exit — the exit is what queues the reply it closes. */
const QUIT_EXIT_WAIT_MS = 2_000;
/** The whole wait's bound: a quit is never held past it, written or not. */
const QUIT_WRITES_MS = 5_000;

/** What each quit answer does here (core/quit.ts runQuit decides which, and in what order). */
const quitPorts: QuitPorts = {
    // The stops' readings and reaps run off main (genie#1201); the drain below waits for them too, bounded.
    stopAgents: () => { host?.stopAll(); },
    closeWindow: () => {
        // Main's own sampler ends first: on a slow machine its restarts held main for seconds, in a loop with the watchdog
        // (genie-test-windows, job Q0), and a quit needs main for its own steps.
        stallProfiler?.stop();
        // Every supervised process, the front door, an in-flight flow run, the knowledge database.
        void services?.shutdown();
        // The spawn host ends whatever is still running in it (the supervisor's stops above went first, in order), then
        // itself. Over the host's link it is the host's: nothing to end from here.
        void spawnHostNow?.stop();
        localDoor.dispose();
        void filesHost?.close();
        clearGenieRunning(genieRoot());
    },
    drained: () => host?.drained(QUIT_EXIT_WAIT_MS) ?? Promise.resolve(),
    // With the agent host (the host split): its sessions' writes drained, then the host itself ended gracefully.
    shutDownHost: () => agentEngineLink?.shutdown(QUIT_WRITES_MS) ?? Promise.resolve(),
};

// THE LINUX PASSWORD STORE (Tynn #846; Genie 1's genie#379/#588): Chromium picks its secret store from the desktop's
// name and does not know Hyprland (Omarchy) — so safeStorage could encrypt nothing there. Chosen from what owns the
// session bus, or what a previous launch was seen using; BEFORE app-ready, when OSCrypt reads the switch.
applyLinuxPasswordStore({
    platform: process.platform,
    argv: process.argv,
    // An installed-but-not-yet-started Secret Service (Omarchy at login, before any app asked for a secret) is ACTIVATED
    // first, so a Genie that starts at login does not land on the plaintext store (linux-password-store.ts).
    probe: () => probeOwnedBusNames(passwordStoreBusNames(), undefined, { activateSecretService: true }),
    remembered: () => readRememberedPasswordStore(genieRoot()),
    appendSwitch: (key, value) => app.commandLine.appendSwitch(key, value),
});

// THE RIGHT-CLICK MENU AND THE SPELL CHECKER (beta.64, context-menu.ts): every webContents Genie creates — each window,
// the question window, the browser's pages — gets the menu (spelling suggestions, Cut / Copy / Paste / Select all), and
// its session the spell checker in the person's languages. Before any window exists, so none is missed.
app.on('web-contents-created', (_event, contents) => {
    installContextMenu(contents as unknown as MenuWebContents, {
        show: (template) => { const window = BrowserWindow.fromWebContents(contents); Menu.buildFromTemplate(template).popup(window ? { window } : {}); },
        preferredLanguages: () => app.getPreferredSystemLanguages(),
    });
});

// Only a `boot` launch boots — and only `boot()` creates the main window (core/quit-flag.ts `launchDecision`).
if (launch.kind === 'boot') {
    app.whenReady().then(boot).catch((error: unknown) => {
        // A boot failure is shown, not logged to a console nobody is reading. The most likely
        // cause is a store fault — and an unreadable `agents.json` is exactly the case where
        // continuing would overwrite it.
        dialog.showErrorBox('Genie could not start', String(error));
        app.quit();
    });
}

/*
 * TRAY-RESIDENT: the last window closing is not a quit. The main window hides instead of closing (Windows, Linux), and
 * macOS keeps an app without windows running by convention — Genie quits from the tray's Quit, the app menu's Quit, or
 * the OS ending the session. A handler that does nothing is what stops Electron's default quit here.
 */
app.on('window-all-closed', () => { /* Genie stays in the tray */ });

// macOS and Linux announce a shutdown, restart or sign-out: delay it, quit without a question nothing could answer.
// Waking from sleep: a Genie that shows signed out to Tynn asks again (the network is often what was missing).
powerMonitor.on('resume', () => { void handProxyAnswers?.(); if (ownProtocolTunnelled) void ownProtocol.call('tynn.recheck', []); });
powerMonitor.on('shutdown', (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    quit.force();
    app.quit();
});
