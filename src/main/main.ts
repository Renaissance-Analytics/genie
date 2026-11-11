import { createNativeTerminalPort } from './local-terminal-native.js';
import { rosterPruner } from '../core/chat-drafts.js';
import { readTynnBoardChanges, type TynnBoardPorts } from './tynn-board-client.js';
import type { readTynnPage } from './tynn-page-client.js';
import type { BoardScope } from '../core/tynn-board.js';
import { readTynnIssueChanges } from './tynn-issues-client.js';
import type { TynnWatchEvent, TynnWatchKind, TynnWatchPort } from '../core/local-tynn-watch.js';
import { HeadroomFeed, headroomBufferMs } from '../core/headroom-board.js';
import type { Headroom } from '../core/headroom.js';
import { systemRootsPem } from './php-trust-host.js';
import { runServiceExec } from './service-exec.js';
import { MainErrorBook, installMainErrorPolicy, retryHostCopy } from '../core/main-errors.js';
import { forwardRendererConsole } from '../core/render-error.js';
import { siteAnswers } from './port-probe.js';
import { relayWorkstationOf, remoteFromSearch, remoteWindowSearch } from '../core/remote-window.js';
import { takeOverRouteOf } from '../core/take-over-route.js';
import { transportHub, type CallContext } from '../core/remote-protocol.js';
import { agentDetailFor } from './agent-detail.js';
import { listShareLinks, mintShareLink, revokeShareLink } from './tynn-share-links.js';
import { browserConnectionFor } from '../core/browser-connection.js';
import { drivablePages } from './page-navigation-electron.js';
import { isGenHost } from './relay-site.js';
import { connectableWorkstations, setWorkstationRole, type RelayHostStatus } from './tynn-network.js';
import { livenessOf } from '../core/liveness.js';
import { CallerBook, sessionCallerOf } from './mcp-callers.js';
import type { Caller } from './mcp-tools.js';
import { CommsCache } from '../core/comms.js';
import { askerLiveFrom } from './asker-live.js';
import { BrowserWindow, ClipboardItem, Menu, Notification, Tray, app, clipboard, dialog, ipcMain, net, powerMonitor, safeStorage, session, shell } from 'electron';
import { electronClipboardPort, registerClipboardIpc } from './clipboard-ipc.js';
import { localProtocolDoor } from './local-protocol-door.js';
import { guardWindowLinks } from './external-links.js';
import { WHATS_NEW_ROUTE, genieDocsUrl, whatsNewFor } from '../core/whats-new.js';
import { RELEASE_NOTES } from './release-notes.js';
import { appMenuTemplate } from './app-menu.js';
import { realFancyTermPort } from './fancy-term-port.js';
import { TakeOverReplica } from './take-over-replica.js';
import { crashReportHost } from './crash-report-host.js';
import { FilesWindows } from './files-windows.js';
import { availableParallelism, homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asAgentId, asAgentRef, type AgentId, type AgentRecord } from '../core/identity.js';
import type { AgentDetail } from '../renderer/bridge.js';
import type { TimedEvent } from '../core/stream-view.js';
import { AGENT_PUSH_INTERVAL_MS, AgentPush, wireInboxChatUpdates } from './agent-push.js';
import { Coalescer, realSchedule } from '../core/coalesce.js';
import { LatestPush } from '../core/latest-push.js';
import { OS_WORKSPACE, Registry } from './registry.js';
import { readFile } from 'node:fs/promises';
import { agentOpsApi, agentOpsPorts } from './agent-ops-api.js';
import { GENIE_MANAGED_MCP, MCP_RECOVERY_ATTEMPTS, McpRecovery, missingServers, type McpServerReport } from '../core/mcp-missing.js';
import { restartAgent, SettingApplier } from './agent-ops-host.js';
import type { WatchedReposView } from '../core/issue-watch.js';
import { isAcpProvider } from '../core/engine.js';
import { providerChoiceFile, setProviderChoiceFile, writeProviderChoice } from './provider-choice.js';
import { mailAction } from '../core/agent-actions.js';
import { ThingSounds, flowRunSound } from '../core/thing-sounds.js';
import { agentShells } from '../core/agent-shells.js';
import { quitAnswer, quitPlan, quitSequence, runQuit, type QuitPorts } from '../core/quit.js';
import { windowLaunchFlags } from '../core/launch-flags.js';
import { hostDownAnswer, hostDownPlan } from '../core/host-down.js';
import { deckRefusalLine } from '../core/deck-refusal.js';
import { QUIT_DATA, answerSecondInstance, asksToQuit, launchDecision, type LaunchDecision } from '../core/quit-flag.js';
import { ActivationLedger, bringUp, onceShowable, showWhenReady, windowLabelOf, type Activation, type ActivationRequest } from '../core/window-activation.js';
import { viewDelivery, viewReaches, type ViewRequest } from '../core/view-requests.js';
import { genieUrlIn, signInCodeFrom, workstationOpenFrom } from '../core/tynn-sign-in.js';
import { settleStaleLegacyPairing, tynnPairingSource, TynnAccount } from './tynn-account.js';
import { parseTynnProjectInput, TYNN_HOST } from '../core/tynn.js';
import { githubSealedSources, GithubAccount } from './github-account.js';
import type { GithubAccountReplica } from './github-account-replica.js';
import type { RepoListing } from '../core/github.js';
import { readGenie1Identity, workstationSealedSources } from './workstation-identity.js';
import { type WorkstationPort } from './workstation-service.js';
import { applyLinuxPasswordStore, passwordStoreBusNames, probeOwnedBusNames } from './linux-password-store.js';
import { readRememberedPasswordStore, rememberPasswordStore } from './password-store-memo.js';
import { LinuxKeyring, takeResumeSignIn, unlockKeyringBeforeStores } from './linux-keyring.js';
import type { KeyringReplica } from './keyring-replica.js';
import { osCipher } from './os-cipher.js';
import { linkedAgentSecrets, linkedVault } from './agent-secrets.js';
import { reportProxyAnswers } from './proxy-report.js';
import type { SessionEngineClient } from './session-engine-client.js';
import type { TynnAccountReplica } from './tynn-account-replica.js';
import { gatherSources } from './keychain-migration.js';
import type { TynnWorkstationState } from '../renderer/features.js';
import { droneRefusal, outboundDialRefusal, type WorkstationRole } from '../core/workstation-role.js';
import { deviceLinkGate } from './device-link-gate.js';
import { dispatchConnectLink } from '../core/connect-link.js';
import { accountKeyOf, remoteWindowAction, windowsLeftByAccountChange } from '../core/remote-window-policy.js';
import { wordTynnRefusal } from './drone-refusal.js';
import { machineKeyOf, readMachineId } from './machine-key.js';
import { buildHostApi } from './host-api.js';
import { featureOriginOf, HostPicks, isWindowCaller } from './host-picks.js';
import { startForWork, startForYourMessage, type StartForWork } from './start-on-demand.js';
import { addWorkspace as addWorkspaceOp, createWorkspace as createWorkspaceOp, addWorkspaceFromGit, addWorkspaceFromTynn, createTynnProject, listTynnOwners, listTynnProjects, hibernateWorkspace, previewAddFromGit, previewAddFromTynn, previewAddWorkspace, registeredEnvFile, removeWorkspace, startRefusal, wakeWorkspace, type WorkspaceOpsPorts } from './workspace-ops-host.js';
import { nodeWorkspaceFs } from './workspace-fs.js';
import { nodeEnvelopePorts } from './envelope-fs.js';
import { buildEnvelope, discardStaged, readSource, registerExisting, stageFromGit, type EnvelopePorts } from './envelope-wizard-host.js';
import { parseEnvelopePlan } from '../core/envelope-plan.js';
import { mkdir, readdir, readFile as readFileText, writeFile as writeFileText } from 'node:fs/promises';
import { sacredNameOf } from '../core/agent-adoption.js';
import { createAgent, type AgentCreatePorts } from './agent-create-host.js';
import { adoptAgent, readImportedAgents, type AgentAdoptionPorts } from './agent-adoption-host.js';
import { restartWithHandoff } from './restart-with-handoff.js';
import { sweepLeftoverProvidersAsync } from './leftover-sweep.js';
import { openLifecycleLog } from './lifecycle-log.js';
import { StallWatchdog, timeIpcHandlers, watchOutboundCalls } from './stall-watchdog.js';
import { WindowCrashRecorder, startHeartbeat } from './window-crash-recorder.js';
import { RECOVER_REPORT, RECOVER_RESTART, pageMemorySampler, recoverRenderer, rendererErrorPage, type RendererNotice } from './renderer-recovery.js';
import { crashHeader, removeCrashRecord, writeCrashRecord } from './crash-records.js';
import { routeExecThroughSpawnHost, SpawnHostClient } from './spawn-host-client.js';
import type { ListedPty } from './spawn-host-protocol.js';
import * as diagnosticsChannel from 'node:diagnostics_channel';
import { Session as InspectorSession } from 'node:inspector';
import { stallStacksWanted, startStallProfiler } from './stall-profile.js';
import { setPrivateCredentialFailureLog } from './private-credentials.js';
import { systemProcessTree } from '../core/process-tree.js';
import { providerBinary } from './session-host.js';
import { checkProviderHealth, ProviderHealthBook, realProviderHealthPorts } from './provider-health.js';
import { afterSignedIn } from './login-host.js';
import { connectAgentEngine, type AgentEngine, type AgentEngineLink } from './agent-engine.js';
import { hostBuild } from './engine-launch.js';
import { materializeHostRuntime } from './host-runtime.js';
import { LoginHost } from './login-host.js';
import { scheduleScratchSweep, scratchArea } from './scratch-area.js';
import { ScratchTerminals, openScratchTerminal } from './scratch-terminal.js';
import { ACCOUNT_BACK, SIGNED_IN_AGAIN } from '../core/provider-login.js';
import { DESIGN_LOGIN, tellDesignLoginRan } from '../core/design-login.js';
import { PlanKeepalive } from '../core/plan-keepalive.js';
import { ActivityFeeds, activityOfWorkspace } from './activity-feeds.js';
import { PauseAlerts } from '../core/account-pause.js';
import { Store } from './store.js';
import { engineDraftsPort } from './engine-draft-files-client.js';
import { composeWindowServices, type ComposeInput, type WindowServices } from './compose.js';
import { customSoundData, featureSnapshot, handleFeatureAction, toolchainStateFrom, type FeatureState } from './feature-ipc.js';
import { SOUND_FILE_EXTENSIONS } from '../core/custom-sound.js';
import { QuestionWindow } from './question-window.js';
import { electronQuestionWindow } from './question-window-electron.js';
import { readV1Settings } from './v1-settings.js';
import { thisMachineWorkstationIds } from './this-machine.js';
import { readV1Catalog, readV1Knowledge } from './v1-import.js';
import { readV1Inbox } from './v1-inbox.js';
import { planV1Import, v1DefaultAgents } from '../core/v1-import.js';
import { v1Leftovers } from '../core/v1-reap.js';
import { TITLE_BAR_HEIGHT, mainWindowOptions, overlayColorsOk } from '../core/window.js';
import { createTray, loginName, trayImages as buildTrayImages, trayMenuTemplate, trayTooltip, trayUpdate, type TrayHandlers, type TrayItem } from './tray.js';
import { needsYouCount } from '../core/deck.js';
import { limitWords } from '../core/limit-words.js';
import { genieWindowIcon } from './app-identity.js';
import { HIDDEN_ARG, showOnBoot } from '../core/tray-resident.js';
import { onTheClock, trayOnlyStep, trayProbeEnabled, type HostActivity } from '../core/tray-only.js';
import { tableWithin, terminalBusy, trayConfirm, trayConfirmed, type Stopping, type TrayAction } from '../core/tray-confirm.js';
import { panelRestart } from '../core/panel-restart.js';
import { LeftRunningMark } from './left-running.js';
import { wireCloseToTray, wireLoginItem, type LoginItemPort } from './tray-residence.js';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { caddyBinPath, userCaddyCopy } from './caddy-runtime.js';
import { execFileRunner, probeToolsLive, execFileText } from './toolchain-runner.js';
import { latestIndex, runUpdate, type CommandRunner, type LanguageUpdatePorts } from './toolchain-prober.js';
import { planInstall, withProviderHealth, type PackageManager, type Platform } from '../core/toolchain.js';
import { checkAndRepair, detectPackageManager, ensurePhpCaBundle, installTool, nodeToolchainFs, phpCaBundleNow, phpWorkerEnv, preferGenieNode, processEnv, restoreToolchainEnv, toolchainPaths, type ToolchainOpsPorts } from './toolchain-ops.js';
import { listDefaults, nodeLinkFs, restoreDefaultsEnv, setDefault } from './toolchain-defaults.js';
import { applyMachinePath, machinePathStatus, nodeMachinePathFs, removeMachinePath, type MachinePathPorts } from './machine-path.js';
import { defaultPathEntries } from '../core/toolchain-defaults.js';
import { goVersionsRoot, installGoVersion, listGoVersions, managedGo, removeGoVersion, type GoVersionsPorts } from './go-versions.js';
import { installPythonVersion, listPythonVersions, managedPython, pythonVersionsRoot, removePythonVersion, type PythonVersionsPorts } from './python-versions.js';
import { dotnetVersionsRoot, installDotnetVersion, listDotnetVersions, managedDotnet, removeDotnetVersion, type DotnetVersionsPorts } from './dotnet-versions.js';
import { installRustVersion, listRustVersions, managedRust, removeRustVersion, rustVersionsRoot, type RustVersionsPorts } from './rust-versions.js';
import { installRubyVersion, listRubyVersions, managedRuby, removeRubyVersion, rubyVersionsRoot, type RubyVersionsPorts } from './ruby-versions.js';
import { installJavaVersion, javaVersionsRoot, listJavaVersions, managedJava, removeJavaVersion, type JavaVersionsPorts } from './java-versions.js';
import { installNodeVersion, listNodeVersions, managedNode, nodeVersionsRoot, removeNodeVersion, type NodeVersionsPorts } from './node-versions.js';
import { runElevatedBatch, type PrivilegedStep } from './elevate.js';
import { httpFetchOver, installPhpVersion, listPhpVersions, managedPhp, nodePhpVersionsFs, phpVersionsRoot, refreshAllManagedInis, refreshManagedIni, removePhpVersion, resolvePhpCgi, type PhpCaPort, type PhpCgiPorts, type PhpVersionsPorts } from './php-versions.js';
import type { FeaturePorts } from './feature-ipc.js';
import { ProcessScheduler } from './process-scheduler.js';
import { osPidAlive } from './process-supervisor.js';
import type { FeatureData } from '../renderer/features.js';
import { BrowserPane } from './browser-pane.js';
import { electronBrowserView, followFrontDoorInPanes } from './electron-browser-view.js';
import { BrowserCookieBridge } from './browser-cookie-bridge.js';
import { BrowserPagesReplica } from './browser-pages-replica.js';
import type { BrowserPage } from './browser-service.js';
import { rerouteGenieBrowserSession, watchWorkspaceStores, workspaceBrowserSession } from './genie-browser-electron.js';
import { sitePanels, type LiveSitePanels } from './site-panels-electron.js';
import { parseTabs, sitePanelKeys } from '../core/workspace-tabs.js';
import { FEATURE_CHANNELS } from '../renderer/bridge.js';
import type { FeatureAction } from '../renderer/features.js';
import { QUIT_DELAY_MS, UpdateHost } from './updater.js';
import { channelFrom } from '../core/update-channel.js';
import { genieRoot, installDir, osaHomeDir, runtimeDir } from './paths.js';
import { osaHomeFiles, writeOsaHome } from '../core/osa-home.js';
import { omarchyFacts } from './omarchy-skills.js';
import { killProcessAsync, listProcessesAsync } from './process-list.js';
import { RESUME_AFTER_RESTART } from '../core/upgrade-drain.js';
import { restoreAfterRelaunch } from './relaunch-restore.js';
import { WindowSafeMode } from './window-safe-mode.js';
import { windowWake } from './window-wake.js';
import { recordShutdown } from './shutdown-record.js';
import { FilesHost } from './files-host.js';
import { type FilesHubEvent, type FilesWant } from './files-watch-hub.js';
import { FilesTreeKeeper } from './files-tree-keeper.js';
import { fileExporter } from './file-export.js';
import type { EditorBytesDeps } from './plugin-editor-bytes.js';
import { removeSavedScrollback } from './saved-scrollback.js';
import { addRepoTo, commitsSinceIn, listReposOf, relocateRepoIn, removeRepoFrom, removeRepoLockOf } from './repo-ops-host.js';
import { workspaceSettingsOps } from './workspace-reads-api.js';
import { workspaceTynnApi } from './workspace-tynn-api.js';
import { workspaceLifecycleApi, workspaceLifecyclePorts, type WorkspaceLifecycleWiring } from './workspace-lifecycle-api.js';
import { HUMAN, agentCapFrom } from '../core/inbox.js';
import { fileEventsOf } from '../core/files-panel.js';
import { remoteAccess } from './remote-access.js';
import { ensureFirewallRule } from './remote-firewall.js';
import { getTailscaleStatus, installTailscale, tailscaleUp, type TailscaleStatus } from './tailscale-cli.js';
import { uploadSender } from './uploads.js';
import { gitAddSubmodule, gitClone, gitFileStatus, gitPushMain, gitSetOrigin, gitShowHead, gitTreeStatus } from './git-ports.js';
import { parseRemoteChoice, type RemoteChoice } from '../core/agi-remote.js';
import { withActionSignal } from './mcp-signal.js';
import type { Verification } from './mcp-server.js';
import { hostOnly, windowToolRunner, withHostTools } from './window-tools.js';
import type { TerminalsApi } from './terminals-host.js';
import type { ProcessBookApi } from './processes-host.js';
import { workspaceNameFor } from './workspace-names.js';
import { HostRegistryStore } from './agent-stores-replica.js';
import type { ForwardedToolCall } from './mcp-host-tools.js';
import type { WindowView } from './host-mcp.js';
import type { McpToolResult } from '@particle-academy/prism-mcp';
import type { InboxStore } from './inbox-store.js';
import type { AttentionStore } from './attention-store.js';
import type { KnowledgeStore } from './knowledge-store.js';
import { allGenieTools } from './mcp-registrations.js';
import { FlowCallers, createFlowToolCaller } from './flow-tools.js';
import type { GAppBookApi, GAppsApi } from '../core/gapps.js';
import { gappWindowsElectron } from './gapp-windows-electron.js';
import { genieToolDeps, toolRoster } from './genie-tool-deps.js';
import { terminalEnvFor, type OpenInBrowser } from './hosting-actions.js';
import { clearGenieRunning, markGenieRunning } from './genie-running-file.js';
import { artboardReadFiles, artboardReview, repoCall, type PanelsHostDeps } from './official-panels-host.js';
import { REMOTE_PORT } from '../core/tailscale.js';
import type { AppInboxReplica } from './app-inbox-host.js';
import { type AppSourceKind } from '../core/app-inbox.js';
import type { IssueWatchRefreshAnswer } from './issue-watch-client.js';
import { IssueWatchReplica } from './issue-watch-replica.js';
import { WorkspaceColors } from './workspace-color-host.js';
import { nodeEnvelopeFs } from './envelope-sites-host.js';
import { nestGoverned } from '../core/rail-view.js';
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
/** Make genie-host's copy again, for the Deck item's Try again (Tynn #693): its error, or `null` when it is made. Set at boot. */
let remakeHostCopy: () => Promise<string | null> = async () => 'Genie has not finished starting; try again in a moment';
installMainErrorPolicy(process, mainErrors);

const here = fileURLToPath(new URL('.', import.meta.url));

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
/** The interactive terminals' spawn host (the host split, P2.1): genie-host's `terminals` child; null = this process's engine. */
let spawnTerminalsNow: SpawnHostClient | null = null;
/** Live ptys a previous window started, found under genie-host at boot: the terminals' to adopt (supervised processes are the host's own since P3.3b). */
let adoptablePtys: ListedPty[] = [];
const stallWatchdog = new StallWatchdog({
    log: (line) => stallLog?.(line),
    onMainStall: (ms) => stallProfiler?.capture(ms),
    routeOf: () => {
        const url = window && !window.isDestroyed() ? window.webContents.getURL() : '';
        const at = url.indexOf('#');
        return at === -1 ? null : url.slice(at + 1);
    },
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
    const processes = (services?.supervisor.list() ?? []).filter((p) => p.state === 'running' || p.state === 'restarting').length;
    const servicesUp = (services?.engines.list() ?? []).filter((e) => e.active).length;
    return { agents, terminals: terminals?.count ?? 0, processes, services: servicesUp, ...onTheClockNow(), browser: browserLinked ? 1 : 0 };
}

/** What waits on the host's clock, from the host's own lists (core/tray-only.ts). With no host, nothing here outlives the window. */
function onTheClockNow(): { armedFlows: number; scheduledTasks: number } {
    if (agentEngineLink?.live !== true) return { armedFlows: 0, scheduledTasks: 0 };
    return onTheClock(agentEngineLink.client.flows().list(), agentEngineLink.client.processBook().kept());
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
    const terminalsOpen = (terminals?.list() ?? []).map((t) => {
        const n = (seen.get(t.workspaceId) ?? 0) + 1;
        seen.set(t.workspaceId, n);
        const ws = workspaces.find((w) => w.id === t.workspaceId);
        return { name: `${ws ? basename(ws.path) : t.workspaceId} · terminal ${n}`, busy: terminalBusy(t.pid, table) };
    });
    const processes = (services?.supervisor.list() ?? []).filter((p) => p.state === 'running' || p.state === 'restarting').map((p) => p.name);
    const servicesUp = (services?.engines.list() ?? []).filter((e) => e.active).map((e) => `${e.engine} ${e.version}`);
    const sites = (services?.routes() ?? []).map((r) => r.host);
    const clockFlows = agentEngineLink?.live === true ? agentEngineLink.client.flows().list().filter((f) => f.armed).map((f) => f.name) : [];
    const clockTasks = agentEngineLink?.live === true ? agentEngineLink.client.processBook().kept().filter((p) => p.wanted && p.schedule).map((p) => p.name) : [];
    return { agents, terminals: terminalsOpen, processes, services: servicesUp, sites, flows: clockFlows, scheduled: clockTasks };
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

const mcpRecovery = new McpRecovery();
const mcpRecheck = new Map<string, ReturnType<typeof setTimeout>>();
/** The latest report per agent: a spaced recheck acts on what is true THEN, never on the report that scheduled it. */
const mcpLatest = new Map<string, readonly McpServerReport[]>();
/** Set where the agent operations are built: a graceful restart on the same conversation. */
let restartForMcp: ((agentId: AgentId) => Promise<void>) | null = null;
function recoverMissingMcp(agentId: AgentId, reports: readonly McpServerReport[]): void {
    mcpLatest.set(agentId, reports);
    const missing = missingServers(reports, GENIE_MANAGED_MCP);
    if (missing.length === 0) {
        mcpRecovery.healthy(agentId);
        const pending = mcpRecheck.get(agentId);
        if (pending) { clearTimeout(pending); mcpRecheck.delete(agentId); }
        return;
    }
    const said = missing.map((m) => `${m.name} (${m.why})`).join(', ');
    const decision = mcpRecovery.decide(agentId, Date.now());
    if (decision.action === 'restart') {
        host?.notice(agentId, `This session came up without ${said}. Genie is restarting it on the same conversation to reconnect (attempt ${decision.attempt} of ${MCP_RECOVERY_ATTEMPTS}).`);
        void restartForMcp?.(agentId);
    } else if (decision.action === 'wait') {
        if (!mcpRecheck.has(agentId)) mcpRecheck.set(agentId, setTimeout(() => { mcpRecheck.delete(agentId); recoverMissingMcp(agentId, mcpLatest.get(agentId) ?? []); }, Math.max(0, decision.untilMs - Date.now())));
    } else if (decision.action === 'give-up') {
        host?.notice(agentId, `Still without ${said} after ${decision.attempts} restarts. Genie has stopped retrying; restart this agent once the server answers.`);
    }
}

/**
 * TYNN IS BACK (genie#1234). An agent in a Tynn-linked workspace starts without its `tynn` server when Genie is signed
 * out or Tynn is unreachable; when the account signs in, the agents that went without it — and any whose unverified stored
 * key Tynn now refuses — are restarted on the same conversation (the graceful restart `restartForMcp` uses), so nobody
 * has to restart them or Genie. One recovery at a time: two quick account changes must not restart an agent twice.
 */
let tynnRecovering = false;
function recoverTynnAgents(asked: { secretsMoved?: boolean } = {}): void {
    if (tynnRecovering || !services || (!asked.secretsMoved && !tynnAccount?.status().signedIn)) return;
    // With a host, the host hears the account itself and restarts its own agents, with or without this window (host-tynn-recovery.ts). All it
    // cannot hear is that this window's one-time move has finished.
    if (!agentEngineLink || !asked.secretsMoved) return;
    tynnRecovering = true;
    const named = agentEngineLink.client.tynn().recovery(asked);
    void named.then((ids) => {
        for (const id of ids) {
            if (!host?.probe(id as AgentId)) continue;
            host?.notice(id as AgentId, 'Tynn is available again. Genie is restarting this session on the same conversation to bring its Tynn tools up to date.');
            void restartForMcp?.(id as AgentId);
        }
    }).catch((error: unknown) => {
        console.error(`[tynn] agents could not be brought back to Tynn: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { tynnRecovering = false; });
}

/** Each provider's rate limit as the Dashboard header shows it, buffered (core/headroom-board.ts). */
const headroomFeed = new HeadroomFeed(() => headroomBufferMs(services?.settings.snapshot() ?? {}));

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

/** `Try again` for a paused login (set where the agent operations are built): every agent it stopped, brought back. */
let retryPausedAccount: ((provider: string) => void) | null = null;
/** The automatic update checks (§7, genie2#91): stopped on quit so no check fires into a closing app. */
let registry: Registry | null = null;
/** Each workspace's colour (genie#1300): read from and written to its project.json. */
let workspaceColors: WorkspaceColors | null = null;
/**
 * ISSUEWATCH (Tynn #806; the host split, P5c): genie-host hears Tynn and holds the state — the latest entry per project,
 * when it arrived, what happened lately, the repo switches, the client's state. This window reads it through the replica
 * (issue-watch-replica.ts): what `checkIssues`, imDone's count line and the GitHub panel read for a workspace (its
 * project.json `tynn.projectId`).
 */
let issueWatchNow: IssueWatchReplica | null = null;
/** A workspace's Tynn project, from its project.json `tynn.projectId`; `null` = not linked. */
/** The Tynn tab's door (genie#1295): the pairing's request, the workspace's own project, nothing else. */
function tynnBoardPorts(): TynnBoardPorts {
    return {
        signedIn: () => tynnAccount?.status().signedIn === true,
        projectFor: (workspaceId) => tynnProjectFor(workspaceId),
        request: (path, init) => {
            if (!tynnAccount) return Promise.reject(new Error('Sign in to Tynn first'));
            return tynnAccount.request(path, init);
        },
    };
}
/** The window delegates page reads to genie-host. */
async function readWorkspaceTynnPage(workspaceId: string, page: unknown, query: unknown): ReturnType<typeof readTynnPage> {
    if (!agentEngineLink) return { ok: false, state: 'error', reason: 'Genie’s host is not connected' };
    return agentEngineLink.client.tynnPage(workspaceId, page, query);
}
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
/**
 * THE NEW AGENT FORM ON THIS HOST (main/agent-create-host.ts): the local window's `genie:add-agent` and a remote window's
 * `addAgent` both land here — the AGENT.md written under the workspace, then the agent registered on it.
 */
function agentCreatePorts(): AgentCreatePorts {
    return {
        workspace: (id) => registry?.workspace(id) ?? null,
        agentsOf: (id) => registry?.agentsOf(id) ?? [],
        exists: async (path) => existsSync(path),
        mkdirp: async (dir) => { await mkdir(dir, { recursive: true }); },
        writeText: async (path, text) => { await writeFileText(path, text, 'utf8'); },
        register: async (input) => { const record = await registry!.register(input); return { id: record.id, name: record.name }; },
        sacredName: async (workspaceId) => {
            const projectId = tynnProjectFor(workspaceId);
            if (projectId === null || !tynnAccount) return null;
            return sacredNameOf(await tynnAccount.projects(), projectId);
        },
    };
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
let terminals: TerminalsApi | null = null;
/** `Log in to <provider>` (#967): the login window, reached from the Agent view, the chat and the tray. */
let loginHost: LoginHost | null = null;
/** Stops the deferred sweep of old scratch folders (scratch-area.ts); called on quit. */
let scratchSweepStop: (() => void) | null = null;
let filesHost: FilesHost | null = null;
/**
 * THE FILE WATCHER'S VIEWS (the host split, P2.2; plan §11b): genie-host's hub over the engine link, or — only when no host
 * could start — a hub of this window's own. The local protocol owns every renderer view's registration.
 */
let filesWatch: { watch(viewId: string, workspace: { id: string; path: string }, want: FilesWant): boolean | Promise<boolean>; unwatch(viewId: string): void; close(): void } | null = null;
const filesEventListeners = new Set<(event: FilesHubEvent) => void>();
/** genie-host's, read through its replica. */
let takeOvers: TakeOverReplica | null = null;
/** This workstation's Tynn identity, once known: a crash report is sent with its host proof (Tynn #386 part 4). */
let crashReportMachine: WorkstationPort | null = null;
/** The workspace header's throwaway terminals (Tynn story #378): each in its own window, closed with it. */
let scratchTerminals: ScratchTerminals | null = null;
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
/** The plan keepalive (core/plan-keepalive.ts), so the quit sequence can stop a nudge waiting out its grace. */
let keepaliveNow: PlanKeepalive | null = null;
/** Every agent's activity feed (core/activity-feed.ts): what the workspace Dashboard's lanes draw (beta.33 item 10). */
let activityFeeds: ActivityFeeds | null = null;

/**
 * Has Genie heard the roster and the session host ONCE? Until then a question's agent cannot be judged: "we have not
 * heard" is not "it is gone", so the Deck marks nothing stale (`askerLive` answers `undefined`). Set after the
 * registry's first load, when the session host already exists.
 */
let askerLivenessKnown = false;
/** The Dashboard's comms cell (§4.1): AgentInbox traffic since the session started, bounded to the newest 2000 mails. */
const dashboardComms = new CommsCache((agentId) => (services ? services.inbox.involving(agentId as AgentId, 2000) : null));
/** A model or tool-setting change waiting for its agent to be free (`SettingApplier`); set where the agent ops are built. */
let settingApplier: SettingApplier | null = null;
/** The updater as this window reads and drives it: genie-host's, through a replica (P5b). */
let updates: Pick<UpdateHost, 'state' | 'check' | 'download' | 'install' | 'refreshNotes' | 'onChange' | 'setChannel'> | null = null;
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
function openTakeOverWindow(route: string, activation: Activation): void {
    const terminalId = route.split('/').pop() ?? '';
    const request = { activation, reason: `take-over window ${route}`, ledger: activationLedger, label: 'takeover' };
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && !remoteTakeOverWindows.has(w) && w.webContents.getURL().endsWith(`#${route}`)) { bringUp(w, request); return; }
    }
    const win = takeOverWindow(route, request, null);
    win.on('closed', () => {
        takeOvers?.windowClosed(terminalId);
        scratchTerminals?.windowClosed(terminalId);
    });
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
    void win.loadFile(join(here, '../renderer/index.html'), remote ? { search: remote.search, hash: route } : { hash: route });
    return win;
}

/**
 * TAKE OVER (§1): the agent's TUI in a workspace terminal. `window: true` is this machine's click, with a window here;
 * `window: false` is another machine's (Tynn #529 part A), whose own Take Over window attaches over the link.
 */
async function takeOverHere(raw: unknown, options: { window: boolean }): Promise<{ ok: true; terminalId: string; started?: boolean } | { ok: false; reason: string }> {
    if (!takeOvers || typeof raw !== 'string') return { ok: false, reason: 'No agent named.' };
    // genie-host decides and starts it (Tynn #553); only the window, if one is wanted here, is this process's to open.
    const started = await takeOvers.start(raw);
    if (started.ok && options.window) openTakeOverWindow(`genie://takeover/${started.terminalId}`, 'user-gesture');
    return started;
}

/**
 * ANOTHER MACHINE'S TERMINAL IN A TAKE OVER WINDOW HERE (Tynn #529 part A). The window driving that machine was answered
 * Take over with the terminal and a TICKET; this window connects to the same machine as that window's companion, with the
 * ticket. The ticket is a credential for one terminal: it is kept in main's own map for this window, never in its URL,
 * its title or a log, and the window reads it once.
 */
const takeOverTickets = new Map<number, string>();
const remoteTakeOverWindows = new Set<BrowserWindow>();
function openRemoteTakeOverWindow(url: string, terminalId: string, ticket: string, name: string | null): void {
    const search = remoteWindowSearch(url, name);
    if (remoteFromSearch(search) === null) return;
    const route = takeOverRouteOf(terminalId);
    const request = { activation: 'user-gesture' as const, reason: `remote take-over window ${route}`, ledger: activationLedger, label: 'takeover' };
    takeOverWindow(route, request, { search, ticket });
}

/** THE FILE PANEL IN ITS OWN WINDOW (§4.3): one per workspace; the route names it. Closing it docks the panel back. */
function openFilesWindow(route: string, activation: Activation): void {
    const workspaceId = route.split('/').pop() ?? '';
    const request = { activation, reason: `files window ${route}`, ledger: activationLedger, label: 'files' };
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.webContents.getURL().endsWith(`#${route}`)) { bringUp(w, request); return; }
    }
    const win = new BrowserWindow({
        width: 960,
        height: 720,
        ...genieWindowIcon(here),
        backgroundColor: '#0a0a0c',
        show: false,
        webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // Links open in the browser (http(s) only), never in a Genie window (Tynn #763, main/external-links.ts).
    localDoor.admit(win.webContents);
    guardWindowLinks(win.webContents, (url) => { void shell.openExternal(url).catch(() => {}); });
    onceShowable(win, process.platform, () => showWhenReady(win, request));
    win.on('closed', () => filesWindows?.windowClosed(workspaceId));
    void win.loadFile(join(here, '../renderer/index.html'), { hash: route });
}

/**
 * THE FLOW EDITOR IN ITS OWN WINDOW (genie#1204; Genie 1's genie#505 — its editor first lived in a modal card that clipped
 * the canvas). A real, resizable window per flow, whose whole client area is the canvas; opening a flow already open
 * brings its window up. A new flow's window moves to the flow's own route on its first save.
 */
function openFlowEditorWindow(route: string, activation: Activation): void {
    const request = { activation, reason: `flow editor ${route}`, ledger: activationLedger, label: 'flow' };
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.webContents.getURL().endsWith(`#${route}`)) { bringUp(w, request); return; }
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
    void win.loadFile(join(here, '../renderer/index.html'), { hash: route });
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
            if (theRegistry.defaultAgentOf(workspaceId) !== null) continue;
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
    void win.loadFile(join(here, '../renderer/index.html'), search ? { search } : undefined);
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
const hostPicks = new HostPicks();
/** The Tynn account each relay window was opened under (accountKeyOf). */
const remoteWindowAccount = new Map<BrowserWindow, string | null>();
const tynnAccountKeyNow = (): string | null => { const status = tynnAccount?.status(); return status ? accountKeyOf(status) : null; };
const relayLiveFor = (win: BrowserWindow): boolean => [...linkedRelays.values()].some((c) => c.sender === win.webContents);
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
        relay: relayWorkstationOf(url) !== null,
        live: exists && relayLiveFor(open),
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
let tynnAccount: TynnAccount | TynnAccountReplica | null = null;
/** This Genie's GitHub sign-in (main/github-account.ts, beta.33 item 25): Genie 1's carried over, or the device flow. */
let githubAccount: GithubAccount | GithubAccountReplica | null = null;
/** Linux: the keyring card (linux-keyring.ts) — null off Linux. Opened before the Tynn account, which refuses without it. */
let keyring: LinuxKeyring | KeyringReplica | null = null;
/** Late-bound: a move of this machine's key that finishes lets it register with what it has. */
let registerWorkstationNow: (() => Promise<void>) | null = null;
/** This machine on the Tynn network (Tynn #836): registered, or why not; `null` until first read. */
let tynnWorkstationNow: TynnWorkstationState | null = null;
/** Every Tynn workstation id this machine holds (this-machine.ts); replaced once the identity store is open. */
let thisMachineIds: () => Promise<ReadonlySet<string>> = () => Promise.resolve(new Set(tynnWorkstationNow?.registered ? [tynnWorkstationNow.workstationId] : []));
/** What Tynn says this machine is (genie#1278 W5): read from Tynn, kept in memory only, never from a file or setting. */
// A drone until Tynn's first answer (fail closed); signed out, the first read makes it null (not on the Tynn network).
let workstationRoleNow: WorkstationRole | null = 'drone';
/** What Tynn answered (`null` = not yet): tells a drone from "not known", which asks Tynn again before refusing. */
let workstationSaidNow: WorkstationRole | null = null;
/** Why the role is not known, when genie-host knows (not registered, a sign-in Tynn has not bound): the refusal's words. */
let workstationWhyNow: string | null = null;
/** Read this machine's role from Tynn again (set where the reader is built). */
let readWorkstationRoleNow: (() => Promise<void>) | null = null;
/** Tynn refused this caller: read the role again FIRST, then word the refusal from it (genie#1278, M0 finding 3). */
const rereadRole = async (): Promise<WorkstationRole | null> => { await readWorkstationRoleNow?.(); return workstationRoleNow; };
/** Re-applies the relay host after the remote-access switch moves (set once the Tynn account is open). */
/** This Genie on the Tynn relay as a host (Tynn #838): `null` = not started (remote access off, or not registered). */
let relayStatusNow: RelayHostStatus = { state: 'off' };
/** A window's connection to a Tynn workstation (Tynn #837), by the channel it was given; main alone holds it. */
/** A secret's move, said where it can be read afterwards: names and states, never a value. */
const keychainLog = (line: string): void => { console.error(`[keychain] ${line}`); try { openLifecycleLog(runtimeDir(genieRoot()))(`keychain ${line}`); } catch { /* the console has it */ } };
/**
 * A window's connection to a Tynn workstation that GENIE-HOST holds (Tynn #552, P5d.4; audit M-e): the grant, the key and
 * the relay member are the host's; this window has the channel.
 */
const linkedRelays = new Map<string, { sender: Electron.WebContents; workstationId: string }>();
/** The sockets to other machines the host holds for each window (genie:device-open). */
const deviceChannels = new Map<string, Electron.WebContents>();
let pendingGenieUrl: string | null = genieUrlIn(process.argv);
let afterTynnUrl: (() => void) | null = null;

function registerGenieProtocol(): void {
    // The entry path must be absolute for a dev launch (`electron .`), or the OS resolves it against its own cwd.
    if (process.defaultApp) {
        if (process.argv.length >= 2 && process.argv[1]) app.setAsDefaultProtocolClient('genie', process.execPath, [resolvePath(process.argv[1])]);
    } else {
        app.setAsDefaultProtocolClient('genie');
    }
}

function openGenieUrl(url: string): void {
    if (!tynnAccount) { pendingGenieUrl = url; return; }
    // A Tynn share link, opened (Tynn #839): Tynn's page opens genie://workstation/open?id=… — its window, over the relay.
    const workstation = workstationOpenFrom(url);
    if (workstation) { openRemoteWindow(`relay:${workstation.id}`, workstation.name); return; }
    if (signInCodeFrom(url) === null) { console.log('[genie] a genie:// URL Genie does not handle was ignored'); return; }
    revealMainWindow('genie:// sign-in link');
    void tynnAccount.signIn(url).then((r) => {
        featureState = { ...featureState, tynnSignInUrl: r.ok ? null : featureState.tynnSignInUrl ?? null, tynnMessage: r.ok ? null : r.reason };
        afterTynnUrl?.();
    });
}

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

function detailFor(agentId: AgentId): AgentDetail | null {
    // One builder for the window and genie-host (Tynn #551): a phone sees the same agent whichever answered.
    return agentDetailFor({
        registry: { find: (id) => registry?.find(id) ?? null, listAgents: () => registry?.listAgents() ?? [], defaultAgentOf: (id) => registry?.defaultAgentOf(id) ?? null },
        engine: host,
        cwdFor,
        takeOver: (id) => takeOvers?.probe(id) ?? null,
        providerSignedIn: (provider) => providerHealth.signedIn(provider),
        ...(services ? { mail: (id: AgentId, limit: number) => services!.inbox.involving(id, limit) } : {}),
    }, agentId);
}

/**
 * AN AGENT'S DETAIL TO THE WINDOW — only for the agents it shows, at most every AGENT_PUSH_INTERVAL_MS, and only the rows
 * that changed (main/agent-push.ts; the owner, 2026-10-20: "severe UI lag like 3 seconds to show any text at all").
 * One channel per agent, so a ledger is never broadcast to a renderer looking elsewhere.
 */
const agentPush = new AgentPush<AgentDetail, TimedEvent>({
    detailFor: (agentId) => detailFor(agentId as AgentId),
    send: (agentId, payload) => { if (window && !window.isDestroyed()) window.webContents.send(`genie:agent-changed:${agentId}`, payload); },
    schedule: realSchedule,
    now: () => Date.now(),
});

function pushAgent(agentId: AgentId): void {
    agentPush.changed(agentId);
}

/** Narrow an id from the renderer. A refusal, never a repair — see the note in `open-agent`. */
function agentFromRenderer(raw: unknown): AgentRecord | null {
    // A minted id, or the OS agent's name (the rail's `genie://agent/genie`); the registry resolves the name.
    const id = typeof raw === 'string' ? asAgentRef(raw) : null;
    return id ? registry?.find(id as AgentId) ?? null : null;
}

let services: WindowServices | null = null;
/** Settles when the services are composed: an agent's launch asks them about its workspace first. */
let servicesComposed: (value: WindowServices) => void = () => {};
const composedServices = new Promise<WindowServices>((resolve) => { servicesComposed = resolve; });
/** The same, for what must answer at once. Until then nothing is trusted. */
let composedNow: WindowServices | null = null;
// What the boot probe of genie-host's MCP server said (§6.4 "native transport verified at boot").
let mcpVerified: Verification | null = null;
/** Genie's MCP endpoint: genie-host serves it (P3.1). */
let hostMcpEndpoint: { url: string; token: string } | null = null;
const mcpEndpointNow = (): { url: string; token: string } | null => hostMcpEndpoint;
/** Tell genie-host what its MCP server needs of this window (P3.1), coalesced; a no-op until the tools are built. */
let pushHostView: () => void = () => {};
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
const mcpEnv = (): Record<string, string> => { const e = mcpEndpointNow(); return e ? { GENIE_MCP_URL: e.url, GENIE_MCP_TOKEN: e.token } : {}; };
let browserPane: BrowserPane | null = null;
/** Installed apps' windows (Tynn #595): this process opens them, on sessions the host mints. */
let gappWindowsNow: ReturnType<typeof gappWindowsElectron> | null = null;
/** Who to tell when the host's GApp book changes (Tynn #596): this window's pages, through whichever link is up. */
const gappsChangedListeners = new Set<() => void>();
let offGappsChanged: (() => void) | null = null;
function followGappsChanged(client: { onGappsChanged(listener: () => void): () => void }): void {
    const tell = () => { for (const listener of [...gappsChangedListeners]) listener(); };
    offGappsChanged?.();
    offGappsChanged = client.onGappsChanged(tell);
    tell(); // A new link may have missed changes.
}
function withGappWindows(client: { gapps(): GAppBookApi } | undefined): GAppsApi | null {
    if (!client) return null;
    return {
        ...client.gapps(),
        open: async (id) => { if (!gappWindowsNow) throw new Error('Genie is still starting; try again in a moment.'); await gappWindowsNow.open(id); },
        preview: async (id) => { if (!gappWindowsNow) throw new Error('Genie is still starting; try again in a moment.'); await gappWindowsNow.open(id, { preview: true }); },
        onChanged: (listener) => { gappsChangedListeners.add(listener); return () => { gappsChangedListeners.delete(listener); }; },
    };
}
/**
 * THE GENIE BROWSER IS ITS OWN PROCESS (the host split, P2b), asked through the host, which starts it. This window builds no
 * browser window, for this machine's sites or another workstation's (Tynn #585). The site panels are webviews here by design.
 */
function askBrowser(args: readonly unknown[]): Promise<{ ok: true } | { ok: false; error: string }> {
    if (agentEngineLink?.live !== true) return Promise.resolve({ ok: false as const, error: 'Genie’s host is not connected' });
    return agentEngineLink.client.browserCall('open', args).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
}
const openLocalBrowser = (url: string | undefined, activation: Activation) => askBrowser([url ?? null, activation]);
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
/** Every toolchain and PHP download. */
const httpFetch = httpFetchOver((url, init) => net.fetch(url, init));

const latestFor = latestIndex({ run: execFileRunner, fetchJson: async (url) => (await net.fetch(url)).json(), platform: process.platform as Platform });

/** The package manager that actually ANSWERS on this machine (apt or dnf on Linux), asked once per run. */
let detectedPackageManager: Promise<PackageManager | null> | null = null;
const packageManager = (): Promise<PackageManager | null> => (detectedPackageManager ??= detectPackageManager(process.platform as Platform, execFileRunner));
/** Installs and updates take minutes (winget, a polkit prompt waiting on the person); the probe's 20 s would cut them off. */
const longRunner: CommandRunner = (binary, args, options) => execFileRunner(binary, args, { timeoutMs: 30 * 60_000, ...(options?.env ? { env: options.env } : {}) });
/** Each provider CLI, measured (Tynn #698): what this process's "installed" and "signed in" read, and the Toolchain's agent rows. */
const providerHealth = new ProviderHealthBook((provider) => checkProviderHealth(provider, realProviderHealthPorts(execFileRunner)));
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
let featureState: FeatureState = { toolStatuses: null, knowledgeQuery: '' };
/** The ForceTheQuestion window's controller (question-window.ts); set once the services are composed. */
let questionWindow: QuestionWindow | null = null;
/** Who else wants the feature snapshot on change: the remote host's event stream. */
const featureListeners = new Set<(data: FeatureData) => void>();

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
    let colorPassAt = 0;
    let colorPassQueued = false;
    theRegistry.subscribe((snapshot) => {
        const ws = snapshot.workspaces;
        if (!ws || colorPassQueued) return;
        if (ws.every((w) => w.color) && Date.now() - colorPassAt < 5_000) return;
        colorPassQueued = true;
        setTimeout(() => {
            colorPassQueued = false;
            colorPassAt = Date.now();
            // The rail's order — governed workspaces under their governor — so the colours beside each other differ.
            const current = theRegistry.snapshot().workspaces ?? [];
            const order = nestGoverned(current, (id) => current.find((w) => w.id === id)?.governedBy ?? null);
            void colors.ensure(order.map((w) => ({ id: w.id, path: w.path }))).catch((error: unknown) => console.warn(`[genie] workspace colours: ${error instanceof Error ? error.message : String(error)}`));
        }, 0);
    });
    // AN AUTOMATED AGENT WITH AN OPEN PLAN DOES NOT JUST STOP (the owner, 2026-10-21; core/plan-keepalive.ts): a turn that
    // ends with steps left is nudged once after a short grace — never while the person is the next move.
    const keepalive = new PlanKeepalive({
        graceMs: 5_000,
        schedule: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
        read: (id) => {
            const record = registry?.find(id as AgentId);
            const live = host?.probe(id as AgentId) ?? null;
            if (!record || !live) return null;
            const asked = services?.attention.pending().some((q) => q.agentId === id) ?? false;
            return { mode: record.mode, lastTurnEnd: host?.lastTurnEnd(id as AgentId) ?? null, plan: live.plan ?? null, promptable: host?.promptable(id as AgentId) != null, waitingOnPerson: asked || live.pendingApproval !== null, background: live.background ?? null };
        },
        prompt: (id, text) => { host?.prompt(id as AgentId, text, 'genie'); },
        stalled: (id, text) => { host?.notice(id as AgentId, text); },
    });
    keepaliveNow = keepalive;
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
        onAction: (agentId: AgentId, kind: string) => { broadcast('genie:action', { agentId, kind }); if (kind === 'replied') keepalive.turnEnded(agentId); },
        // THE DASHBOARD HEADER'S RATE LIMITS: a reading inside its provider's buffer (the host setting) is ignored here, in
        // main — one comparison, nothing pushed; one that clears it is pushed once, to every window.
        onHeadroom: (provider: string, room: Headroom) => headroomFeed.offer(provider, room),
        // A SERVER GENIE GAVE THE AGENT CAME UP UNUSABLE (genie#1202): Tynn's tools/list timed out at a restart and the CLI
        // never asked again. No documented reconnect exists, so the session restarts on the same conversation — spaced,
        // and given up on in words after MCP_RECOVERY_ATTEMPTS, so a server that is really down never makes it loop.
        onMcpServers: (agentId: AgentId, reports: readonly McpServerReport[]) => {
            recoverMissingMcp(agentId, reports);
            // Kept on the agent's record, so its Settings can list its servers while it is not running (Tynn #628).
            void registry?.noteMcpSeen(agentId, reports.map((r) => r.name)).catch(() => undefined);
        },
        // Each agent starts with its workspace's managed-service variables, by allow-list (the owner, 2026-10-16).
        serviceEnvFor: (workspaceId: string) => services?.engines.envFor(workspaceId) ?? {},
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
        // A REMOTE METHOD GENIE-HOST DOES NOT OWN YET (Tynn #409): done here, by this window's own host API.
        onRemoteInvoke: (method: string, args: unknown[], context: CallContext) => (remoteApiNow ? remoteApiNow.invoke(method as Parameters<ReturnType<typeof buildHostApi>['invoke']>[0], args, context) : Promise.reject(new Error('Genie’s window is still starting; try again in a moment.'))),
        elevate: (steps: readonly PrivilegedStep[]) => runElevatedBatch(process.platform, steps, (plan) => execFileRunner(plan.command, plan.args, { timeoutMs: 300_000 })),
        // Which php-cgi a site's pin runs, for the hosting replica's synchronous check: the same toolchain as the host's.
        phpCgiFor: (pin: string | undefined) => resolvePhpCgi(pin, phpCgiBase()),
        onToolCall: (call: ForwardedToolCall) => (windowToolRun ? windowToolRun(call) : Promise.resolve({ text: `${call.name}: Genie's window is still starting; call it again in a moment. Nothing was done.`, isError: true })),
        // openFileForUser made while no window was here: shown now (once the tools are built).
        onOpenFileLater: (call: ForwardedToolCall) => { if (windowToolRun) void windowToolRun(call); else openFilesLater.push(call); },
        // A tool's moment, from the host's own tools: the glow, the thumbs-up, the action on the agent's row.
        onToolSignal: (raw: unknown) => {
            const signal = raw as { kind?: string; terminalId?: string; agentId?: string; action?: string; tool?: string; reason?: string };
            if (signal.kind === 'glow' && typeof signal.terminalId === 'string') broadcast('genie:glow', signal.terminalId);
            else if (signal.kind === 'action' && typeof signal.agentId === 'string') broadcast('genie:action', { agentId: signal.agentId, kind: signal.action, ...(signal.tool ? { tool: signal.tool } : {}), ...(signal.reason ? { reason: signal.reason } : {}) });
        },
        // Both providers wait for their own private Tynn identity. Workspace/cwd config never supplies a fallback key.
        prepareMcpServers: async (record: AgentRecord, _cwd: string, signal: AbortSignal) => {
            if (!services) throw new Error('Agent services are not ready. Restart the agent after startup completes.');
            const privateServers = await services.prepareAgentMcp(record, signal);
            // Without its Tynn server it still starts (genie#1234): the reason is a note in its chat, never Broken.
            const tynnNote = services?.tynnNote(record.id) ?? null;
            if (tynnNote) void host?.notice(record.id, tynnNote);
            // The Genie entry is the HOST's (P3.1: it owns the MCP server and the caller keys); only the agent's private
            // servers are this window's to prepare.
            return [...privateServers];
        },
        // The Dashboard's comms (§4.1): AgentInbox traffic since the session started, read when the row is built.
        comms: (agentId: AgentId, since: number) => dashboardComms.read(agentId, since, Date.now()),
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
        const hostCopyInput = { packaged: app.isPackaged, platform: process.platform, execPath: process.execPath, electronVersion: process.versions.electron ?? 'unknown', appRoot: app.getAppPath(), unpackedRoot: `${app.getAppPath()}.unpacked`, hostHash: hostBuildNow.replace(/[^A-Za-z0-9._-]/g, '_'), genieHome: genieRoot(), log: lifecycleLog };
        const hostRuntime = await materializeHostRuntime(hostCopyInput);
        // Its own Deck item (Tynn #693): the error alone is the item's folded detail; the words are core/main-errors.ts's.
        if (hostRuntime.error !== null) mainErrors.record('host-copy', new Error(hostRuntime.cause ?? hostRuntime.error));
        remakeHostCopy = () => materializeHostRuntime(hostCopyInput).then((made) => (made.error === null ? null : made.cause ?? made.error));
        agentEngineLink = await connectAgentEngine({
            // WHAT THE OS SAYS ABOUT PROXIES, handed to the host each time this window links to it (host-https-fetch.ts).
            onLinked: (client) => {
                followGappsChanged(client);
                handProxyAnswers = () => reportProxies(client, lifecycleLog);
                void handProxyAnswers();
                publishBrowserFacts();
                // How the host starts its updater helper (P5b): this executable, in a dev run this app's path, and the switches this
                // window was started with that an Electron needs to start at all here (the sandbox, the display, the password store).
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
            },
            records: () => registry?.listAgents() ?? [],
            onError: (kind, error) => mainErrors.record(kind, error),
            agentName: (id) => registry?.find(id)?.name ?? id,
            log: lifecycleLog,
        });
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
        // THE REGISTRY'S FILES ARE GENIE-HOST'S (P3.2): this window's model reads and writes them through the host, and
        // re-reads them when another window (or the host) wrote — two windows, one registry. Before its load, below.
        theRegistry.useStore(new HostRegistryStore(engineLink.stores()));
        engineLink.stores().onRegistryChanged(() => { void theRegistry.refresh(); });
        // This window reaches the `processes` child (exec and streams). Supervised processes and terminals are the host's
        // own (P3.3b, P3.3e): their state comes by replica, so nothing here is taken back after a loss.
        const processes = new SpawnHostClient({ entry: '', link: engineLink.spawnLink('processes'), log: lifecycleLog });
        engineLink.onSpawnFrame('processes', (frame) => processes.linkFrame(frame));
        const reconcile = (): Promise<ListedPty[]> => processes.linkUp();
        engineLink.onLink(
            () => { void reconcile().catch((error: unknown) => lifecycleLog(`spawn host reconcile failed reason=${error instanceof Error ? error.message : String(error)}`)); },
            (why) => { processes.linkDown(why); },
        );
        // The link is already up (it came up in connectAgentEngine): the first reconcile is now, before anything starts.
        adoptablePtys = await reconcile().catch((error: unknown) => {
            lifecycleLog(`spawn host list failed reason=${error instanceof Error ? error.message : String(error)}`);
            return [];
        });
        if (adoptablePtys.length > 0) lifecycleLog(`spawn host found running=${adoptablePtys.length} (${adoptablePtys.map((p) => p.tag?.kind === 'process' ? p.tag.processId : p.tag?.kind ?? 'untagged').join(', ')})`);
        spawnHostNow = processes;
    }
    routeExecThroughSpawnHost(spawnHostNow);

    // Healthy means this process is up and answering, which is the only claim the local
    // workstation chip can honestly make from in here. A real health model belongs with
    // remote workstations, where there is something to be unreachable.
    await registry.load({ name: hostname(), healthy: true });
    // The agent host reads each agent's record per call (genie#1188): every record now, and each change as it lands.
    {
        const client = agentEngineLink.client;
        client.recordsChanged();
        registry.subscribeAgentRecords(() => client.recordsChanged());
    }
    /*
     * EVERY CHAT'S UNSENT DRAFT (genie#1261, main/chat-draft-store.ts), kept here so it survives a restart and a reload —
     * Genie 1 kept its part-typed answers in main the same way (v0.7.0-beta.342 main/ask/force-question.ts:1118, 1181-1217).
     * Opened only once the roster is in, so a prune never reads a registry not loaded yet as "every agent deleted"; then a
     * deleted agent's draft and files go on the change that removes it. Answered before any window exists.
     */
    // genie-host's (P3.2): one writer for the drafts file.
    const drafts = agentEngineLink.client.stores().drafts;
    const draftAgents = (): string[] => theRegistry.listAgents().map((a) => a.id);
    const pruneFailed = (error: unknown): void => { console.error(`[genie] chat drafts could not be pruned: ${error instanceof Error ? error.message : String(error)}`); };
    // Sent when the roster changes, not on every snapshot: a streaming agent touches the registry ~20 times a second.
    const draftPruner = rosterPruner({ ids: draftAgents, prune: (ids) => drafts.prune(ids), failed: pruneFailed });
    await draftPruner.start();
    registry.subscribe(() => draftPruner.changed());
    // The first roster snapshot is in, and the session host was built above it: a question's agent can be judged now.
    askerLivenessKnown = host !== null;
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

    /*
     * TERMINALS — for shells, builds, services and hosted sites. No agent has one.
     *
     * The engine is fancy-term-host behind the PtyPort seam. It saves no scrollback (the owner, 2026-11-02).
     */
    // ONE pty engine, shared by the terminal host and the composition root's supervisor.
    // The engine gates its cwd hook on GENIE'S settings, read live (§6.5).
    const ptyPort = realFancyTermPort(() => services?.settings.snapshot() ?? {});
    // THE WORKSPACE'S TERMINAL LIMIT (beta.33), read live from the workspace's settings on this workstation.
    // Interactive terminals run in genie-host's `terminals` child when there is a host (their output is never read here);
    // the open ones a previous window left running are taken back with what they printed.
    // THE TERMINALS ARE GENIE-HOST'S (P3.3e): their shells and scrollback outlive this window; it drives them by replica.
    terminals = agentEngineLink.client.terminals();
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
    /*
     * WHAT CHANGED ON DISK, AND GIT, PUSHED (the host split, P2.2): the watcher and git run in genie-host (files-watch-hub.ts);
     * here a batch is recorded for `state()` and handed to the local protocol — the panel re-lists once and re-reads the open file only
     * if it changed (genie#921) — and git's result goes to the views that asked for it, which no longer run git per batch.
     */
    // genie-host sends a window only the git tree's changes after the first (Tynn #524): the whole tree is kept here.
    const treeKeeper = new FilesTreeKeeper(lifecycleLog);
    const onFilesEvent = (received: FilesHubEvent): void => {
        const event = treeKeeper.accept(received);
        if (event.kind === 'changed') filesHost?.recordDiskChanges(event.workspaceId, event.changes);
        for (const listener of filesEventListeners) listener(event);
    };
    {
        const link = agentEngineLink.client;
        link.onFilesEvent(onFilesEvent);
        filesWatch = {
            // A known view is retained by the engine client even while offline, then replayed on reconnect.
            watch: (viewId, workspace, want) => { void link.filesWatch(viewId, workspace, want); return true; },
            unwatch: (viewId) => { void link.filesUnwatch(viewId); },
            close: () => {},
        };
    }
    // The popped-out panels (§4.3): tracked here, pushed as the whole list.
    // The Files panel's pop-out button: the person's click (genie#1235).
    filesWindows = new FilesWindows({ openWindow: (route) => openFilesWindow(route, 'user-gesture'), closeWindow: closeWindowAt });
    filesWindows.onChange((list) => broadcast('genie:files-windows-changed', list));
    /*
     * TAKE OVER (§1). The host opens the TUI in a workspace terminal and asks for a window on
     * it; the window is the session, so closing it closes the terminal. The registry reads
     * the host's probe to draw the Observed row. Nothing here manages the TUI.
     */
    const terminalsForTakeOver = terminals;
    scratchTerminals = new ScratchTerminals({ terminals: terminalsForTakeOver, openWindow: (route) => openTakeOverWindow(route, 'user-gesture') });
    takeOvers = agentEngineLink.client.takeOvers();
    const takeOversNow = takeOvers;
    theRegistry.setObservedProbe((id) => takeOversNow.probe(id as AgentId));
    // A window opened after a Pilot's Take over sees it; the Observed row follows each TUI starting and ending.
    takeOversNow.onChange(() => { theRegistry.touch(); });
    void takeOversNow.refresh().catch((error: unknown) => console.error(`[take over] ${error instanceof Error ? error.message : String(error)}`));

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

    ipcMain.handle('genie:snapshot', () => registry?.snapshot() ?? null);

    ipcMain.handle('genie:agent-detail', (_event, raw: unknown) => {
        const record = agentFromRenderer(raw);
        return record ? detailFor(record.id) : null;
    });

    // Which agents the window shows (its preload says, main/preload.ts `subscribeAgent`): only theirs are pushed.
    ipcMain.on('genie:agent-watch', (event, raw: unknown, on: unknown) => {
        if (!window || window.isDestroyed() || event.sender !== window.webContents) return;
        if (typeof raw !== 'string' || typeof on !== 'boolean') return;
        agentPush.watch(raw, on);
    });

    /*
     * START ON FIRST MESSAGE (the owner, 2026-11-01, q_04ce323c: "opening an agent must NOT start it"). One rule for every
     * sender of work — the composer, a remote window's prompt, a flow (main/start-on-demand.ts): a session here is used as
     * it is; an agent with none is started, unless its workspace is asleep or the agent cap refuses, said by name.
     */
    const startOnDemand = (record: AgentRecord): Promise<StartForWork> => startForWork({
        probe: (id) => host?.probe(id) ?? null,
        start: (r, cwd) => (host ? host.start(r, cwd) : { ok: false, reason: 'Genie’s agents are not running yet' }),
        cwdFor,
        startRefusal: (r) => startRefusal(workspaceOps, r, {
            running: registry!.agentsOf(r.workspaceId).filter((a) => host?.probe(a.id)?.running === true).length,
            cap: agentCapFrom(services?.settings.snapshotFor(r.workspaceId) ?? {}),
        }),
    }, record);
    // THE PERSON'S MESSAGE (main/start-on-demand.ts `startForYourMessage`): the same rule, and a new driver through the one
    // Restart when the run's own stopped itself. `agentOps` is read when a message comes, never while main is wiring up.
    // A command before the agent host is up is refused in words, where the caller shows them (Tynn #563).
    const agentsUp = (): NonNullable<typeof host> => {
        if (!host) throw new Error('Genie’s agents are not running yet');
        return host;
    };
    const startForYours = (record: AgentRecord): Promise<StartForWork> => startForYourMessage({
        startForWork: startOnDemand,
        needsNewDriver: (id) => host?.needsNewDriver(id) ?? false,
        restart: (id) => restartAgent(agentOps, id, 'graceful').finally(() => registry?.touch()),
        notice: (id, message) => host?.notice(id, message) ?? false,
    }, record);

    /*
     * The terminal handlers. Every argument is `unknown` and narrowed here — the renderer is
     * sandboxed and its values are not trusted. A terminal is opened for a WORKSPACE, which is
     * looked up in the registry: an unknown workspace is refused, and there is no way to name
     * an agent through this surface.
     */
    /*
     * AGENT OPERATIONS (§6.2). The plans live in core/agent-ops.ts, the sequencing in
     * agent-ops-host.ts; these ports are the real registry, session host and filesystem.
     * `signedIn` answers true: Genie has no provider sign-in probe yet, and a false "not signed
     * in" would send people to a login they already have. `linkedSystems` is empty until the
     * Tynn identity layer is wired — so a delete plan lists no external system, honestly.
     */
    const hostModels = agentEngineLink.client;
    // Measured once as the agents come up, so a switch or a diagnosis here reads a check rather than claiming nothing.
    void providerHealth.refreshAll();
    const agentOps = agentOpsPorts({
        registry: () => registry,
        engine: () => host,
        // A provider's models are asked of genie-host (beta.61.1): it has the process supervisor a provider launch needs.
        models: { get: (provider, options) => hostModels.providerModels(provider, options) },
        cwdFor,
        finished: () => services?.attention.finished() ?? [],
        providerInstalled: (provider) => providerHealth.installed(provider),
        signedIn: (provider) => providerHealth.signedIn(provider),
        applyOnStart: (id) => settingApplier!.requested(id),
        // Start is the restart now (genie#1238): what Start always obeyed — an asleep workspace, the agent cap — it obeys.
        startRefusal: (record) => startRefusal(workspaceOps, record, {
            running: registry!.agentsOf(record.workspaceId).filter((a) => host?.probe(a.id)?.running === true).length,
            cap: agentCapFrom(services?.settings.snapshotFor(record.workspaceId) ?? {}),
        }),
    });
    // Background tasks die with the process: a setting waits for the agent's to end (the Shells tab's own count).
    settingApplier = new SettingApplier(agentOps, (id) => (host ? agentShells(host.rowsFor(id)).count : 0));
    // `Log in to <provider>` (the owner, 2026-10-18): the provider's own login in a scratch folder, in a window of its own.
    // Signed in (its status command exits 0), every agent that login signed out is restarted on its thread and told.
    // GENIE'S SCRATCH (P7): this process's folder under `<root>/cache/tmp`, made on first use with no process-table read;
    // the folders of Genies that are gone are swept deferred, and the sweep is stopped on quit.
    const scratch = scratchArea(genieRoot());
    scratchSweepStop = scheduleScratchSweep(genieRoot(), { log: (line) => console.warn(line) });
    const logins = new LoginHost({
        scratch: () => scratch.directory(),
        terminals: terminalsForTakeOver,
        // A login starts from the tray or the agent view's Log in button only — the person's click (genie#1235).
        openWindow: (route) => openTakeOverWindow(route, 'user-gesture'),
        binaryFor: (provider) => providerBinary(provider as AgentRecord['provider']) ?? null,
        runStatus: (command, cwd) => execFileRunner(command, [], { shell: true, cwd, timeoutMs: 30_000 }).then((r) => r.exitCode, () => 1),
        onSignedIn: (provider) => {
            // Measured again, so its Toolchain row and its agents stop saying signed out (Tynn #698).
            void providerHealth.refresh(provider);
            afterSignedIn(provider, {
                signedOutAgents: (p) => host?.signedOutAgents(p) ?? [],
                restart: (id) => { void restartAgent(agentOps, id as AgentId, 'graceful').then((r) => { if (r.ok) host?.prompt(id as AgentId, SIGNED_IN_AGAIN, 'genie'); }).finally(() => registry?.touch()); },
                resumeLimit: (p) => { host?.resumeLimit(p); refreshTray(); },
            });
        },
        // CLAUDE DESIGN (#1081): no status to ask, so the agents that waited are told it was RUN and to retry; a retry that
        // is refused again raises the prompt again. They are not restarted: only a tool failed, never their session.
        onDesignLoginEnded: () => {
            if (host) tellDesignLoginRan(host);
            registry?.touch();
        },
    });
    loginHost = logins;
    restartForMcp = (id) => restartAgent(agentOps, id, 'graceful').then(() => {}).finally(() => registry?.touch());
    // TRY AGAIN, for a login whose account the provider paused (core/account-pause.ts): every agent it stopped comes back.
    retryPausedAccount = (provider) => {
        for (const id of host?.pausedAgents(provider) ?? []) {
            void restartAgent(agentOps, id, 'graceful').then((r) => { if (r.ok) host?.prompt(id, ACCOUNT_BACK, 'genie'); }).finally(() => registry?.touch());
        }
    };
    ipcMain.handle('genie:design-login', (_event, raw: unknown) => {
        const record = typeof raw === 'string' ? registry?.find(raw as AgentId) ?? null : null;
        if (!record) return { ok: false, reason: 'No agent named.' };
        const started = logins.start(DESIGN_LOGIN);
        return started.ok ? { ok: true } : started;
    });
    ipcMain.handle('genie:provider-login', (_event, raw: unknown) => {
        const record = typeof raw === 'string' ? registry?.find(raw as AgentId) ?? null : null;
        if (!record) return { ok: false, reason: 'No agent named.' };
        const started = logins.start(record.provider);
        return started.ok ? { ok: true } : started;
    });
    // A CRASH REPORT THE PERSON CHOOSES TO SEND (Tynn #386 part 4): the draft the safe-mode banner shows, and the send.
    const crashReports = crashReportHost({
        view: () => agentEngineLink?.client.safeModeView() ?? null,
        // The host's latest crash record and the reopened-window notice (Tynn #386): the draft is built from them.
        record: () => agentEngineLink?.client.crashStateView()?.record ?? null,
        notice: () => agentEngineLink?.client.crashStateView()?.notice ?? null,
        agents: () => (registry?.listAgents() ?? []).map((a) => ({ id: a.id, name: a.name, provider: a.provider })),
        workspaceNames: () => [...(registry?.listWorkspaces() ?? []).flatMap((w) => [w.id, basename(w.path)]), ...(registry?.workspaceSlugs().values() ?? [])],
        genieVersion: app.getVersion(),
        os: process.platform,
        arch: process.arch,
        tynnHost: TYNN_HOST,
        identity: async () => (crashReportMachine ? crashReportMachine.identity(TYNN_HOST) : null),
        authHeader: async () => { if (!crashReportMachine) throw new Error('no workstation identity'); return crashReportMachine.authHeader(TYNN_HOST); },
        fetch: (url, init) => net.fetch(url, init),
    });
    ipcMain.handle('genie:crash-report-draft', () => crashReports.draft());
    ipcMain.handle('genie:crash-report-send', (_event, text: unknown, notes: unknown) =>
        typeof text === 'string' && typeof notes === 'string' ? crashReports.send(text, notes) : { ok: false, reason: 'A crash report needs its text.' });
    ipcMain.handle('genie:take-over', (_event, raw: unknown) => takeOverHere(raw, { window: true }));

    // THE HEADER'S TERMINAL BUTTON (Tynn story #378): a throwaway shell in the workspace's folder, with the workspace's
    // environment (the same `terminalEnvFor` as a workspace terminal), in a window of its own; closing it ends it.
    ipcMain.handle('genie:scratch-terminal-open', (_event, rawWorkspaceId: unknown) => {
        if (!scratchTerminals) return { ok: false, reason: 'Terminals are not ready yet.' };
        const workspace = typeof rawWorkspaceId === 'string' ? registry?.snapshot().workspaces?.find((w) => w.id === rawWorkspaceId) ?? null : null;
        if (!workspace) return { ok: false, reason: 'That workspace is not open in Genie.' };
        return scratchTerminals.open({ workspaceId: workspace.id, cwd: workspace.path, env: terminalEnvFor(services, workspace.id, mcpEnv()) });
    });
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
    // A PLUGIN EDITOR'S BYTES (beta.33 item 14): through the plugin gate — an enabled plugin's own claimed and declared types only.
    const editorBytesDeps = (): EditorBytesDeps | null => (filesHost && services ? { gate: (pluginId, path) => services!.plugins.editorBytes(pluginId, path), files: filesHost } : null);
    // THE OFFICIAL PANELS (beta.33 item 14): the Repository panel's git and the ArtBoard, by workspace (official-panels-host.ts).
    const panelsHost = (): PanelsHostDeps => ({
        workspacePath: (id) => registry?.workspace(id)?.path ?? null,
        // An ArtBoard verdict reaches the agent that posted, as an AgentInbox message from you.
        send: async (agentId, text) => { if (services) await services.inbox.send({ from: HUMAN, to: agentId as AgentId, text }); },
        now: () => new Date().toISOString(),
    });
    // The rail's Browser row (beta.35 item 36): the Genie browser window, a typed address checked by its own rule.
    // WHICH BROWSER is decided by the window that asked (core/browser-connection.ts): this machine's sites, or — for a window
    // driving a Tynn workstation — that workstation's, over that window's own relay channel. Never by what it says.
    ipcMain.handle('genie:browser-window-open', async (event, address: unknown, rawHosts: unknown) => {
        const at = typeof address === 'string' ? address : undefined;
        const remoteUrl = [...remoteWindows].find(([, w]) => !w.isDestroyed() && w.webContents === event.sender)?.[0] ?? null;
        const link = deviceLinkNow();
        const relays = link ? [...linkedRelays].filter(([, c]) => c.sender === event.sender).map(([channel, c]) => ({ workstationId: c.workstationId, transport: channel })) : [];
        const conn = browserConnectionFor({ remoteUrl, relays });
        if (conn.kind === 'refused') return { ok: false, error: conn.reason };
        if (conn.kind === 'local') return openLocalBrowser(at, 'user-gesture');
        // A channel genie-host holds (Tynn #552): its door to that workstation's sites is the host's too.
        const via = link ? await link.browserVia(conn.transport) : null;
        if (!via) return { ok: false, error: 'This window is not connected to its workstation right now. Reconnect, then open the browser again.' };
        const hosts = Array.isArray(rawHosts) ? rawHosts.filter(isGenHost) : [];
        const title = BrowserWindow.fromWebContents(event.sender)?.getTitle() || 'another workstation';
        return askBrowser([at ?? null, 'user-gesture', { key: `relay:${conn.workstationId}`, title, port: via.port(), ca: via.ca(), hosts }]);
    });
    ipcMain.handle('genie:files-popout', (_event, workspaceId: unknown) => { if (typeof workspaceId === 'string') filesWindows?.popOut(workspaceId); });
    // A drone never connects out (audit M-b): refused HERE, from the role main read from Tynn, not only hidden in the window.
    // TAKE OVER FROM ANOTHER MACHINE (Tynn #529 part A): this machine's window on that host's terminal; a drone opens none.
    ipcMain.handle('genie:remote-takeover-open', (_event, url: unknown, terminalId: unknown, ticket: unknown, name: unknown) => {
        if (typeof url !== 'string' || typeof terminalId !== 'string' || typeof ticket !== 'string' || ticket === '') return { ok: false, reason: 'not a Take Over window' };
        const refused = outboundDialRefusal(workstationRoleNow, url);
        if (refused) return { ok: false, reason: refused };
        openRemoteTakeOverWindow(url, terminalId, ticket, typeof name === 'string' ? name : null);
        return { ok: true };
    });
    // The Take Over window's ticket, read ONCE: the read deletes it.
    ipcMain.handle('genie:takeover-ticket', (event) => {
        const ticket = takeOverTickets.get(event.sender.id) ?? null;
        takeOverTickets.delete(event.sender.id);
        return ticket;
    });
    ipcMain.handle('genie:remote-open-window', (_event, url: unknown, name: unknown) => { if (typeof url !== 'string') return; const refused = outboundDialRefusal(workstationRoleNow, url); if (refused) return { ok: false, reason: refused }; openRemoteWindow(url, typeof name === 'string' ? name : null); });
    /*
     * The tailnet socket is dialled by the remote window's renderer, which main otherwise never sees: every WebSocket an
     * app window opens (they share the default session; the Genie browser has its own) is cancelled while this machine
     * is a drone. Main's own sockets (the relay, Pusher) are Node's and do not pass through here. A desktop window no longer
     * dials (genie:device-open, below, refuses first): this stays as defence in depth for anything else a window opens.
     */
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: outboundDialRefusal(workstationRoleNow, details.url) !== null }));
    // THE TYNN NETWORK, AS A MEMBER (Tynn #837; Genie 1's workstation:connectable / workstation:open): the workstations
    // Tynn lists, and a connection to one — the grant and its proof key minted and held HERE, never in the window.
    // A PASTED SHARE LINK (genie#1278 C1; Genie 1's connect-dispatch): main classifies it against the Tynn this Genie is
    // signed in to, with the role Tynn gave this machine — never one the window sends — then opens the invite in the
    // browser or the workstation in its own window.
    ipcMain.handle('genie:connect-link', async (_event, text: unknown) => {
        const status = tynnAccount?.status();
        return dispatchConnectLink(String(text ?? ''), status?.signedIn ? status.host : null, workstationRoleNow, {
            openExternal: async (url) => { try { await shell.openExternal(url); return true; } catch { return false; } },
            openWorkstation: (id, name) => openRemoteWindow(`relay:${id}`, name ?? null),
        });
    });
    ipcMain.handle('genie:relay-open', async (event, workstationId: unknown) => {
        if (typeof workstationId !== 'string' || relayWorkstationOf(`relay:${workstationId}`) === null) return { ok: false, reason: 'not a Tynn workstation' };
        const refusedByRole = droneRefusal(workstationRoleNow);
        if (refusedByRole) return { ok: false, reason: refusedByRole };
        // GENIE-HOST DIALS (Tynn #552, P5d.4; audit M-e): it mints the grant, keeps the key, opens the relay member; this
        // window gets a channel. Tynn's own refusal comes back for this window to word, from the role it read.
        const link = deviceLinkNow();
        if (link) {
            hearDeviceLink(link);
            const sender = event.sender;
            const offStep = link.onStep((id, step) => { if (id === workstationId && !sender.isDestroyed()) sender.send('genie:relay-open-step', workstationId, step); });
            const opened = await link.openRelay(workstationId).finally(offStep);
            if (!opened.ok) return 'refusal' in opened ? { ...(await wordTynnRefusal(opened.refusal, rereadRole)), stage: 'tynn' } : opened;
            deviceChannels.set(opened.channel, sender);
            linkedRelays.set(opened.channel, { sender, workstationId });
            // The window went: its connection goes with it.
            sender.once('destroyed', () => { if (deviceChannels.delete(opened.channel)) { linkedRelays.delete(opened.channel); link.close(opened.channel); } });
            return { ok: true, channel: opened.channel };
        }
        return { ok: false, reason: 'Genie’s host is not connected' };
    });
    // SHARING THIS MACHINE THROUGH TYNN (Tynn #839; Genie 1's workspace share links), over the session.
    const ownWorkstation = () => (tynnWorkstationNow?.registered ? tynnWorkstationNow.workstationId : null);
    const shareRequest = (path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }) => {
        if (!tynnAccount) return Promise.reject(new Error('this Genie has no Tynn account'));
        return tynnAccount.request(path, init);
    };
    // ANOTHER MACHINE, BY ITS ADDRESS (P3.4 cut e, audit M-e): refused here on a drone, then the host dials, and holds the token. The window's frames use the relay's channels.
    const deviceLinkNow = () => agentEngineLink?.client.deviceLink() ?? null;
    let deviceLinkHeard: unknown = null;
    const hearDeviceLink = (link: NonNullable<ReturnType<typeof deviceLinkNow>>) => {
        if (deviceLinkHeard === link) return;
        deviceLinkHeard = link;
        link.onFrame((channel, text) => { const sender = deviceChannels.get(channel); if (sender && !sender.isDestroyed()) sender.send('genie:relay-message', channel, text); });
        link.onClosed((channel, reason) => {
            const sender = deviceChannels.get(channel);
            deviceChannels.delete(channel);
            linkedRelays.delete(channel);
            if (sender && !sender.isDestroyed()) sender.send('genie:relay-closed', channel, reason);
        });
    };
    ipcMain.handle('genie:device-open', async (event, url: unknown) => {
        const link = deviceLinkNow();
        if (link) hearDeviceLink(link);
        const opened = await deviceLinkGate(url, { role: () => workstationRoleNow, said: () => workstationSaidNow, why: () => workstationWhyNow, reread: async () => { await readWorkstationRoleNow?.(); }, link: () => link });
        if (!opened.ok) return opened;
        const sender = event.sender;
        deviceChannels.set(opened.channel, sender);
        // The window went: its connection goes with it.
        sender.once('destroyed', () => { if (deviceChannels.delete(opened.channel)) link?.close(opened.channel); });
        return opened;
    });
    // Only the window that opened a channel may use it.
    ipcMain.on('genie:relay-send', (event, channel: unknown, text: unknown) => {
        if (typeof channel === 'string' && deviceChannels.get(channel) === event.sender && typeof text === 'string') { deviceLinkNow()?.send(channel, text); return; }
    });
    ipcMain.on('genie:relay-close', (event, channel: unknown) => {
        if (typeof channel === 'string' && deviceChannels.get(channel) === event.sender) { deviceLinkNow()?.close(channel); return; }
    });
    ipcMain.handle('genie:files-bringback', (_event, workspaceId: unknown) => { if (typeof workspaceId === 'string') filesWindows?.bringBack(workspaceId); });
    ipcMain.handle('genie:files-windows', () => filesWindows?.list() ?? []);

    /*
     * WORKSPACE OPERATIONS (§6.1). The plans live in core/workspace-model.ts, the sequencing in
     * workspace-ops-host.ts; these ports are the real registry, session host, terminal host,
     * supervisor and filesystem. Add is preview-then-confirm: the picker and the classification
     * write nothing; `confirmAdd` does the writes the plan showed.
     */
    const lifecycleWiring: WorkspaceLifecycleWiring = {
        registry: () => registry,
        engine: () => host,
        finished: () => services?.attention.finished() ?? [],
        terminals: () => terminals,
        supervisor: () => services?.supervisor ?? null,
        engines: () => services?.hibernationEngines ?? null,
        reverifyTrust: async (id) => {
            const view = await services?.workspaceTrust.refresh(id, 'redock');
            if (!view) throw new Error('workspace trust is not available yet');
        },
        github: () => githubAccount,
        tynn: () => tynnAccount,
        // Settings → General "Env file name", read at each add (Add workspace parity 2b); before the services exist, `.env`.
        defaultEnvFile: () => {
            const v = services?.settings.get('default_env_file');
            return typeof v === 'string' ? v : '';
        },
        stagingDirectory: () => scratch.directory(),
    };
    const lifecycle = workspaceLifecyclePorts(lifecycleWiring);
    const { workspaceOps } = lifecycle;
    // The person's own answer to a provider hidden behind a batch wrapper (Tynn #577): an .exe, kept per provider.
    ipcMain.handle('genie:provider-choose-program', async (_event, raw: unknown) => {
        if (!window || typeof raw !== 'string' || !isAcpProvider(raw)) return { ok: false, reason: 'No provider named.' };
        const picked = await dialog.showOpenDialog(window, { title: `Choose ${raw}'s program`, properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe', 'com'] }] });
        const path = picked.filePaths[0];
        if (picked.canceled || !path) return { ok: false };
        const file = providerChoiceFile();
        if (file === null) return { ok: false, reason: 'Genie has nowhere to keep the choice yet.' };
        return writeProviderChoice(file, raw, path);
    });

    ipcMain.handle('genie:add-workspace', async () => {
        if (!window || !registry) return { ok: false };

        // Always a real folder the user chose. Genie never guesses a path and never writes
        // into one before showing what it found.
        const picked = await dialog.showOpenDialog(window, {
            title: 'Add a workspace',
            properties: ['openDirectory'],
        });
        const path = picked.filePaths[0];
        if (picked.canceled || !path) return { ok: false };

        await registry.addWorkspace({ id: basename(path), path, envFile: registeredEnvFile(workspaceOps) });
        return { ok: true };
    });

    /*
     * THE FEATURE SERVICES — every store, the Flow scheduler, the supervisor, the site manager and
     * the .gen front door, composed once (compose.ts). The v1 settings carry-over runs here on first
     * run, from v1's own database under the same ~/.genie.
     */
    // THE BACKGROUND PROCESSES THE PERSON KEEPS (§6.6, process-book.ts): opened once the services are composed;
    // until then every snapshot is the supervisor's alone. Late-bound so no closure below can meet it uninitialised.
    // genie-host's when it runs (P3.3c): the book and its scheduler there, this window's replica here.
    let processBook: ProcessBookApi | null = null;
    let processScheduler: Pick<ProcessScheduler, 'runNow'> | null = null;
    // The features' ports: the kept processes, and every workspace's GitHub panel (Tynn #806).
    // The Tynn this Genie uses: Help → Genie documentation opens its docs (Tynn #762).
    const tynnHost = (): string => TYNN_HOST;
    // Every snapshot — pushed or answered — carries the Tynn account (late-bound: it opens once the services are composed).
    // The host's switch (Tynn #820) and, on Windows, its firewall rule (Genie 1's allowFirewall) — Settings → Remote access.
    // TAILSCALE FROM GENIE (Tynn #821; Genie 1's tailscale.status / up + openAuth / install). A sign-in link or a download
    // page opens in the browser (https only); a node that comes online re-applies the remote-access switch.
    const refreshTailscale = async (): Promise<void> => { tailscaleNow = await getTailscaleStatus().catch(() => tailscaleNow); };
    const openHttps = (url: string | null | undefined): void => { if (url && /^https:\/\//i.test(url)) void shell.openExternal(url).catch(() => {}); };
    const tailscalePort: NonNullable<FeaturePorts['tailscale']> = {
        status: () => tailscaleNow,
        up: async () => {
            const r = await tailscaleUp();
            openHttps(r.authUrl);
            await refreshTailscale();
            if (r.ok) await remoteAccessNow?.apply();
            return r;
        },
        install: async () => {
            const r = await installTailscale({ download: (url) => net.fetch(url) });
            openHttps(r.url);
            await refreshTailscale();
            return r;
        },
    };
    void refreshTailscale();
    // Set once the feature push exists (below): Docker answering after a snapshot stopped waiting for it pushes again.
    let requestFeaturePush = (): void => {};
    const processPorts = (): FeaturePorts => ({ onEngineStatusesLate: () => requestFeaturePush(), tailscale: tailscalePort, ...(remoteAccessNow ? { remoteAccess: remoteAccessNow } : {}), ...(process.platform === 'win32' ? { allowFirewall: () => ensureFirewallRule(REMOTE_PORT) } : {}), ...(processBook ? { processes: processBook } : {}), ...(processScheduler ? { processScheduler } : {}), ...(tynnAccount ? { tynnAccount } : {}), ...(githubAccount ? { githubAccount } : {}), ...(keyring ? { keyring } : {}), tynnWorkstation: () => (tynnWorkstationNow?.registered ? { ...tynnWorkstationNow, relay: relayStatusNow } : tynnWorkstationNow), issueWatch: () => issueWatchPanels(), issueWatchRefresh: (workspaceId: string) => issueWatchRefreshFor(workspaceId), issueWatchSetRepo: (workspaceId: string, owner: string, repo: string, change: { enabled?: boolean; includeUpstream?: boolean }) => issueWatchSetRepoFor(workspaceId, owner, repo, change), whatsNew: (shown) => whatsNewFor(app.getVersion(), String(composed.settings.get('whats_new_seen_version') ?? ''), RELEASE_NOTES, shown), appVersion: () => app.getVersion() });
    // THE HOST'S SOCKET (§6.8): fancy-ws on the Tailscale IPv4 only; with no Tailscale nothing listens and Settings says why.
    /*
     * REMOTE ACCESS IS GENIE-HOST'S (Tynn #409, host split P5d.1): with genie-host linked, IT listens on the tailnet, pairs,
     * and holds the baton and the lock; this window starts no listener, opens no device store, and drives it through the
     * replica. Its own remote host then serves its protocol door only.
     */
    const linkedRemote = agentEngineLink.client.remoteAccess();
    const remoteHub = transportHub({ onConnection: () => () => {} });
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
    // WITH GENIE-HOST LINKED THE DOOR AND ITS KEYS ARE THE HOST'S (P5a.2 ruling 3): every credential is minted there, window or
    // no window. This window starts no door and opens no keys (one writer of app-inbox.json); it drives the host's through the
    // replica — a script key's secret reaches it once, in the answer to its own create (Tynn #584: no door of its own).
    const linkedAppInbox = agentEngineLink.client.appInbox();
    const appInboxKeys: Pick<AppInboxReplica, 'createScriptKey' | 'scriptKeys' | 'revokeScriptKey' | 'rotate' | 'revokeSource' | 'allowSource' | 'sources' | 'revokedSources'> = linkedAppInbox;
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
        pty: ptyPort,
        // Supervised processes (sites, workers, the front door) are created in the spawn host, never on main (genie#1397);
        // main's own engine takes them only if the spawn host cannot start.
        processPty: spawnHostNow ? spawnHostNow.ptyPort(ptyPort) : ptyPort,
        // What a previous window left running under genie-host: adopted before any site or kept process starts.
        adoptPtys: adoptablePtys,
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
        // The plugins are genie-host's (ADF A3, Tynn #447): this window reads them through the replica.
        plugins: agentEngineLink.client.plugins(),
        catalog: agentEngineLink.client.catalog(),
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
        // What a flow's agent prompt reaches (flow-runner.ts): the live sessions, late-bound — a prompt to an agent mid-turn
        // is held back, never queued inside its turn.
        agentSessions: {
            session: (id) => host?.probe(id as AgentId) ?? null,
            // A flow's prompt is work: an agent not running is started for it (q_04ce323c), under the same refusals.
            start: async (id) => { const record = registry?.find(id as AgentId); return record ? (await startOnDemand(record)).ok : false; },
            rows: (id) => host?.rowsFor(id as AgentId) ?? [],
            prompt: (id, text, by) => host?.prompt(id as AgentId, text, by) ?? false,
            subscribe: (listener) => host?.subscribe((agentId) => listener(agentId)) ?? (() => {}),
        },
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
        hostName: hostname(),
        // The tailnet listener, and the Tynn relay while it runs (Tynn #838).
        remoteTransport: remoteHub,
        mcpEndpoint: () => mcpEndpointNow(),
        hostConfigSync: () => agentEngineLink?.client ?? null,
        // The account is opened after compose; private credentials are requested only when an agent starts.
        tynn: () => tynnAccount,
        // The one gate for every secret (os-cipher.ts): no keyring, no secret; basic_text is never a keyring.
        tynnCipher: osCipher(safeStorage, process.platform),
        secretsLog: (line) => keychainLog(line),
        legacySecrets: () => gatherSources([
            { file: 'tynn.json', covers: 'tynn/pairing', sources: async () => {
                await settleStaleLegacyPairing({ file: join(genieRoot(), 'credentials', 'tynn.json'), legacyFile: join(genieRoot(), 'tynn.json'), log: (line) => keychainLog(line) }).catch(() => {});
                return [tynnPairingSource({ file: join(genieRoot(), 'credentials', 'tynn.json'), legacyFile: join(genieRoot(), 'tynn.json'), cipher: osCipher(safeStorage, process.platform), log: (line) => keychainLog(line) })];
            } },
            { file: 'github.json', covers: 'github/', sources: () => githubSealedSources({ file: join(genieRoot(), 'github.json'), cipher: osCipher(safeStorage, process.platform), v1Settings: () => readV1Settings(v1DatabaseFile()) }) },
            { file: 'workstation.json', covers: 'workstation/', sources: () => workstationSealedSources({ file: join(genieRoot(), 'workstation.json'), cipher: osCipher(safeStorage, process.platform) }) },
        ]),
        onSecretsMoved: () => {
            void githubAccount?.reload().catch(() => {});
            void registerWorkstationNow?.();
            void tynnAccount?.reload().catch(() => {}).finally(() => recoverTynnAgents({ secretsMoved: true }));
        },
        // An agent's key is the host's (genie#1457).
        tynnSecrets: linkedAgentSecrets(agentEngineLink.client),
        tynnVault: linkedVault(agentEngineLink.client),
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
        askerLive: askerLiveFrom({ known: () => askerLivenessKnown, engine: () => host, takeOvers: () => takeOvers }),
        /*
         * The common API for remote connections and migrated local families (§6.8, P4).
         * Late-bound through `services`/`featurePorts`; the local door attaches after composition.
         */
        remoteAccess: linkedRemote,
        remoteApi: (remoteApiNow = buildHostApi({
            marketplace: () => agentEngineLink?.client.marketplace() ?? null,
            gapps: () => withGappWindows(agentEngineLink?.client),
            gappsChanged: { subscribe: (listener) => { gappsChangedListeners.add(listener); return () => { gappsChangedListeners.delete(listener); }; } },
            // Following the Tynn tab, by subscription (P4 family 12, Tynn #561).
            tynnWatch: tynnWatchPort,
            localTerminals: createNativeTerminalPort({
                terminals: () => terminals,
                workspaces: () => registry?.snapshot().workspaces ?? [],
                trackCwd: () => (services?.settings.snapshot() ?? {}).track_cwd,
                environment: id => terminalEnvFor(services, id, mcpEnv()),
                freshSnapshot: async id => {
                    if (!terminals) return null;
                    if (terminals.freshSnapshot) return terminals.freshSnapshot(id);
                    const value = terminals.attach(id), position = terminals.streamSnapshot?.(id);
                    return value ? { ...value, epoch: position?.epoch ?? null, endOffset: position?.endOffset ?? null } : null;
                },
                listen: (data, exit) => {
                    const offData = terminals?.onData((id, text, position) => data({ id, data: text, ...(position ? { epoch: position.epoch, offset: position.offset } : {}) })) ?? (() => {});
                    const offExit = terminals?.onExit((id, code, position) => exit({ id, exitCode: code, ...(position ?? {}) })) ?? (() => {});
                    return () => { offData(); offExit(); };
                },
                openError: (path, error) => console.error(`[terminal] open failed in ${path}: ${error instanceof Error ? error.message : String(error)}`),
            }),
            // Take over from another machine (Tynn #529 part A): the TUI here, its window there; that window closing ends it.
            takeOver: {
                start: (agentId) => takeOverHere(agentId, { window: false }),
                ended: (terminalId) => { takeOvers?.windowClosed(terminalId); },
            },
            filesWatch: {
                exists: id => { const w = registry?.workspace(id); return !!w && w.asleep !== true; },
                watch: (viewId, id, want) => { const workspace = registry?.workspace(id); return filesWatch && workspace && workspace.asleep !== true ? filesWatch.watch(viewId, { id: workspace.id, path: workspace.path }, want) : false; },
                unwatch: viewId => { filesWatch?.unwatch(viewId); },
                subscribe: listener => { filesEventListeners.add(listener); return () => { filesEventListeners.delete(listener); }; },
            },
            localOwner: {
                appInbox: {
                    state: (id) => appInboxState(id), workspaceExists: (id) => !!registry?.workspace(id),
                    createKey: (id, name) => appInboxKeys.createScriptKey(id, name), scriptKeys: (id) => appInboxKeys.scriptKeys(id),
                    revokeKey: (id) => appInboxKeys.revokeScriptKey(id), rotate: (kind, id) => appInboxKeys.rotate(kind, id),
                    revokeSource: (source) => appInboxKeys.revokeSource(source), allowSource: (kind, id) => appInboxKeys.allowSource(kind, id),
                    restartSource: (workspaceId, kind, id) => restartSource(workspaceId, kind, id),
                },
                deviceLink: {
                    hosts: async () => (await deviceLinkNow()?.hosts()) ?? [],
                    forget: async (url) => (await deviceLinkNow()?.forget(url)) ?? false,
                    adopt: async (url, token) => (await deviceLinkNow()?.adopt(url, token)) ?? false,
                },
                tynnNetwork: {
                    hasAccount: () => tynnAccount !== null, signedIn: () => tynnAccount?.status().signedIn === true, role: () => workstationRoleNow,
                    workstations: async () => {
                        const account = tynnAccount!;
                        // Every identity this machine holds, not only this launch's registration (this-machine.ts).
                        return wordTynnRefusal(await connectableWorkstations((path, init) => account.request(path, init), await thisMachineIds()), rereadRole);
                    },
                    // Tynn decides a role change with a fresh authenticator code (genie#1278 W6).
                    setRole: (id, role, code) => {
                        const account = tynnAccount!;
                        return setWorkstationRole((path, init) => account.request(path, init), id, role, code);
                    },
                    rereadRole: () => { void readWorkstationRoleNow?.(); },
                    shares: {
                        list: (id) => listShareLinks(shareRequest, ownWorkstation(), id),
                        mint: (input) => mintShareLink(shareRequest, ownWorkstation(), input),
                        // Keep immediate revalidation of a revoked link's live guest session (audit M-c).
                        revoke: (id) => revokeShareLink(shareRequest, ownWorkstation(), id, async () => { await agentEngineLink?.client.relayHost().revalidate(); }),
                    },
                },
            },
            // The Dashboard's lanes for a remote window: one workspace's feeds, and each as it changes (guests: their own).
            activity: { feeds: (workspaceId) => activityOfWorkspace(activityFeeds, registry?.listAgents() ?? [], workspaceId), subscribe: (cb) => activityFeeds?.subscribe(cb) ?? (() => {}) },
            headroom: headroomFeed,
            retryPausedAccount: (provider) => { retryPausedAccount?.(provider); },
            snapshot: () => registry!.snapshot(),
            subscribeSnapshot: (cb) => registry!.subscribe(cb),
            subscribeAgentRecords: (cb) => registry!.subscribeAgentRecords(cb),
            find: (id) => registry?.find(id as AgentId) ?? null,
            detailFor: (id) => detailFor(id as AgentId),
            cwdFor,
            // A remote window's message starts the agent as the composer's does (q_04ce323c).
            startForWork: (record) => startOnDemand(record),
            startForYourMessage: (record) => startForYours(record),
            host: {
                start: (record, cwd) => host!.start(record, cwd),
                stop: (id) => agentsUp().stop(id),
                cancel: (id, intent) => agentsUp().cancel(id, 'you', intent),
                resumeLimit: (provider) => agentsUp().resumeLimit(provider),
                prompt: (id, text, by) => agentsUp().prompt(id, text, by),
                // The composer's own attach path, for this window and a phone's photo (genie#1346).
                promptWith: (id, text, attachments, by) => agentsUp().promptWith(id, text, attachments, by),
                resolvePrompt: (id, promptId, action) => agentsUp().resolvePrompt(id, promptId, action),
                answerApproval: (id, optionId, note) => agentsUp().answerApproval(id, optionId, note ?? ''),
                subscribe: (cb) => host!.subscribe(cb),
            },
            // The phone's file browser (genie#1346): the files host the panel uses — confined, capped — and its upload.
            localFiles: { files: () => filesHost, editor: editorBytesDeps, repo: (op, id, rel, a, b) => repoCall(panelsHost(), op, id, rel, a, b) },
            artboard: { read: id => artboardReadFiles(panelsHost(), id), review: (id, post, verdict, comment) => artboardReview(panelsHost(), id, post, verdict, comment) },
            chatDrafts: engineDraftsPort(drafts, (method, args) => agentEngineLink?.client.call(method, args) ?? Promise.resolve({ ok: false, reason: 'The draft host is not connected.' })),
            files: {
                children: async (workspaceId, dir) => (await filesHost?.children(workspaceId, dir)) ?? null,
                open: (workspaceId, path) => filesHost?.open(workspaceId, path) ?? Promise.resolve({ ok: false as const, path, error: 'no files host' }),
                readBytes: (workspaceId, path) => filesHost?.readBytes(workspaceId, path) ?? Promise.resolve({ ok: false as const, path, error: 'no files host' }),
                upload: (workspaceId, dir, name, bytes) => filesHost?.upload(workspaceId, dir, name, bytes) ?? Promise.resolve({ ok: false as const, reason: 'no files host' }),
            },
            registerAgent: (workspaceId, input) => createAgent(agentCreatePorts(), workspaceId, input),
            rosterChanged: () => registry?.touch(),
            attention: { finished: () => services!.attention.finished(), markSeen: (id) => services!.attention.markSeen(id) },
            terminals: {
                open: (options) => terminals!.open(options),
                write: (id, data) => terminals!.write(id, data),
                resize: (id, cols, rows) => terminals!.resize(id, cols, rows),
                close: (id) => terminals!.close(id),
                list: () => terminals!.list(),
                attach: (id) => terminals!.attach(id),
                onData: (cb) => terminals!.onData(cb),
                onExit: (cb) => terminals!.onExit(cb),
            },
            // A remote device's upload (§6.8, genie#1354): its bytes go to the inbox as bytes — never a path on this host.
            uploads: uploadSender({ resolve: (to) => services!.resolveAddress(to), send: (input) => services!.inbox.send(input) }),
            serviceEnvFor: (workspaceId) => services!.engines.envFor(workspaceId),
            workspaceOps: {
                ...workspaceTynnApi(tynnBoardPorts, readWorkspaceTynnPage),
                ...workspaceLifecycleApi(lifecycle, lifecycleWiring, () => registry?.touch(), (id, color) => setWorkspaceColor(id, color)),
                // The live tab's reads (P4 family 12): what changed since a cursor, never the whole board or queue.
                tynnBoardChanges: (id, scope, cursor, ids) => readTynnBoardChanges(tynnBoardPorts(), id, (scope ?? {}) as BoardScope, cursor, ids),
                tynnIssueChanges: (id, filters, cursor, ids) => readTynnIssueChanges(tynnBoardPorts(), id, filters ?? {}, cursor, ids),
                ...workspaceSettingsOps(() => services!.settings),
                onSettingsChanged: (listener) => services!.settings.onChange((_key, _value, id) => { if (id) listener(id); }),
            },
            agentOps: agentOpsApi(agentOps, () => registry?.touch(), () => host),
            features: {
                snapshot: () => featureSnapshot(services!, featureState, processPorts()),
                act: (action, context) => runFeatureAction(action, context),
                picked: (paths) => hostPicks.record(paths),
                // An alert's own sound file, by setting key (feature-ipc customSoundData): never a path from the renderer.
                soundData: (key) => customSoundData(services!.settings, key),
                onChange: (cb) => { featureListeners.add(cb); return () => { featureListeners.delete(cb); }; },
            },
            updates: updates
                ? {
                      state: () => updates!.state(),
                      check: () => updates!.check(),
                      download: () => updates!.download(),
                      install: () => {
                          const pending = updates!.install();
                          return pending ? pending.then((done) => { console.log(`[updater] ${done.report}`); return { report: done.report }; }) : null;
                      },
                      notes: () => updates!.refreshNotes(),
                      onChange: (cb) => updates!.onChange(cb),
                  }
                : null,
        })),
    });
    services = composed;
    // Genie-host's remote connections follow this window's events (the snapshot, features…) while it is the newest window.
    if (remoteApiNow) {
        const api = remoteApiNow;
        linkedRemote.forwardEvents((listener) => api.onEvent(listener));
        void linkedRemote.refresh().catch((error: unknown) => console.error(`[remote] ${error instanceof Error ? error.message : String(error)}`));
    }
    composedNow = composed;
    servicesComposed(composed);
    // Local calls and event subscriptions use late-bound services. Until now the door answers "Genie is still starting".
    remoteHub.add(localDoor);
    // ONE snapshot build at a time, the latest state always delivered last (core/latest-push.ts, genie#1393): every change
    // used to build its own snapshot concurrently, and they landed out of order.
    const featurePush = new LatestPush<FeatureData>({
        build: () => featureSnapshot(composed, featureState, { ...processPorts(), onEngineStatusesLate: () => pushFeatures() }),
        deliver: (data) => {
            // Every window, a flow editor's too (genie#1204): each hears the local door's revision and re-reads (P4 family 11).
            for (const l of featureListeners) l(data);
        },
    });
    const pushFeatures = () => featurePush.request();
    requestFeaturePush = pushFeatures;
    composed.flows.onChange(pushFeatures);
    composed.settings.onChange(pushFeatures);
    composed.supervisor.onChange(pushFeatures);
    composed.onFrontDoorChange(pushFeatures);
    // Who is connected and which devices are paired redraw as they change; "Pair this device?" appears at once, and a
    // window not in front asks for attention (taskbar flash / urgency) WITHOUT taking focus (q_8c07b142).
    composed.remote.onChange(pushFeatures);
    composed.pairing.onChange(() => {
        pushFeatures();
        if (composed.pairing.requests().length === 0) return;
        for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.isVisible() && !w.isFocused()) w.flashFrame(true);
    });
    // The Services and Hosting tabs redraw when an AGENT acts through its `services` / `sites` tools, not only when the
    // person does (their own action answers with the snapshot; an agent's has nobody to answer but this push).
    composed.engines.onChange(pushFeatures);
    composed.sites.onChange(pushFeatures);
    // LINUX WITH NO KEYRING (linux-keyring.ts; the owner, 2026-11-01): what the session's keyring is, the card Settings
    // shows when there is none, and its one button — install (pkexec), start, Restart Genie. Never fatal to boot.
    if (process.platform === 'linux') {
        try {
            // With a host, the card is the host's: the secrets are in its keychain, and Chromium's store says nothing about them. Only a window running its own engine reads that store for it.
            keyring = agentEngineLink.client.keyring();
        } catch (error) {
            console.warn('[genie] the keyring check failed', error);
        }
        keyring?.onChange(() => {
            pushFeatures();
            if (keyring?.canKeepSecrets()) void services?.moveSecretsAgain();
        });
        console.log(`[genie] keyring: ${keyring?.canKeepSecrets() ? 'can keep secrets' : 'cannot keep secrets'} (backend ${safeStorage.getSelectedStorageBackend()}, encryption ${safeStorage.isEncryptionAvailable() ? 'available' : 'unavailable'})`);
    }
    // The scoped desktop credential stays encrypted in the main process. This isolated cookie jar is used only for
    // the one-time pairing exchange; ordinary API requests explicitly omit it.
    const tynnSession = session.fromPartition('persist:tynn');
    // THE ACCOUNT IS THE HOST'S (P3.4 cut c); this window reads a replica.
    tynnAccount = agentEngineLink.client.tynn({ openExternal: (url) => shell.openExternal(url) });
    // A move of an older Genie's pairing that finished before this line had nobody to tell.
    void tynnAccount.reload().catch(() => {});
    tynnAccount.onChange(pushFeatures);
    // Signing in brings back the Tynn tools of the agents that started without them (genie#1234) — and once now, for an
    // account that signed in while it opened, before anyone was listening.
    tynnAccount.onChange(() => recoverTynnAgents());
    recoverTynnAgents();
    afterTynnUrl = pushFeatures;
    // A SIGN-IN THAT WAITED FOR THE KEYRING (linux-keyring.ts): the card's Restart Genie left a note (which sign-in, never
    // a code); with the keyring working now, Tynn's sign-in opens again by itself, so the person is not left to find it.
    if (takeResumeSignIn(genieRoot()) === 'tynn' && (keyring?.canKeepSecrets() ?? true) && !tynnAccount.status().signedIn) {
        void tynnAccount.startSignIn().then(({ url }) => { featureState = { ...featureState, tynnSignInUrl: url, tynnMessage: null }; pushFeatures(); }, () => { /* the person signs in by hand */ });
    }
    // GITHUB (beta.33 item 25; Genie 1's main/github/*): Genie 1's sign-in carried over — read from its genie.db, decrypted
    // with this Genie's safeStorage (the same userData, so the same key: measured) and kept encrypted in ~/.genie — or the
    // device flow. Every change reaches Settings and the Deck's signal at once; GitHub is read once now, and again on
    // Check again or after a sign-in (no polling of the API).
    // THE ACCOUNT AND ITS TOKENS ARE THE HOST'S (P3.4 cut c): this window reads a replica and asks the host to act.
    githubAccount = agentEngineLink.client.github({ openExternal: (url) => shell.openExternal(url) });
    githubAccount.onChange(() => { pushFeatures(); registry?.touch(); });
    // A move of an older Genie's sign-in that finished before this line had nobody to tell.
    void githubAccount.reload().catch(() => {});
    void githubAccount.refresh();
    // THIS MACHINE ON THE TYNN NETWORK (Tynn #836; Genie 1's ensureLocalWorkstation): signed in, it registers with that
    // Tynn once and keeps its key encrypted by the OS; every sign-in re-checks. One registration at a time, so a
    // sign-in landing during the launch's own check cannot make two workstations.
    const identityCipher = osCipher(safeStorage, process.platform);
    // THE KEY IS THE HOST'S (P3.4): this window asks it to sign.
    const machineIdentity: WorkstationPort = crashReportMachine = agentEngineLink.client.workstation();
    // GENIE 1'S RECORD OF THIS MACHINE (genie#1278 adopt on sign-in): its genie.db in the userData both share, its key
    // decrypted with this Genie's safeStorage (same userData, same OS key). Tynn takes that record over, or retires the
    // duplicate, on the next registration — once.
    const genie1Identity = async () => readGenie1Identity(readV1Settings(v1DatabaseFile()), identityCipher);
    // THIS MACHINE, ALL OF IT (this-machine.ts): this launch's registration, the identity Genie 2 stored for this Tynn,
    // and the one Genie 1 registered from the userData Genie 2 shares — "Your workstations" never lists any of them.
    thisMachineIds = () => machineIdentity.identity(tynnAccount?.host() ?? '').catch(() => null).then((stored) => thisMachineWorkstationIds({ registered: tynnWorkstationNow?.registered ? tynnWorkstationNow.workstationId : null, stored: stored?.workstationId ?? null, v1Settings: readV1Settings(v1DatabaseFile()) }));
    // THIS MACHINE'S STABLE KEY (genie#1278 W2): the OS machine id, never sent raw (machine-key.ts).
    const machineKey = (): Promise<string | null> => readMachineId({
        platform: process.platform,
        readFile: (path) => readFile(path, 'utf8'),
        exec: (command, args) => execFileText(command, [...args], { timeoutMs: 10_000 }),
    }).then((id) => (id ? machineKeyOf(id) : null));
    // WHAT TYNN SAYS THIS MACHINE IS (genie#1278 W5): Tynn's answer only; signed in, no answer is a drone.
    /*
     * THE REGISTRATION, THE ROLE AND THE RELAY LINK ARE GENIE-HOST'S (Tynn #410, P5d.3). This window mirrors them for what it
     * reads synchronously (fail closed: a drone until the host has answered) and hands over Genie 1's record, which only it
     * can open.
     */
    const linkedRelayHost = agentEngineLink.client.relayHost();
    {
        linkedRelayHost.onChange(() => { workstationRoleNow = linkedRelayHost.role(); workstationSaidNow = linkedRelayHost.said(); workstationWhyNow = linkedRelayHost.unknownWhy(); tynnWorkstationNow = linkedRelayHost.workstation(); relayStatusNow = linkedRelayHost.relay(); pushFeatures(); });
        void linkedRelayHost.refresh().catch((error: unknown) => console.error(`[tynn relay] ${error instanceof Error ? error.message : String(error)}`));
    }
    // The host reads, then this window takes its answer, so a caller that awaited it decides on the new role.
    readWorkstationRoleNow = async () => { await readRole(); await linkedRelayHost.refresh(); };
    const readRole = (): Promise<void> => linkedRelayHost.readRole();
    let registering: Promise<void> | null = null;
    const registerWorkstation = (): Promise<void> => {
        if (registering) return registering;
        if (!tynnAccount) return Promise.resolve();
        registering = (async () => { await linkedRelayHost.register(await genie1Identity().catch(() => null)); })().finally(() => { registering = null; pushFeatures(); });
        return registering;
    };
    registerWorkstationNow = registerWorkstation;
    tynnAccount.onChange(() => { void registerWorkstation(); });
    // Another account (or none): the relay windows opened under the last one hold its grants (M0 finding 2).
    tynnAccount.onChange(() => { closeRelayWindowsOfOtherAccounts(); });
    void registerWorkstation();
    // A sign-in that came back before the account was open (this launch's own argv, or an early second launch).
    if (pendingGenieUrl !== null) { const url = pendingGenieUrl; pendingGenieUrl = null; openGenieUrl(url); }
    // What agents run, each change with its own sound row (Tynn #766 C2b, core/thing-sounds.ts): a process exiting (a
    // site's own server is the site's), a site up or down, a service started, a flow run finished.
    const things = new ThingSounds();
    const siteProcess = (id: string) => composed.sites.list().some((s) => s.processIds.includes(id));
    things.sites(composed.sites.list());
    composed.supervisor.onChange((status) => { const kind = things.process(status, siteProcess(status.id)); if (kind) broadcast('genie:action', { agentId: null, kind }); });
    composed.sites.onChange(() => { for (const kind of things.sites(composed.sites.list())) broadcast('genie:action', { agentId: null, kind }); });
    composed.engines.onStarted(() => { broadcast('genie:action', { agentId: null, kind: 'serviceup' }); });
    composed.flows.onRun((_id, run) => { const kind = flowRunSound(run); if (kind) broadcast('genie:action', { agentId: null, kind }); });
    // GENIE'S BROWSER FOR A SITE'S OPEN — the Hosting row's and an agent's `sites open` alike (hosting-actions.ts
    // `openSite` checks the site is served first): the Genie browser WINDOW comes up with the site in a new tab (beta.35
    // item 36 — Genie 1's own window). The person sees what the agent opened; nothing opens outside Genie.
    // WHO ASKED decides whether it may take the keyboard (genie#1235): the Hosting row's Open is the person's click and
    // brings the window up; an agent's `sites open` opens it behind whatever the person is doing.
    const openInBrowserFor = (activation: Activation): OpenInBrowser => async (url) => {
        const opened = await openLocalBrowser(url, activation);
        return opened.ok ? { ok: true } : { ok: false, reason: opened.error };
    };
    // AN AGENT'S `sites open` (genie#1265): in the background, and the workspace the site belongs to pulses for the person.
    const agentOpensSite: OpenInBrowser = async (url) => {
        const r = await openInBrowserFor('background')(url);
        const host = ((): string | null => { try { return new URL(url).host.toLowerCase(); } catch { return null; } })();
        const site = r.ok && host ? composed.sites.list().find((s) => s.host.toLowerCase() === host) : undefined;
        if (site) showToPerson({ activation: 'background', workspaceId: site.workspaceId, reason: 'sites open' });
        return r;
    };
    // Bring back what the person keeps running (Genie 1 did, from terminal_specs); a hibernated workspace starts nothing.
    // Genie's own quit stops these through the supervisor and never touches the book, so a quit is not a stop.
    {
        // THE PROCESS BOOK AND ITS SCHEDULER ARE GENIE-HOST'S (P3.3c): what the person keeps running is restored there, and a
        // scheduled task fires on its clock, with or without this window. This window lists and manages them by replica.
        processBook = agentEngineLink.client.processBook();
        processScheduler = agentEngineLink.client.processBook();
    }
    // UPDATE CHANNEL (the owner, 2026-10-12: "stable and dev update channels"): the setting decides what the
    // updater may see — read once here, then followed on every change. `channelFrom` reads a legacy `beta` as dev.
    updates?.setChannel(channelFrom(composed.settings.snapshot().update_channel));
    composed.settings.onChange((key, value) => { if (key === 'update_channel') updates?.setChannel(channelFrom(value)); });
    // GENIE'S OWN MCP SERVER (§6.9): every tool registered, the loopback listening, the boot probe recorded.
    {
        // A Take Over terminal, or an agent SESSION by its caller key (`mcp-callers.ts`); anything else is nobody.
        // A FLOW calling Genie's tools as a step (genie#1204, main/flow-tools.ts) is a caller too: its own key, its workspace.
        const flowCallers = new FlowCallers((id) => registry?.workspace(id)?.path ?? null);
        // A caller genie-host vouched for, for a tool it forwarded here (P3.1): its session keys are the host's now.
        const vouchedCallers = new Map<string, Caller>();
        const resolveCaller = (terminalId: string) => vouchedCallers.get(terminalId) ?? flowCallers.callerFor(terminalId) ?? takeOvers?.callerFor(terminalId) ?? sessionCaller(terminalId);
        // The stores agents write to: genie-host's when it runs — its own tools write them there, and in this window they
        // are never reached (hostOnly says so if anything tries).
        // Every agent, the OS agent included: a tool finds its caller here (genie-tool-deps.ts `toolRoster`, Tynn story #385).
        const roster = () => toolRoster(registry!);
        // ONE builder for the tools' wiring (genie-tool-deps.ts) — doctor mode builds its agent's tools with it too.
        const signalled = withActionSignal(allGenieTools(genieToolDeps({
            // agentinbox list: whether each peer is running, read-only — never started by asking (core/liveness.ts).
            liveness: (id) => livenessOf(host?.probe(id as AgentId) ?? null, host?.rowsFor(id as AgentId).at(-1)?.at ?? null),
            inbox: hostOnly<InboxStore>('the AgentInbox'),
            attention: hostOnly<AttentionStore>('attention (questions, imDone, lists)'),
            knowledge: hostOnly<KnowledgeStore>('the knowledge graph'),
            settings: composed.settings,
            // ONE approval queue: genie-host's (a window tool's ask goes there).
            approve: (caller, action, detail, call) => composed.approvals.gate(caller, action, detail, call),
            roster,
            workspaceSlugs: () => registry?.workspaceSlugs() ?? new Map(),
            refusalForRecipient: (text) => registry?.mailRefusal(text) ?? null,
            resolveCaller,
            // createAgent: the workspace's default agent asks, the person approves in the Deck, the registry registers.
            agents: {
                defaultAgentOf: (workspaceId) => registry?.defaultAgentOf(workspaceId) ?? null,
                register: (input) => registry!.register(input),
            },
            // workspaceTabs (beta.35 item 36): the workspace's tabs setting (every window reloads it), and its sites' hosts.
            workspaceTabs: {
                write: (workspaceId, raw) => { void composed.settings.setFor(workspaceId, 'workspace_tabs', raw); showToPerson({ activation: 'background', workspaceId, reason: 'workspaceTabs' }); },
                sites: (workspaceId) => composed.sites.list().filter((s) => s.workspaceId === workspaceId).map((s) => s.host),
            },
            // pages (browser rebuild step 7): the Genie browser's tabs and the live site panels, each drivable.
            pages: { open: () => [...drivablePages(), ...browserPages.list()] },
            userActive: () => powerMonitor.getSystemIdleTime() < 120,
            glow: (terminalId) => { broadcast('genie:glow', terminalId); return true; },
            // A sound row of its own (Tynn #766 C2a): the window plays genie:action by its kind.
            thumbsUp: (caller, reason) => { broadcast('genie:action', { agentId: caller.agentId, kind: 'thumbsup', reason }); },
            issueWatch: { forWorkspace: (workspaceId) => issueWatchSummaryFor(workspaceId), refresh: (workspaceId) => issueWatchRefreshFor(workspaceId), recheckSignIn: () => { void tynnAccount?.recheck(); } },
            // In GENIE (genie#922): that workspace's file panel on the file, and Genie brought forward — never the OS's default app.
            openFile: async ({ workspaceId, path, line }) => { attractMainWindow('openFileForUser'); showToPerson({ activation: 'background', workspaceId, file: path, line, reason: 'openFileForUser' }); return { ok: true }; },
            // The `plan` tool: into the caller's own session, so its Active Plan column shows it.
            reportPlan: (agentId, steps) => host?.reportPlan(agentId as AgentId, steps) ?? false,
            // ...and read back from the agent's record, where every plan is kept across restarts (identity.ts `plan`).
            readPlan: (agentId) => registry?.find(agentId as AgentId)?.plan ?? null,
            terminals: {
                list: () => terminals!.list(),
                open: (options) => terminals!.open(options),
                write: (id, data) => terminals!.write(id, data),
                scrollback: (id) => terminals!.scrollback(id),
                finished: (id) => terminals!.finished(id),
                // fancy-term-host's SCROLLBACK_MAX (1e6 characters): a buffer at the cap has been cut, and `manageTerminals` reads report `dropped`.
                scrollbackCap: 1_000_000,
            },
            // An agent's terminal gets the env the Terminals tab gives the person's (service engines + Genie's endpoint).
            terminalEnv: (workspaceId) => terminalEnvFor(composed, workspaceId, mcpEnv()),
            // The agents' `services` / `sites` tools act on the same composition the Services and Hosting tabs do.
            hosting: composed,
            // `sites open` shows the site in the same browser the Hosting row's Open does — without taking focus (genie#1235)
            // or the tab on screen, and the site's workspace pulses (genie#1265).
            openInBrowser: agentOpensSite,
            // The agents' `processes` tool acts on the Processes tab's own book, and reads the supervisor's kept logs.
            ...(processBook ? { processes: { book: processBook, logs: (id: string, lines?: number) => composed.supervisor.readLog(id, lines), ...(processScheduler ? { runNow: (id: string) => processScheduler!.runNow(id) } : {}) } } : {}),
            // The agents' `flows` tool: the Flows tab's own store, and the scheduler's Run now (the tool runs only armed flows).
            flows: { store: composed.flows, runNow: (id: string) => composed.flowScheduler.runNow(id) },
            // `services exec`: a one-off command with the workspace's service variables (main/service-exec.ts).
            serviceExec: runServiceExec,
            // The plugins' tools are GENIE-HOST'S (ADF A3, Tynn #447): its MCP server offers and runs them with no window.
            plugins: { tools: () => [], guard: () => null, run: async () => ({ ok: false, reason: "a plugin's tool runs in Genie's host, not this window" }) },
        })), resolveCaller, (agentId, kind, tool) => broadcast('genie:action', { agentId, kind, tool }));
        // With genie-host the host's own tools are asked of it, with the caller resolved here (a flow's step); the rest run here.
        const engineLink = agentEngineLink?.client ?? null;
        const registrations = engineLink ? withHostTools(signalled, engineLink, resolveCaller) : signalled;
        mcpToolList = registrations.map((r) => ({ name: r.definition.name, description: r.definition.description ?? '' }));
        // Flows' tool steps call these very registrations, as the flow (genie#1204).
        composed.setFlowToolCaller(createFlowToolCaller({ registrations, callers: flowCallers }));
        if (engineLink) {
            /*
             * GENIE'S MCP SERVER IS GENIE-HOST'S (the host split, P3.1; plan §11d): agents keep its tools when this window
             * closes. This window runs the tools that still need it (forwarded), and tells the host what those need of the
             * registry and settings until P3.2 — the first time starts the host's server.
             */
            windowToolRun = windowToolRunner(() => registrations, vouchedCallers);
            for (const call of openFilesLater.splice(0)) void windowToolRun(call);
            const view = (): WindowView => {
                return {
                    workspaceNames: Object.fromEntries((registry?.snapshot().workspaces ?? []).map((w) => [w.id, w.name ?? w.id])),
                    userActive: powerMonitor.getSystemIdleTime() < 120,
                    callers: takeOvers?.callers() ?? {},
                };
            };
            let pushTimer: ReturnType<typeof setTimeout> | null = null;
            pushHostView = () => {
                if (pushTimer) return;
                pushTimer = setTimeout(() => { pushTimer = null; void engineLink.pushWindowView(view()); }, 250);
            };
            registry?.subscribe(() => pushHostView());
            // Whether the person is at the computer, for ForceTheQuestion's "they are away": re-said every half minute.
            setInterval(() => pushHostView(), 30_000).unref?.();
            // A reconnect (the host restarted): it learns all of it again.
            engineLink.onLink(() => { void engineLink.pushWindowView(view()); }, () => {});
            await engineLink.pushWindowView(view());
            // Genie 1's memories and AgentInbox history, once — the host owns the stores; only this window knows where v1 lives.
            void engineLink.v1Import(v1DatabaseFile());
            const status = await engineLink.mcpStatus();
            hostMcpEndpoint = status?.endpoint ?? null;
            mcpVerified = status?.verified ?? { ok: false, reason: 'genie-host did not start its MCP server' };
            if (status) mcpToolList = status.tools;
        }
        try {
            // THE WORKSPACE AGENT FILES (the owner: Genie 2 manages them all and upgrades Genie 1's): every workspace once the
            // endpoint is live, and every workspace added after — whichever path added it — by watching the registry.
            const synced = new Set<string>();
            const syncNew = () => {
                for (const w of registry?.listWorkspaces() ?? []) {
                    if (synced.has(w.path)) continue;
                    synced.add(w.path);
                    void composed.syncAgentDocs(w.path).catch((error: unknown) => { console.error(`[workspace-files] ${w.id} protocol: ${(error as Error).message}`); });
                    void composed.syncConfig(w.path).then(
                        (results) => { for (const r of results) if (!r.ok) console.error(`[workspace-files] ${w.id} ${r.label}: ${r.error ?? "failed"}`); },
                        (error: unknown) => { console.error(`[workspace-files] ${w.id}: ${(error as Error).message}`); },
                    );
                }
            };
            syncNew();
            registry?.subscribe(() => syncNew());
            tynnAccount?.onChange(() => {
                // THE WORK MODEL (Tynn story #402): signing in to Tynn, or out, changes what the protocol tells every agent
                // about where its work is planned, so every workspace's protocol is written again (only a changed file is).
                for (const w of registry?.listWorkspaces() ?? []) {
                    void composed.syncAgentDocs(w.path).catch((error: unknown) => { console.error(`[workspace-files] ${w.id} protocol: ${(error as Error).message}`); });
                }
            });
            // SIGNING IN TO TYNN LATER (Genie 1 provisioned on the next activation): every workspace linked to a Tynn
            // project is synced again, so one with no token yet gets it now. One already carrying a token is not minted again.
            tynnAccount?.onChange(() => {
                if (!tynnAccount?.status().signedIn) return;
                for (const w of registry?.listWorkspaces() ?? []) {
                    if (tynnProjectFor(w.id) === null) continue;
                    void composed.syncConfig(w.path).then(
                        (results) => { for (const r of results) if (!r.ok) console.error(`[workspace-files] ${w.id} ${r.label}: ${r.error ?? 'failed'}`); },
                        (error: unknown) => { console.error(`[workspace-files] ${w.id}: ${(error as Error).message}`); },
                    );
                }
            });
        } catch (error) {
            console.error('[workspace-files] could not start syncing:', error instanceof Error ? error.message : String(error));
        }
        pushFeatures();
    }
    // RESTORE AFTER A RELAUNCH OR UPGRADE (§7.6): only with the ONE setting on; starts spaced three seconds apart; what the
    // user stopped was not running at quit, so it is not in the list. Taken once, so a crash mid-restore starts nobody twice.
    // The agents a shutdown cut off mid-turn are resumed WHATEVER the setting (Genie cancelled their turn, not you) and
    // told to continue; the rest only with the setting on, unprompted.
    // SAFE MODE (Tynn #386): genie-host said so before ready; then nobody is started or resumed and both lists are KEPT.
    void restoreAfterRelaunch({
        safeMode: windowSafeNow,
        takeRunningAtQuit: () => registry!.takeRunningAtQuit(),
        takeInterruptedAtQuit: () => registry!.takeInterruptedAtQuit(),
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
            if (!record || !host) return;
            const engine = host;
            await engine.start(record, cwdFor(record));
            // A start that was refused has no session to take the resume prompt: it is KEPT as owed, and the agent's
            // Restart delivers it (genie#1238). It used to be dropped, and the interrupted work with it.
            if (resume && !(await engine.prompt(record.id, RESUME_AFTER_RESTART, 'genie'))) await engine.recordOwed(record.id, RESUME_AFTER_RESTART, 'genie');
        },
        log: lifecycleLog,
    });
    // Safe mode reaches every window's snapshot (its banner), and follows the host's changes (a Leave from any window).
    registry.setSafeMode(() => windowSafe?.view() ?? null);
    windowSafe?.onChange(() => registry?.touch());
    // THE REOPENED WINDOW'S NOTICE (Tynn #386): a hung window was ended and this one started; every snapshot carries it.
    registry.setHangNotice(() => agentEngineLink?.client.crashStateView()?.notice ?? null);
    registry.setRendererNotice(() => rendererNotice);
    agentEngineLink?.client.onCrashState(() => registry?.touch());
    // Listening (or the reason not) reaches Settings → Workstation as soon as it is known.
    // OFF BY DEFAULT (Tynn #820; the owner, 2026-10-19): the listener runs only while `remote_access` is on — applied now and
    // whenever the setting changes (feature-ipc's settings.set). Listening, or why not, reaches Settings as soon as known.
    remoteAccessNow = { apply: () => linkedRemote.apply(), restart: () => linkedRemote.restart() };
    void remoteAccessNow.apply().catch((error: unknown) => { console.error(`[remote] ${error instanceof Error ? error.message : String(error)}`); pushFeatures(); });
    // The Deck's signal strip, MEASURED (§4.5): flows in flight, mail agents have not collected, GitHub blocking (what the GitHub
    // sign-in read from GitHub), the OS agent working.
    registry.setSignals(() => composed.signals({ osAgentWorking: (() => { const os = registry?.osAgent(); return os ? host?.probe(os.id)?.turnState === 'working' : false; })(), githubBlocked: (githubAccount?.view().signal ?? null) !== null }));
    // THE DECK'S ITEMS beyond live permission requests: questions agents asked, the person's list, mail to the person,
    // finished agents, Genie's tool approvals. Built in compose and never read before (the owner never saw a question).
    registry.setDeckSource(() => [...mainErrors.deckItems(), ...composed.deckItems()]);
    // An error the main process caught and survived (the policy at the top of this file) reaches the Deck at once.
    mainErrors.onChange(() => registry?.touch());
    // Genie's own Deck item (Trust its certificate) follows the front door: read trusted, a site added, Not now.
    composed.onFrontDoorChange(() => registry?.touch());
    // A question asked or answered, a list item, a finished agent: the snapshot (and so the Deck, its badge and the
    // "an agent asks you something" alert) follows at once.
    composed.attention.onChange(() => registry?.touch());
    // The workspace dashboard's "Last finished" (q_09d1f4a0): each agent's last handoff, from the same record.
    registry.setHandoffProbe((id) => composed.attention.lastHandoff(id));
    // An agent's gated tool call (processes / services / sites / manageTerminals) parked or answered: the Deck shows it
    // or takes it off at once. Without this a parked request reached the Deck only with some unrelated push, or never.
    composed.approvals.onChange(() => registry?.touch());
    // MAIL WAKES THE AGENT: started as Start would be (opening starts nothing since q_04ce323c) — an asleep workspace or the agent cap refuses, and the notice waits.
    // One path for every source that may wake an agent: mail, and IssueWatch's `push`.
    const wakeAgent = windowWake({
        safeMode: windowSafeNow,
        find: (agentId) => (host ? registry?.find(agentId as AgentId) ?? null : null),
        running: (record) => host?.probe(record.id)?.running === true,
        refusal: (record) => startRefusal(workspaceOps, record, {
            running: registry!.agentsOf(record.workspaceId).filter((a) => host!.probe(a.id)?.running === true).length,
            cap: agentCapFrom(composed.settings.snapshotFor(record.workspaceId) ?? {}),
        }),
        start: async (record) => (host ? (await host.start(record, cwdFor(record))).ok : false),
        log: (line) => console.log(line),
    });
    // §6.4 THE INBOX PUSH (main/inbox-push.ts): Genie itself puts the notice into the agent's session, for every provider.
    // NOBODY HAS TO TYPE (genie#1379): every agent with a session is told after the coalescing window — a busy one at its
    // next step, as typed input arrives (genie#1411). An app's message starts a stopped agent only if it is automated and
    // the app wake cap allows; a turn only apps' mail opens is spent from that cap, and past it the mail waits for the window.
    // With genie-host the MAIL WAKE is the host's (P3.2, host-mail-wake.ts): an agent is told, and a stopped one started,
    // with no window.
    // THE WORKSPACE'S APPS AND SCRIPTS CARD (genie#1345): this host's own local window; a key is
    // never minted for a window driving another machine. Rotate / Revoke / Allow restart the source so it starts with
    // its new credential, or none.
    const appInboxState = (workspaceId: string) => ({
        url: linkedAppInbox.url(),
        enabled: composed.settings.snapshotFor(workspaceId).app_inbox !== false,
        sources: appInboxKeys.sources(workspaceId),
        revoked: appInboxKeys.revokedSources(workspaceId),
        scriptKeys: appInboxKeys.scriptKeys(workspaceId),
    });
    const restartSource = async (workspaceId: string, kind: AppSourceKind, id: string): Promise<string> => {
        if (kind === 'site') {
            const restarted = composed.sites.serviceEnvChanged(workspaceId);
            return restarted.includes(id) ? 'restarted with it' : 'its next start uses it';
        }
        if (kind === 'process' && processBook) {
            const live = composed.supervisor.status(id);
            if (live?.state === 'running' || live?.state === 'restarting') { await processBook.restart(id); return 'restarted with it'; }
        }
        return 'its next start uses it';
    };
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
    issueWatchNow?.onChange(() => { pushFeatures(); });
    issueWatchNow?.onSound((kind) => { broadcast('genie:action', { agentId: null, kind }); });
    // The human's conversation is in the features snapshot (an observed agent's chat): new mail and read receipts
    // push it, so a reply or a "read 14:07" lands without anyone polling.
    composed.inbox.onSend(() => { pushFeatures(); });
    composed.inbox.onRead(() => { pushFeatures(); });
    // MAIL BETWEEN AGENTS ON THE BOARD (genie#1209): who sent which message to whom, and which were read.
    composed.inbox.onSend((to, message) => { broadcast('genie:action', { agentId: message.from, kind: 'mail-sent', to, id: message.id }); });
    composed.inbox.onRead((reader, ids) => { if (ids && ids.length > 0) broadcast('genie:action', { agentId: reader, kind: 'mail-read', ids }); });
    // Agent-to-agent mail changes the Dashboard's comms cells: rebuild the snapshot on every send.
    composed.inbox.onSend(() => { registry?.touch(); });
    // One agent writing to another is the sender's action, with its own sound row (Tynn #766 C2a).
    composed.inbox.onSend((_to, message) => { const action = mailAction(message); if (action) broadcast('genie:action', action); });
    // The card is the notification: arrival, refusal and acceptance refresh both participants' watched chats.
    wireInboxChatUpdates(composed.inbox, pushAgent);
    // THE TOOLCHAIN'S ACTIONS (toolchain-ops.ts): the real runner, process.env and the filesystem; progress is drawn as
    // the surface's busy line, pushed — nobody polls an install.
    const toolchainOps = (): ToolchainOpsPorts => ({
        platform: process.platform as Platform,
        run: longRunner,
        env: processEnv,
        fs: nodeToolchainFs(),
        dataDir: toolchainDataDir(),
        systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        packageManager,
        progress: (step) => { featureState = { ...featureState, toolchainBusy: step }; pushFeatures(); },
        now: Date.now,
        // Genie's own Node, newest first (main/node-versions.ts): Check and repair makes it the node and npm Genie runs.
        genieNode: () => managedNode({ platform: process.platform as NodeVersionsPorts['platform'], root: nodeVersionsRoot(toolchainDataDir()), fs: nodePhpVersionsFs() })[0] ?? null,
    });
    const phpVersionsPorts = (): PhpVersionsPorts => ({
        ...phpVersionsBase(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        cpus: availableParallelism(),
        // The VC++ runtime through T1's own consented install (winget); the click on Install PHP is the consent.
        ensureVcRuntime: async () => {
            const r = await installTool('vcredist', true, toolchainOps());
            return r.kind === 'installed' || r.kind === 'already-installed' ? { ok: true } : { ok: false, reason: r.reason };
        },
        progress: (step) => { featureState = { ...featureState, toolchainBusy: step }; pushFeatures(); },
    });
    const nodeVersionsPorts = (): NodeVersionsPorts => ({
        platform: process.platform as NodeVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: nodeVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => { featureState = { ...featureState, toolchainBusy: step }; pushFeatures(); },
    });
    const goVersionsPorts = (): GoVersionsPorts => ({
        platform: process.platform as GoVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: goVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => { featureState = { ...featureState, toolchainBusy: step }; pushFeatures(); },
    });
    const pythonVersionsPorts = (): PythonVersionsPorts => ({
        platform: process.platform as PythonVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: pythonVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        cpus: availableParallelism(),
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => { featureState = { ...featureState, toolchainBusy: step }; pushFeatures(); },
    });
    const dotnetVersionsPorts = (): DotnetVersionsPorts => ({
        platform: process.platform as DotnetVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: dotnetVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => { featureState = { ...featureState, toolchainBusy: step }; pushFeatures(); },
    });
    const rustVersionsPorts = (): RustVersionsPorts => ({
        platform: process.platform as RustVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: rustVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => { featureState = { ...featureState, toolchainBusy: step }; pushFeatures(); },
    });
    const rubyVersionsPorts = (): RubyVersionsPorts => ({
        platform: process.platform as RubyVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: rubyVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        // Windows' own tar.exe, by full path: it reads RubyInstaller's .7z; Git's tar on PATH does not.
        windowsTar: join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe'),
        cpus: availableParallelism(),
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => { featureState = { ...featureState, toolchainBusy: step }; pushFeatures(); },
    });
    const javaVersionsPorts = (): JavaVersionsPorts => ({
        platform: process.platform as JavaVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: javaVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => { featureState = { ...featureState, toolchainBusy: step }; pushFeatures(); },
    });
    // EACH LANGUAGE'S DEFAULT, set: the `current/<lang>` link repointed, then put first on the PATH Genie gives everything it
    // starts from now on (main/toolchain-defaults.ts). Shared by Toolchain's "make default" and an update (genie#1306).
    const setLanguageDefault = (lang: Parameters<typeof setDefault>[0], version: string | null) => {
        const platform = process.platform as Platform;
        const linkPorts = { platform, toolchainDir: toolchainDataDir(), fs: nodeLinkFs(platform) };
        const managed = (l: typeof lang): string[] => (l === 'node' ? managedNode(nodeVersionsPorts()) : l === 'go' ? managedGo(goVersionsPorts()) : l === 'python' ? managedPython(pythonVersionsPorts()) : l === 'dotnet' ? managedDotnet(dotnetVersionsPorts()) : l === 'rust' ? managedRust(rustVersionsPorts()) : l === 'ruby' ? managedRuby(rubyVersionsPorts()) : l === 'java' ? managedJava(javaVersionsPorts()) : managedPhp(phpVersionsBase())).map((m) => m.version);
        const outcome = setDefault(lang, version, { ...linkPorts, managed });
        if (outcome.kind !== 'refused') restoreDefaultsEnv({ ...linkPorts, env: processEnv });
        return outcome;
    };
    const busyLine = (step: string | null) => { featureState = { ...featureState, toolchainBusy: step }; pushFeatures(); };
    /**
     * UPDATING A LANGUAGE (genie#1306): Genie's own installer for it — the same one "Install" runs, checksum-verified, into
     * Genie's toolchain — then its default moved to the new version. Never a package manager: on the owner's machine every
     * language was a Genie-managed install, and `winget upgrade` answered "no installed package" (0x8A150014). Each
     * installer step is the row's step and the busy line.
     */
    const languageUpdates = (row?: (step: string | null) => void): LanguageUpdatePorts => {
        const progress = (step: string | null) => { busyLine(step); if (step) row?.(step); };
        return {
            install: async (tool, version) => {
                if (tool === 'php') return installPhpVersion(version, true, { ...phpVersionsPorts(), progress });
                if (tool === 'go') return installGoVersion(version, true, { ...goVersionsPorts(), progress });
                if (tool === 'python') return installPythonVersion(version, true, { ...pythonVersionsPorts(), progress });
                const outcome = await installNodeVersion(version, true, { ...nodeVersionsPorts(), progress });
                if (outcome.kind === 'installed' && process.platform === 'win32') preferGenieNode(toolchainOps(), outcome.dir);
                return outcome;
            },
            setDefault: (tool, version) => setLanguageDefault(tool, version),
            progress: (step) => { busyLine(step); if (step) row?.(step); },
        };
    };
    const featurePorts: FeaturePorts = {
        ...processPorts(),
        openInBrowser: openInBrowserFor('user-gesture'),
        // "Leave safe mode" (Tynn #386): the host's; this window only asks.
        safeMode: { leave: () => (windowSafe ? windowSafe.leave() : Promise.resolve({ ok: false as const, reason: 'Genie is still starting' })) },
        // The brought-back page's notice: forget it.
        rendererNotice: { dismiss: async () => { rendererNotice = null; registry?.touch(); return { ok: true as const }; } },
        // The reopened-window notice's two actions: forget it; or stop every agent — one click, the person's, never automatic.
        hangNotice: {
            dismiss: () => (agentEngineLink ? agentEngineLink.client.dismissHangNotice() : Promise.resolve({ ok: false as const, reason: 'Genie’s host is not connected' })),
            stopAll: async () => {
                if (!agentEngineLink) return { ok: false as const, reason: 'Genie’s host is not connected' };
                try { await agentEngineLink.client.stopAll(); return { ok: true as const }; } catch (error) { return { ok: false as const, reason: error instanceof Error ? error.message : String(error) }; }
            },
        },
        // The flow editor's own window (genie#1204): Open, a row's name, Add a flow — the person's click.
        openFlowEditor: (route) => openFlowEditorWindow(route, 'user-gesture'),
        // An approval's note reaches the agent (beta.33 item 16): now, or when its turn ends.
        deliverToAgent: (agentId, text) => host?.deliver(agentId as AgentId, text, 'you') ?? false,
        // The Deck's actions on a recorded main-process error: Dismiss; the host's copy made now; the lifecycle log opened.
        mainErrors: {
            dismiss: (id) => mainErrors.dismiss(id),
            retryHostCopy: (id) => retryHostCopy(mainErrors, id, () => remakeHostCopy()),
            openLog: () => shell.openPath(join(runtimeDir(genieRoot()), 'lifecycle.log')).then((failed) => failed || null),
        },
        toolchain: {
            // Not signed in on the Toolchain: the provider's own login, as the Agent view's Log in opens it (Tynn #698).
            login: (provider) => { const started = loginHost?.start(provider) ?? { ok: false as const, reason: 'Genie’s login window is not ready yet; try again in a moment' }; return started.ok ? { ok: true } : started; },
            // An agent CLI the health check finds cannot run reads Broken, with why (Tynn #698).
            probe: async () => withProviderHealth(await probeToolsLive(latestFor), await providerHealth.refreshAll()),
            update: async (tool, version, progress) => runUpdate(tool, { platform: process.platform as Platform, packageManager: await packageManager() }, longRunner, version ?? null, languageUpdates(progress)),
            // The row's in-progress state, pushed: which update, and its step (genie#1306).
            updating: (row) => { featureState = { ...featureState, toolchainUpdating: row }; pushFeatures(); },
            now: Date.now,
            // THE UPDATE GUARD's input, read at the moment of the click: running sessions with their provider, Genie-run
            // processes with their command, running service engines by name.
            activity: async () => ({
                sessions: (registry?.listAgents() ?? []).filter((a) => host?.probe(a.id as AgentId)?.running === true).map((a) => ({ label: a.name, provider: a.provider })),
                processes: composed.supervisor.list().filter((p) => p.state === 'running' || p.state === 'restarting').map((p) => ({ id: p.id, label: p.name, command: composed.supervisor.command(p.id) ?? '' })),
                engines: (await composed.engineStatuses()).filter((e) => e.status === 'running').map((e) => e.instance.containerName ?? `${e.instance.engine} ${e.instance.version}`),
            }),
            install: (tool, consent) => installTool(tool, consent, toolchainOps()),
            preview: async (tool) => {
                const plan = planInstall({ tool, platform: process.platform as Platform, packageManager: await packageManager() });
                return 'refused' in plan ? { refused: plan.refused } : { label: plan.label, elevated: plan.elevated };
            },
            // Repaired here, in the window's environment — and pushed to genie-host's, so a site's php-cgi it starts next reads
            // the new PHP_INI_SCAN_DIR and PATH with no host restart (P5a.2; config is hot-swappable).
            repair: async () => {
                const report = await checkAndRepair(toolchainOps());
                await agentEngineLink?.client.pushEnv().catch((error: unknown) => console.error(`[toolchain] genie-host did not take the repaired environment: ${error instanceof Error ? error.message : String(error)}`));
                return report;
            },
            // T4: managed PHP versions (main/php-versions.ts) — the installer's progress is the same pushed busy line.
            php: {
                list: (pins) => listPhpVersions(phpVersionsPorts(), pins),
                install: (version, consent) => installPhpVersion(version, consent, phpVersionsPorts()),
                remove: (version, pins) => removePhpVersion(version, pins, phpVersionsBase()),
            },
            // Genie's own Node (main/node-versions.ts) — same busy line.
            node: {
                list: () => listNodeVersions(nodeVersionsPorts()),
                // An installed Node becomes the one Genie runs at once (and at every launch after): the owner's "genie
                // has its own install path".
                install: async (version, consent) => {
                    const outcome = await installNodeVersion(version, consent, nodeVersionsPorts());
                    // Windows' build keeps node at the top of its folder. Elsewhere it is bin/, and which Node is the default
                    // there is the shims row (TC3, plan .ai/plans/genie-2-toolchain-rest.md), not a PATH-first here.
                    if (outcome.kind === 'installed' && process.platform === 'win32') preferGenieNode(toolchainOps(), outcome.dir);
                    return outcome;
                },
                remove: (version) => removeNodeVersion(version, nodeVersionsPorts()),
            },
            // The machine's own PATH (the owner's decision 3): the fixed `current` entries, once, with consent.
            machinePath: (() => {
                const mpPorts = (): MachinePathPorts => ({ platform: process.platform as Platform, home: homedir(), entries: defaultPathEntries(toolchainDataDir(), process.platform as Platform), fs: nodeMachinePathFs(), run: longRunner });
                const targets = (): string[] => process.platform === 'win32' ? ['the user PATH (HKCU\\Environment)'] : ['.profile', '.bash_profile', '.bashrc', '.zprofile', '.zshrc'].filter((f, i) => i === 0 || nodeMachinePathFs().exists(join(homedir(), f))).map((f) => join(homedir(), f));
                return {
                    status: async () => ({ ...(await machinePathStatus(mpPorts())), entries: mpPorts().entries, targets: targets() }),
                    apply: (consent: boolean) => applyMachinePath(consent, mpPorts()),
                    remove: () => removeMachinePath(mpPorts()),
                };
            })(),
            // Each language's default: the `current/<lang>` link, applied to Genie's PATH at once (and at every launch).
            defaults: {
                list: () => listDefaults({ platform: process.platform as Platform, toolchainDir: toolchainDataDir(), fs: nodeLinkFs(process.platform as Platform) }),
                set: (lang, version) => setLanguageDefault(lang, version),
            },
            // Genie's own Go (main/go-versions.ts) — same busy line. Its default is `defaults` above.
            go: {
                list: () => listGoVersions(goVersionsPorts()),
                install: (version, consent) => installGoVersion(version, consent, goVersionsPorts()),
                remove: (version) => removeGoVersion(version, goVersionsPorts()),
            },
            // Genie's own Python (main/python-versions.ts) — same busy line. Windows now; macOS/Linux are TC4b.
            python: {
                list: () => listPythonVersions(pythonVersionsPorts()),
                install: (version, consent) => installPythonVersion(version, consent, pythonVersionsPorts()),
                remove: (version) => removePythonVersion(version, pythonVersionsPorts()),
            },
            // Genie's own .NET SDKs (main/dotnet-versions.ts) — same busy line.
            dotnet: {
                list: () => listDotnetVersions(dotnetVersionsPorts()),
                install: (version, consent) => installDotnetVersion(version, consent, dotnetVersionsPorts()),
                remove: (version) => removeDotnetVersion(version, dotnetVersionsPorts()),
            },
            // Genie's own Rust (main/rust-versions.ts) — same busy line.
            rust: {
                list: () => listRustVersions(rustVersionsPorts()),
                install: (version, consent) => installRustVersion(version, consent, rustVersionsPorts()),
                remove: (version) => removeRustVersion(version, rustVersionsPorts()),
            },
            // Genie's own Ruby (main/ruby-versions.ts) — same busy line. Linux; Windows and macOS wait on the owner.
            ruby: {
                list: () => listRubyVersions(rubyVersionsPorts()),
                install: (version, consent) => installRubyVersion(version, consent, rubyVersionsPorts()),
                remove: (version) => removeRubyVersion(version, rubyVersionsPorts()),
            },
            // Genie's own Java (main/java-versions.ts; Temurin) — same busy line. Windows and Linux.
            java: {
                list: () => listJavaVersions(javaVersionsPorts()),
                install: (version, consent) => installJavaVersion(version, consent, javaVersionsPorts()),
                remove: (version) => removeJavaVersion(version, javaVersionsPorts()),
            },
        },
        // Which part of a features snapshot was slow (genie-test-windows, job Q0: an action took 20 s, main mostly free).
        slowPart: { ms: 1_000, log: (part, ms) => lifecycleLog(`features slow part=${part} ms=${ms}`) },
    };
    // THE FORCETHEQUESTION WINDOW (§6.3; the owner, 2026-10-14: "a window that opens on top of all other windows"). It
    // reads the SAME items Pending Questions (the Deck) shows and answers through the same action, so the two stay one
    // workflow: a question asked opens it; one answered in either place leaves both.
    questionWindow = new QuestionWindow({
        items: () => composed.deckItems(),
        open: electronQuestionWindow({ here, preload: join(here, 'question-preload.cjs'), controller: () => questionWindow, workspacePath: (id) => registry?.workspace(id)?.path ?? null }),
        answer: async (item, selections, notes) => { await handleFeatureAction(composed, { kind: 'deck.answerForm', item, selections, notes, note: '' }, featureState, featurePorts); },
        // Dismiss, beside Later: the same action as the Deck's — the question leaves both and its agent is told, with the
        // notes the person wrote in the form.
        dismiss: async (item, notes) => { await handleFeatureAction(composed, { kind: 'deck.dismiss', item, notes }, featureState, featurePorts); },
        // Do Not Disturb (Settings → General) is the ONE thing that keeps the window shut (the owner, 2026-10-15: "If DnD
        // is not turned on then FTQ always opens for every agent"). Read at every change; the agent is still told the DND
        // reply at once (attention-store.ts), and the question waits in Pending Questions.
        dnd: () => composed.settings.snapshot().do_not_disturb === true,
    });
    composed.attention.onChange(() => questionWindow?.changed());
    // Questions already waiting when Genie starts come up too.
    questionWindow.changed();
    ipcMain.handle(FEATURE_CHANNELS.browserBounds, (_event, raw: unknown) => {
        const b = raw as { x: number; y: number; width: number; height: number };
        if (!browserPane || typeof b?.width !== 'number') return;
        // A zero-sized box means the surface is not on screen: hide rather than paint over another surface.
        if (b.width === 0 || b.height === 0) browserPane.hide();
        else browserPane.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
    });
    /*
     * AN ACTION, FROM WHOEVER THE HOST ADMITTED (genie#1354, host-picks.ts; Tynn #560). Only this machine's own window names
     * a host path. A window's action also moves the window's own state and its browser pane; another device's never did.
     */
    async function runFeatureAction(action: FeatureAction, context: CallContext | undefined): Promise<FeatureData> {
        let data: FeatureData;
        try {
            data = await handleFeatureAction(composed, action, featureState, featurePorts, featureOriginOf(context, hostPicks));
        } catch (error) {
            if (action.kind.startsWith('deck.')) lifecycleLog(deckRefusalLine(action, error));
            throw error;
        }
        if (!isWindowCaller(context)) return data;
        if (action.kind.startsWith('integrations.tynn')) featureState = { ...featureState, tynnSignInUrl: data.integrations?.tynn.signInUrl ?? null, tynnMessage: data.integrations?.tynn.message ?? null };
        if (action.kind.startsWith('toolchain.')) featureState = { ...featureState, ...toolchainStateFrom(data.toolchain), toolchainBusy: null };
        featureState = { ...featureState, knowledgeQuery: data.knowledge.query, knowledgeAdding: data.knowledge.adding, knowledgeLastAdd: data.knowledge.lastAdd, lastSync: data.integrations?.lastSync ?? featureState.lastSync ?? null };
        if (action.kind === 'browser.navigate') featureState = { ...featureState, browserUrl: data.browser.url };
        if (action.kind === 'browser.navigate' && browserPane && data.browser.url) {
            const shown = await browserPane.show(data.browser.url);
            if (!shown.ok) console.error('[genie] browser:', shown.reason);
        }
        // The pane's own history; where it lands comes back through browserPane.onChange below.
        if (action.kind === 'browser.back') browserPane?.back();
        if (action.kind === 'browser.forward') browserPane?.forward();
        if (action.kind === 'browser.reload') browserPane?.reload();
        // An engine's log, once asked for, stays open across pushed snapshots until the person hides it (H6).
        featureState = { ...featureState, siteAdding: data.hosting?.adding ?? null, siteEditing: data.hosting?.editing ?? null, flowAdding: data.flows?.adding ?? null, serviceAdding: data.services?.adding ?? null, serviceLogs: data.services?.logs ?? null, serviceUpdating: data.services?.updating ?? null };
        return data;
    }

    // PUSH, both ways. The registry says when the estate changed; the host says when one
    // agent did. Nothing here is on a timer.
    registry.subscribe((snapshot) => {
        if (window && !window.isDestroyed()) window.webContents.send('genie:changed', snapshot);
        // The tray follows the Deck: the badge's own count (core/deck.ts needsYouCount), redrawn only when it changes.
        const waiting = needsYouCount(snapshot.deckItems ?? []);
        if (waiting !== trayWaiting) { trayWaiting = waiting; refreshTray(); }
    });
    // Rare workspace visibility changes refresh all popped-out views; agent activity above stays main-window only.
    registry.subscribeWorkspaceVisibility((snapshot) => broadcast('genie:changed', snapshot));
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
        pushAgent(agentId);
        // Which agents are started, for doctor mode — rewritten only when that set changes.
        const started = host?.startedIds().sort() ?? [];
        if (started.join(',') !== published) { published = started.join(','); markGenieRunning(genieRoot(), started); }
        // A model or tool setting waiting for this agent to be free applies the moment it is.
        settingApplier?.changed(agentId);
        estate.request('estate');
    });
    // A saved setting changes the agent's RECORD, not its session: the Agent view reads it from the detail.
    registry.subscribeAgentRecords(pushAgent);

    // TRAY-RESIDENT (core/tray-resident.ts): start minimised keeps the window in the tray at boot; closing it hides it
    // (Windows, Linux) and Genie keeps running — the agents, the terminals, the services. A quit is asked for.
    // S7: each .gen site at its own https origin — the pane's session routes *.gen to the in-app front door and trusts
    // Genie's CA for .gen hosts only (electron-browser-view.ts). Without a CA, .gen pages are refused and the reason logged.
    const browserTrust = composed.browserTrust();
    if (browserTrust.caPem === null) console.error(`[genie] browser: .gen sites cannot open in the Genie Browser: ${browserTrust.reason}`);
    // THE FRONT DOOR AS IT IS NOW (P5a.2): genie-host's, so it can come back on another port or with another CA. Every
    // browser session reads these, and is routed again when they change.
    frontDoorNow = { port: composed.frontDoorPort, caPem: browserTrust.caPem };
    gappWindowsNow = gappWindowsElectron({ sessions: () => agentEngineLink?.client.gappSessions() ?? null, frontDoor: () => frontDoorNow, preload: join(here, 'gapp-preload.cjs'), ledger: activationLedger });
    composed.onFrontDoorChange(() => {
        const trust = composed.browserTrust();
        if (frontDoorNow.port === composed.frontDoorPort && frontDoorNow.caPem === trust.caPem) return;
        frontDoorNow = { port: composed.frontDoorPort, caPem: trust.caPem };
        console.log(`[genie] browser: the front door is on :${frontDoorNow.port} now${trust.caPem === null ? ` with no CA (${trust.reason})` : ''}`);
        followFrontDoorInPanes();
        rerouteGenieBrowserSession({ frontDoorPort: frontDoorNow.port, caPem: frontDoorNow.caPem });
        publishBrowserFacts?.();
        gappWindowsNow?.reroute();
    });
    // LIVE SITE PANELS: a <webview> in the MAIN window, whichever window that is now (P1b: it can be closed and built again),
    // in the store of the site's own workspace.
    livePanels = sitePanels({ window: () => window, genieHome: genieRoot(), frontDoorPort: composed.frontDoorPort, caPem: browserTrust.caPem, enabledHosts: () => composed.routes().map((r) => r.host), workspaceOfHost: (host) => composed.sites.list().find((s) => s.host.toLowerCase() === host.toLowerCase())?.workspaceId ?? '_shared', openInWindow: (url, activation) => { void openLocalBrowser(url, activation); }, browserCall: (method, args) => (agentEngineLink?.live === true ? agentEngineLink.client.browserCall(method, args) : null), restart: panelRestart(confirmTray, restartGenie) });
    mainWindowDeps = { frontDoorPort: () => frontDoorNow.port, caPem: () => frontDoorNow.caPem, routes: () => composed.routes(), settings: composed.settings, pushFeatures: () => { pushFeatures(); } };
    mountMainWindow(showOnBoot({ startMinimized: composed.settings.snapshot().start_minimized === true, argv: process.argv }));
    // LAUNCH AT SIGN-IN: adopt Genie 1's entry, apply at boot, follow every change.
    void wireLoginItem(composed.settings, loginItemPort, {
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
        onProviderLogin: (provider) => {
            const r = loginHost?.start(provider);
            if (r && !r.ok) console.error('[genie] provider login:', r.reason);
        },
        // Claude Design's login (#1081): the same login window, running the interactive `claude`.
        onDesignLogin: () => {
            const r = loginHost?.start(DESIGN_LOGIN);
            if (r && !r.ok) console.error('[genie] Claude Design login:', r.reason);
        },
        onScratchTerminal: () => {
            if (!scratchTerminals) return;
            const r = openScratchTerminal({ scratch: scratchTerminals, home: homedir() });
            if (!r.ok) console.error('[genie] scratch terminal:', r.reason);
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
        onAccountRetry: (provider) => { retryPausedAccount?.(provider); },
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
        openStore: (workspaceId) => workspaceBrowserSession({ genieHome: genieRoot(), workspaceId, side: 'window', frontDoorPort: composed.frontDoorPort, caPem: frontDoorNow.caPem }).ses,
    });
    watchWorkspaceStores(cookieBridge);
    publishBrowserFacts = () => {
        if (agentEngineLink?.live !== true) return;
        const facts = {
            frontDoorPort: composed.frontDoorPort,
            caPem: frontDoorNow.caPem,
            hosts: composed.routes().map((r) => r.host),
            workspaceOf: Object.fromEntries(composed.sites.list().map((s) => [s.host.toLowerCase(), s.workspaceId])),
            launch: { file: process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), '--genie-browser', ...process.argv.filter((a) => /^--(no-sandbox|ozone-platform=|password-store=|genie-browser-debug-port=)/.test(a))] },
        };
        void agentEngineLink.client.browserCall('publish', [facts]).catch((error: unknown) => { rendererErrorLog?.(`the browser's facts could not be published: ${error instanceof Error ? error.message : String(error)}`); });
    };
    composed.sites.onChange(() => { publishBrowserFacts(); });
    publishBrowserFacts();
    // Another workstation's door moved, or learned that host's CA: its window in the browser process reads it live.
    deviceLinkNow()?.onVia((channel, port, ca) => {
        const relay = linkedRelays.get(channel);
        if (relay) void agentEngineLink?.client.browserCall('remoteVia', [`relay:${relay.workstationId}`, port, ca]).catch((error: unknown) => { console.error(`[genie] browser: the door to ${relay.workstationId} could not be updated: ${error instanceof Error ? error.message : String(error)}`); });
    });
    // TRAY-ONLY (P1b): while genie-host runs, one look every few seconds — what the tray says, and whether a tray-only
    // Genie with nothing left running ends (core/tray-only.ts).
    if (agentEngineLink) setInterval(watchTrayOnly, 5_000).unref?.();
}

/** What a (re)built main window needs from boot: set once the services are composed. */
/** The front door's port and Genie's CA as the browser sessions use them now (P5a.2); set once the services are composed. */
let frontDoorNow: { port: number; caPem: string | null } = { port: 0, caPem: null };
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
        featureState = { ...featureState, browserUrl: state.url, browserCanGoBack: state.canGoBack, browserCanGoForward: state.canGoForward };
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
        onReloaded: (notice) => { rendererNotice = notice; registry?.touch(); },
        onGaveUp: (notice) => { rendererNotice = notice; },
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
        markRunningAtQuit: (ids) => reg.markRunningAtQuit(ids),
        markInterruptedAtQuit: (ids) => reg.markInterruptedAtQuit(ids),
    });
}

/** This window's host API (§6.8, P4), for what genie-host asks it to do for a remote connection (Tynn #409). */
let remoteApiNow: ReturnType<typeof buildHostApi> | null = null;
let remoteAccessNow: ReturnType<typeof remoteAccess> | null = null;
/** Tailscale on this machine as last read (Tynn #821): at boot and after every Connect or Install. */
let tailscaleNow: TailscaleStatus | null = null;
app.on('before-quit', (event) => {
    // A launch that never booted (a second instance, a `--quit` with no Genie running) owns nothing to shut down — and
    // clearing the genie-running file below would clear the RUNNING Genie's. It exits without a quit; this is the guard.
    if (launch.kind !== 'boot') return;
    // QUIT CONFIRMATION (§6.5): defaults to the safe thing. Asked once; a confirmed quit proceeds. The steps and their
    // once-only guarantees are core/quit.ts `quitSequence`; a cancelled quit changes nothing — the window keeps hiding.
    const step = quit.beforeQuit({
        ready: host !== null && registry !== null,
        plan: () => {
            const running = registry!.snapshot().agents.filter((a) => host!.probe(a.id as AgentId)?.running === true).map((a) => a.name);
            // QUIT KEEPS THE HOST (P1b): while genie-host runs them, the agents, terminals and kept processes can outlive this
            // window — the question then has two answers. After an upgrade's drain the host is gone: nothing is kept, as before.
            const kept = (services?.supervisor.list() ?? []).filter((p) => p.state === 'running' || p.state === 'restarting').length;
            return quitPlan({ runningAgents: running, liveTerminals: terminals?.count ?? 0, host: agentEngineLink?.live === true ? { keptProcesses: kept, ...onTheClockNow() } : null });
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
        void recordShutdownNow().catch(() => { /* an unsaved list means no restore, never a blocked quit */ }).finally(() => app.quit());
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
        .catch(() => { /* an unwritten row never blocks a quit */ })
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
        // A nudge waiting out its grace is not sent into a quit (core/plan-keepalive.ts); with the sessions gone it would find none.
        keepaliveNow?.stop();
        // Every supervised process, the front door, an in-flight flow run, the knowledge database.
        void services?.shutdown();
        // The spawn host ends whatever is still running in it (the supervisor's stops above went first, in order), then
        // itself. Over the host's link it is the host's: nothing to end from here.
        void spawnHostNow?.stop();
        localDoor.dispose();
        void filesHost?.close();
        filesWatch?.close();
        clearGenieRunning(genieRoot());
    },
    // §7.1: nothing Genie spawned may outlive it. An upgrade jammed on 31 orphaned
    // OpenConsole.exe processes with no message, because nothing reaped them.
    closeTerminals: () => { terminals?.closeAll(); },
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
powerMonitor.on('resume', () => { void handProxyAnswers?.(); if (tynnAccount && !tynnAccount.status().signedIn) void tynnAccount.recheck(); });
powerMonitor.on('shutdown', (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    quit.force();
    app.quit();
});
