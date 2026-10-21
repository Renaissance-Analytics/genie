import { systemRootsPem } from './php-trust-host.js';
import { runServiceExec } from './service-exec.js';
import { MainErrorBook, installMainErrorPolicy } from '../core/main-errors.js';
import { relayWorkstationOf, remoteFromSearch, remoteWindowSearch } from '../core/remote-window.js';
import { transportHub } from '../core/remote-protocol.js';
import { chatCommsOf } from '../core/chat-view.js';
import { openRelayMember, PopKeypair, type RelayMemberTransport } from './relay-member.js';
import type { RelaySocket } from './relay-wire.js';
import { listShareLinks, mintShareLink, revokeShareLink } from './tynn-share-links.js';
import { connectableWorkstations, mintConnectGrant, relayHostPorts, startRelayHost, type RelayHostHandle, type RelayHostStatus } from './tynn-network.js';
import { livenessOf } from '../core/liveness.js';
import { CallerBook, genieMcpServers, sessionCallerOf } from './mcp-callers.js';
import type { Caller } from './mcp-tools.js';
import { sessionCostOf } from '../core/stream-view.js';
import { lastNumberedTurn } from '../core/turn-numbers.js';
import { commsOf } from '../core/comms.js';
import { BrowserWindow, Menu, Notification, Tray, app, dialog, ipcMain, net, powerMonitor, safeStorage, session, shell } from 'electron';
import { guardWindowLinks } from './external-links.js';
import { WHATS_NEW_ROUTE, genieDocsUrl, whatsNewFor } from '../core/whats-new.js';
import { RELEASE_NOTES } from './release-notes.js';
import { appMenuTemplate } from './app-menu.js';
import { realFancyTermPort } from './fancy-term-port.js';
import { TerminalHost } from './terminal-host.js';
import { TakeOverHost } from './take-over-host.js';
import { FilesWindows } from './files-windows.js';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asAgentId, asAgentRef, type AgentId, type AgentRecord } from '../core/identity.js';
import type { AgentDetail } from '../renderer/bridge.js';
import type { TimedEvent } from '../core/stream-view.js';
import { AGENT_PUSH_INTERVAL_MS, AgentPush } from './agent-push.js';
import { Coalescer, realSchedule } from '../core/coalesce.js';
import { OS_WORKSPACE, Registry } from './registry.js';
import { readFile, rm } from 'node:fs/promises';
import { deleteAgent, diagnose, previewDelete, restartAgent, setAccessScope, setAutoApprove, setBudget, setIssueWatch, setMode, setModel, setPermissions, SettingApplier, switchDriver, type AgentOpsPorts } from './agent-ops-host.js';
import { issueWatchPrefsFor } from '../core/issue-watch.js';
import { mailAction } from '../core/agent-actions.js';
import { ThingSounds, flowRunSound } from '../core/thing-sounds.js';
import { agentShells } from '../core/agent-shells.js';
import { quitPlan, quitSequence } from '../core/quit.js';
import { QUIT_DATA, answerSecondInstance, asksToQuit, launchDecision } from '../core/quit-flag.js';
import { genieUrlIn, signInCodeFrom, workstationOpenFrom } from '../core/tynn-sign-in.js';
import { TynnAccount } from './tynn-account.js';
import { TYNN_HOST } from '../core/tynn.js';
import { GithubAccount } from './github-account.js';
import { ensureWorkstation, identityFrom, workstationKeyStore } from './workstation-identity.js';
import { listHostDir } from './host-fs.js';
import { applyLinuxPasswordStore, passwordStoreBusNames, probeOwnedBusNames } from './linux-password-store.js';
import { readRememberedPasswordStore, rememberPasswordStore } from './password-store-memo.js';
import type { TynnWorkstationState } from '../renderer/features.js';
import { attachmentsFromRenderer } from '../core/prompt-content.js';
import { buildHostApi } from './host-api.js';
import { addWorkspace as addWorkspaceOp, createWorkspace as createWorkspaceOp, addWorkspaceFromGit, addWorkspaceFromTynn, listTynnProjects, hibernateWorkspace, previewAddFromGit, previewAddFromTynn, previewAddWorkspace, removeWorkspace, startRefusal, wakeWorkspace, type WorkspaceOpsPorts } from './workspace-ops-host.js';
import { mkdir, readdir, readFile as readFileText, stat as statPath, writeFile as writeFileText } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { restartWithHandoff } from './restart-with-handoff.js';
import { sweepLeftoverProviders } from './leftover-sweep.js';
import { raisesApprovals, SessionHost, providerBinary } from './session-host.js';
import { LoginHost } from './login-host.js';
import { openScratchTerminal } from './scratch-terminal.js';
import { ACCOUNT_BACK, SIGNED_IN_AGAIN } from '../core/provider-login.js';
import { PlanKeepalive } from '../core/plan-keepalive.js';
import { PauseAlerts } from '../core/account-pause.js';
import { Store } from './store.js';
import { composeServices, type ComposedServices } from './compose.js';
import { customSoundData, featureSnapshot, handleFeatureAction, toolchainStateFrom, type FeatureState } from './feature-ipc.js';
import { SOUND_FILE_EXTENSIONS } from '../core/custom-sound.js';
import { QuestionWindow } from './question-window.js';
import { electronQuestionWindow } from './question-window-electron.js';
import { readV1Settings } from './v1-settings.js';
import { readV1Catalog, readV1Knowledge } from './v1-import.js';
import { readV1Inbox } from './v1-inbox.js';
import { planV1Import, v1DefaultAgents } from '../core/v1-import.js';
import { v1Leftovers } from '../core/v1-reap.js';
import { workspaceDisplayName } from '../core/workspace-name.js';
import { TITLE_BAR_HEIGHT, mainWindowOptions, overlayColorsOk } from '../core/window.js';
import { createTray, loginName, trayMenuTemplate, trayTooltip, trayUpdate, type TrayHandlers } from './tray.js';
import { limitWords } from '../core/limit-words.js';
import { genieWindowIcon } from './app-identity.js';
import { showOnBoot } from '../core/tray-resident.js';
import { wireCloseToTray, wireLoginItem, type LoginItemPort } from './tray-residence.js';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { caddyBinPath, userCaddyCopy } from './caddy-runtime.js';
import { execFileRunner, probeToolsLive } from './toolchain-runner.js';
import { latestIndex, runUpdate, type CommandRunner } from './toolchain-prober.js';
import { planInstall, type PackageManager, type Platform } from '../core/toolchain.js';
import { checkAndRepair, detectPackageManager, installTool, nodeToolchainFs, phpWorkerEnv, processEnv, restoreToolchainEnv, toolchainPaths, type ToolchainOpsPorts } from './toolchain-ops.js';
import { httpFetch, installPhpVersion, listPhpVersions, nodePhpVersionsFs, phpVersionsRoot, removePhpVersion, resolvePhpCgi, type PhpVersionsPorts } from './php-versions.js';
import type { FeaturePorts } from './feature-ipc.js';
import { ProcessBook } from './process-book.js';
import { osPidAlive } from './process-supervisor.js';
import type { FeatureData } from '../renderer/features.js';
import { BrowserPane } from './browser-pane.js';
import { electronBrowserView } from './electron-browser-view.js';
import { FEATURE_CHANNELS } from '../renderer/bridge.js';
import type { FeatureAction } from '../renderer/features.js';
import { UpdateHost } from './updater.js';
import { channelFrom } from '../core/update-channel.js';
import { genieHome, installDir, osaHomeDir, runtimeDir } from './paths.js';
import { osaHomeFiles, writeOsaHome } from '../core/osa-home.js';
import { omarchyFacts } from './omarchy-skills.js';
import { realElectronUpdaterPort } from './electron-updater-port.js';
import { killProcess, listProcesses } from './process-list.js';
import { RESUME_AFTER_RESTART, midTurnAgents, relaunchPlan } from '../core/upgrade-drain.js';
import { FilesHost } from './files-host.js';
import { editorRead, editorWrite, type EditorBytesDeps } from './plugin-editor-bytes.js';
import { TerminalSnapshots } from './terminal-snapshots.js';
import { addRepoTo, commitsSinceIn, listReposOf, relocateRepoIn, removeRepoFrom, removeRepoLockOf, type RepoOpsPorts } from './repo-ops-host.js';
import { agentCapFrom } from '../core/inbox.js';
import { fileEventsOf, openFileRoute } from '../core/files-panel.js';
import { remoteListener } from './remote-listen.js';
import { remoteAccess } from './remote-access.js';
import { ensureFirewallRule } from './remote-firewall.js';
import { getTailscaleStatus, installTailscale, tailscaleUp, type TailscaleStatus } from './tailscale-cli.js';
import { staticServer } from './static-page.js';
import { uploadSender } from './uploads.js';
import { gitClone, gitFileStatus, gitInit, gitShowHead } from './git-ports.js';
import { genieMcpServer, type GenieMcpServer, type Verification } from './mcp-server.js';
import { allGenieTools } from './mcp-registrations.js';
import { genieToolDeps } from './genie-tool-deps.js';
import { terminalEnvFor, type OpenInBrowser } from './hosting-actions.js';
import { browserRoute } from '../core/browser-policy.js';
import { clearGenieRunning, doctorHoldNow, markGenieRunning } from './genie-running-file.js';
import { launchSubprocess, runPluginTool } from './plugin-runner.js';
import { REMOTE_PORT } from '../core/tailscale.js';
import { attachWebSocketServer } from '@particle-academy/fancy-ws';
import { wireInboxPush } from './inbox-push.js';
import { IssueWatchClient, type IssueWatchRefreshAnswer, type SocketLike } from './issue-watch-client.js';
import { IssueWatchDelivery } from './issue-watch-delivery.js';
import { issueWatchPanelView, issueWatchSoundKinds, PANEL_RECENT, tynnProjectIdOf, type IssueWatchPanelView, type IssueWatchSummary, type IwEntry, type IwEvent } from '../core/issue-watch.js';

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
const launch = launchDecision({
    argv: process.argv,
    primary: app.requestSingleInstanceLock(asksToQuit(process.argv) ? { ...QUIT_DATA } : undefined),
});
if (launch.kind === 'exit') {
    console.log(`[genie] ${launch.reason}`);
    app.exit(0);
}

let window: BrowserWindow | null = null;
/** The tray outlives every window; held so it is not garbage-collected into nothing. */
let tray: Tray | null = null;
/** The tray's handlers, kept so a held login (Tynn #794) can redraw its menu; and what it last showed as held. */
let trayHandlers: TrayHandlers | null = null;
let trayHeldKey = '';
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
    const key = JSON.stringify({ held, update, signedOut, paused });
    if (key === trayHeldKey) return;
    trayHeldKey = key;
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(trayHandlers, held, update, signedOut, paused)));
    tray.setToolTip(trayTooltip(held, signedOut, paused));
}

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
    n.on('click', revealMainWindow);
    n.show();
}

/** `Try again` for a paused login (set where the agent operations are built): every agent it stopped, brought back. */
let retryPausedAccount: ((provider: string) => void) | null = null;
/** The automatic update checks (§7, genie2#91): stopped on quit so no check fires into a closing app. */
let autoCheckStop: (() => void) | null = null;
let registry: Registry | null = null;
/**
 * ISSUEWATCH (Tynn #806): the latest entry Tynn sent per project, and the client's state — what `checkIssues` and imDone's
 * count line read for a workspace (its project.json `tynn.projectId`). Filled by the client once it runs.
 */
const issueWatchLatest = new Map<string, IwEntry>();
let issueWatchState: IssueWatchSummary['state'] = 'stopped';
/** What happened lately per Tynn project, newest first, capped — the GitHub panel's "Lately". */
const issueWatchRecent = new Map<string, IwEvent[]>();
/** A workspace's Tynn project, from its project.json `tynn.projectId`; `null` = not linked. */
function tynnProjectFor(workspaceId: string): string | null {
    const workspace = (registry?.snapshot().workspaces ?? []).find((w) => w.id === workspaceId);
    let manifest: string | null = null;
    if (workspace) { try { manifest = readFileSync(join(workspace.path, 'project.json'), 'utf8'); } catch { manifest = null; } }
    return tynnProjectIdOf(manifest);
}
/** Every workspace's GitHub panel (Tynn #806), as the features snapshot carries it. */
function issueWatchPanels(): Record<string, IssueWatchPanelView> {
    const out: Record<string, IssueWatchPanelView> = {};
    for (const w of registry?.snapshot().workspaces ?? []) {
        const projectId = tynnProjectFor(w.id);
        out[w.id] = issueWatchPanelView(issueWatchSummaryFor(w.id), projectId === null ? [] : issueWatchRecent.get(projectId) ?? []);
    }
    return out;
}
/** The running IssueWatch client, once boot has started it: what a `checkIssues(refresh: true)` goes through. */
let issueWatchRunning: IssueWatchClient | null = null;
/** Have Tynn read a workspace's repos now (its project.json `tynn.projectId`). */
async function issueWatchRefreshFor(workspaceId: string): Promise<IssueWatchRefreshAnswer> {
    const projectId = tynnProjectFor(workspaceId);
    if (projectId === null) return { ok: false, reason: 'this workspace is not linked to a Tynn project' };
    if (!issueWatchRunning) return { ok: false, reason: 'IssueWatch is not running' };
    return issueWatchRunning.refresh(projectId);
}
function issueWatchSummaryFor(workspaceId: string): IssueWatchSummary {
    const projectId = tynnProjectFor(workspaceId);
    const entry = projectId === null ? undefined : issueWatchLatest.get(projectId);
    return { state: issueWatchState, linked: projectId !== null, ...(entry ? { entry } : {}) };
}
let terminals: TerminalHost | null = null;
/** `Log in to <provider>` (#967): the login window, reached from the Agent view, the chat and the tray. */
let loginHost: LoginHost | null = null;
let filesHost: FilesHost | null = null;
let snapshots: TerminalSnapshots | null = null;
let takeOvers: TakeOverHost | null = null;
let filesWindows: FilesWindows | null = null;
let host: SessionHost | null = null;
/** The plan keepalive (core/plan-keepalive.ts), so the quit sequence can stop a nudge waiting out its grace. */
let keepaliveNow: PlanKeepalive | null = null;
/**
 * Has Genie heard the roster and the session host ONCE? Until then a question's agent cannot be judged: "we have not
 * heard" is not "it is gone", so the Deck marks nothing stale (`askerLive` answers `undefined`). Set after the
 * registry's first load, when the session host already exists.
 */
let askerLivenessKnown = false;
/** A model or tool-setting change waiting for its agent to be free (`SettingApplier`); set where the agent ops are built. */
let settingApplier: SettingApplier | null = null;
let updates: UpdateHost | null = null;
/**
 * ONE QUIT (core/quit.ts `quitSequence`): asked at most once, the running set recorded at most once (§7.6 — an
 * upgrade's drain records it itself, so the quit does not overwrite it with the empty list it leaves), the shutdown
 * run exactly once. Its `quitting` is what turns the main window's close from a hide into a real close.
 */
const quit = quitSequence();

/**
 * THE QUIT a person asks for — the tray's Quit, and `Genie --quit` from outside (core/quit-flag.ts), one entry for both.
 * `app.quit()` runs before-quit, so the confirmation is asked only where it would be, and the shutdown runs once.
 */
function requestQuit(): void {
    app.quit();
}

/**
 * A Take Over window: the OS frame (there is no Genie chrome to replace it), one terminal.
 * Loads the same renderer with the take-over route in its hash; `App` renders only the pane
 * for that route. Closing it ends the take-over — the window IS the session.
 */
function openTakeOverWindow(route: string): void {
    const terminalId = route.split('/').pop() ?? '';
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.webContents.getURL().endsWith(`#${route}`)) { w.focus(); return; }
    }
    const win = new BrowserWindow({
        width: 1100,
        height: 700,
        ...genieWindowIcon(here),
        backgroundColor: '#0a0a0c',
        show: false,
        webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // Links open in the browser (http(s) only), never in a Genie window (Tynn #763, main/external-links.ts).
    guardWindowLinks(win.webContents, (url) => { void shell.openExternal(url).catch(() => {}); });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => takeOvers?.windowClosed(terminalId));
    void win.loadFile(join(here, '../renderer/index.html'), { hash: route });
}

/** THE FILE PANEL IN ITS OWN WINDOW (§4.3): one per workspace; the route names it. Closing it docks the panel back. */
function openFilesWindow(route: string): void {
    const workspaceId = route.split('/').pop() ?? '';
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.webContents.getURL().endsWith(`#${route}`)) { w.focus(); return; }
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
    guardWindowLinks(win.webContents, (url) => { void shell.openExternal(url).catch(() => {}); });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => filesWindows?.windowClosed(workspaceId));
    void win.loadFile(join(here, '../renderer/index.html'), { hash: route });
}

function closeWindowAt(route: string): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.webContents.getURL().endsWith(`#${route}`)) w.close();
    }
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
/** A workspace's display name from its envelope (project.json `name`), else its folder; read once per path. */
const manifestNames = new Map<string, string>();
function workspaceNameFor(path: string): string {
    const cached = manifestNames.get(path);
    if (cached !== undefined) return cached;
    let manifest: string | null = null;
    try { manifest = readFileSync(join(path, 'project.json'), 'utf8'); } catch { manifest = null; }
    const name = workspaceDisplayName(manifest, path);
    manifestNames.set(path, name);
    return name;
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
    const marker = join(genieHome(), 'v1-import.json');
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
    const victims = v1Leftovers(listProcesses(), { roots, selfPid: process.pid, includeShells });
    if (victims.length === 0) return;
    const killed = victims.filter((v) => killProcess(v.pid));
    const report = { at: new Date().toISOString(), found: victims.length, killed: killed.length, victims: victims.map((v) => ({ pid: v.pid, executable: v.executable, why: v.why })) };
    await writeFileText(join(genieHome(), 'v1-reap.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(`[genie] reaped v1's runtime: ${killed.length} of ${victims.length} (${victims.filter((v) => v.why === 'orphaned shell').length} orphaned shells, ${victims.filter((v) => v.why === 'v1 runtime binary').length} v1 binaries)`);
}

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
            // The renderer gets `window.genie` and nothing else: no Node, no `require`, no
            // `ipcRenderer`. A renderer with Node integration is a renderer where a prompt
            // injection reaches the filesystem — and this one displays agent-authored text.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    // Links open in the browser (http(s) only), never in a Genie window (Tynn #763, main/external-links.ts).
    guardWindowLinks(win.webContents, (url) => { void shell.openExternal(url).catch(() => {}); });

    // Paint when there is something to paint. A visible empty frame that then fills in is the
    // app looking broken for the length of a load. Start minimised (or a `--hidden` sign-in launch)
    // keeps it in the tray: the tray's Open shows it.
    if (show) win.once('ready-to-show', () => win.show());

    // A remote host's window carries the host in its query (core/remote-window.ts); the main window carries none.
    void win.loadFile(join(here, '../renderer/index.html'), search ? { search } : undefined);
    return win;
}

/**
 * A WINDOW PER REMOTE HOST (Genie 1's remote.open; Tynn #819): the host's own window, so the local Genie stays open. One
 * per host — asking again brings it to the front. Only a ws:// or wss:// URL is a host; anything else opens nothing.
 */
const remoteWindows = new Map<string, BrowserWindow>();
function openRemoteWindow(url: string): void {
    const search = remoteWindowSearch(url);
    if (remoteFromSearch(search) === null) return;
    const open = remoteWindows.get(url);
    if (open && !open.isDestroyed()) {
        if (open.isMinimized()) open.restore();
        open.show();
        open.focus();
        return;
    }
    const win = createWindow(true, search);
    remoteWindows.set(url, win);
    win.on('closed', () => { if (remoteWindows.get(url) === win) remoteWindows.delete(url); });
}

/**
 * Bring the main window back: from the tray, a second launch, the tray notice. A hidden window
 * needs `show()` — `focus()` alone does nothing to a window that is not on screen.
 */
function revealMainWindow(): void {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
}

/*
 * TYNN SIGN-IN COMING BACK (the owner, 2026-10-19: the way Genie 1 did it). Genie registers genie:// with the OS; the
 * browser's genie://oauth/callback?token=… arrives as a second launch's argv (Windows, Linux), as `open-url` (macOS), or
 * as THIS launch's argv when Genie was not running. A URL that arrives before the account is open waits for it.
 */
let tynnAccount: TynnAccount | null = null;
/** This Genie's GitHub sign-in (main/github-account.ts, beta.33 item 25): Genie 1's carried over, or the device flow. */
let githubAccount: GithubAccount | null = null;
/** This machine on the Tynn network (Tynn #836): registered, or why not; `null` until first read. */
let tynnWorkstationNow: TynnWorkstationState | null = null;
/** Re-applies the relay host after the remote-access switch moves (set once the Tynn account is open). */
let relayAfterSwitch: (() => void) | null = null;
/** This Genie on the Tynn relay as a host (Tynn #838): `null` = not started (remote access off, or not registered). */
let relayHostNow: RelayHostHandle | null = null;
let relayStatusNow: RelayHostStatus = { state: 'off' };
/** A window's connection to a Tynn workstation (Tynn #837), by the channel it was given; main alone holds it. */
const relayChannels = new Map<string, { transport: RelayMemberTransport; sender: Electron.WebContents }>();
let nextRelayChannel = 0;
/** The global WebSocket, as the relay ends' socket. */
const relaySocket = (url: string): RelaySocket => new WebSocket(url) as unknown as RelaySocket;
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
    if (workstation) { openRemoteWindow(`relay:${workstation.id}`); return; }
    if (signInCodeFrom(url) === null) { console.log('[genie] a genie:// URL Genie does not handle was ignored'); return; }
    revealMainWindow();
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
    if (record.workspaceId === OS_WORKSPACE) return osaHomeDir();
    const workspace = registry?.snapshot().workspaces?.find((w) => w.id === record.workspaceId);
    return workspace?.path ?? app.getPath('userData');
}

function detailFor(agentId: AgentId): AgentDetail | null {
    const record = registry?.find(agentId);
    if (!record || !host) return null;
    // A live Take Over window makes this agent OBSERVED here too — the same probe the Dashboard row reads, so the
    // Agent view and the board cannot disagree about what Genie can see of it (§4.2: tabs by fidelity).
    const takeOver = takeOvers?.probe(record.id) ?? null;

    return {
        agent: {
            id: record.id,
            name: record.name,
            provider: record.provider,
            // Every registered agent speaks ACP; `observed` while its Take Over window is open; `remote` belongs to
            // another workstation.
            fidelity: takeOver ? 'observed' : 'declared',
            cwd: cwdFor(record),
            dailyBudgetUsd: record.dailyBudgetUsd ?? null,
            mode: record.mode,
            accessScope: record.accessScope,
            autoApprove: record.autoApprove === true,
            // What it hears from IssueWatch now: its own setting, or the default its place in the workspace gives it (Tynn #806).
            issueWatch: issueWatchPrefsFor(record, registry?.listAgents() ?? [], registry?.defaultAgentOf(record.workspaceId) ?? null),
            permissions: record.permissions ?? 'all',
            // The model CHOSEN (null = the provider's default); the one IN USE is the session's, as reported.
            model: record.model ?? null,
            instructions: record.instructions ?? null,
            // Whether this agent can ask for approval at all (the driver's own claim, or a Claude agent set to ask before
            // shell commands); a Take Over window says nothing.
            raisesApprovals: takeOver ? null : raisesApprovals(record.provider, record.permissions),
        },
        session: host.probe(record.id),
        // The agent's recorded history, then this run (Claude does not replay a resumed conversation).
        rows: host.ledgerFor(record.id),
        // The number the Turns column shows for the latest turn, so the pill (`Turn 12 · running`) agrees with it.
        turns: lastNumberedTurn(host.ledgerFor(record.id)) || host.turnsFor(record.id),
        // The engine's own recent words, for the process-ended block (the board's error state).
        log: host.recentStderrFor(record.id),
        // The session's running total, from the latest usage report (claude reports it; codex does not). `null` means
        // there is no Cost row — never a `$0.00`, which would claim the work was free.
        cost: sessionCostOf(host.rowsFor(record.id)),
        refusal: host.refusals.get(record.id) ?? null,
        takeOver,
        // Its AgentInbox mail — with other agents AND the person (an FTQ answer is the person's) — for the mail rows in its
        // chat (core/chat-view.ts `chatCommsOf`).
        comms: services ? chatCommsOf(services.inbox.involving(record.id, 50)) : null,
    };
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

let services: ComposedServices | null = null;
// Genie's own MCP server (§6.9) and what its boot probe said (§6.4 "native transport verified at boot").
let mcp: GenieMcpServer | null = null;
let mcpVerified: Verification | null = null;
/** The two variables every terminal gets once the server listens; GENIE_TERMINAL_ID is minted by the pty port itself. */
/** Every tool Genie's MCP serves (name and description), set once the registrations exist. */
let mcpToolList: readonly { name: string; description: string }[] = [];
/** The agents' MCP caller keys (one per agent, for the run). */
const sessionCallers = new CallerBook();
/** An agent session calling Genie's MCP, by its caller key: the agent and its workspace, now. */
function sessionCaller(key: string): Caller | null {
    return registry ? sessionCallerOf(sessionCallers, key, registry, osaHomeDir()) : null;
}
const mcpEnv = (): Record<string, string> => { const e = mcp?.endpoint(); return e ? { GENIE_MCP_URL: e.url, GENIE_MCP_TOKEN: e.token } : {}; };
let browserPane: BrowserPane | null = null;

/**
 * Where "latest" comes from, per tool (toolchain-prober.ts `latestIndex`): every command it runs goes through the same
 * platform routing as the probe and the update, so on Windows `npm outdated -g` reaches npm.cmd through cmd.exe.
 */
const latestFor = latestIndex({ run: execFileRunner, fetchJson: async (url) => (await fetch(url)).json(), platform: process.platform as Platform });

/** The package manager that actually ANSWERS on this machine (apt or dnf on Linux), asked once per run. */
let detectedPackageManager: Promise<PackageManager | null> | null = null;
const packageManager = (): Promise<PackageManager | null> => (detectedPackageManager ??= detectPackageManager(process.platform as Platform, execFileRunner));
/** Installs and updates take minutes (winget, a polkit prompt waiting on the person); the probe's 20 s would cut them off. */
const longRunner: CommandRunner = (binary, args) => execFileRunner(binary, args, { timeoutMs: 30 * 60_000 });
/** Genie 2's own toolchain data: the CA bundle and its ini, the remembered PATH order (toolchain-ops.ts). */
const toolchainDataDir = (): string => join(genieHome(), 'genie2-toolchain');
/** T4: where Genie's managed PHP versions live, and how a site's pin finds one (read at each start — no cache). */
const phpVersionsBase = (): Pick<PhpVersionsPorts, 'platform' | 'root' | 'fs'> => ({ platform: process.platform as PhpVersionsPorts['platform'], root: phpVersionsRoot(toolchainDataDir()), fs: nodePhpVersionsFs() });
let featureState: FeatureState = { toolStatuses: null, knowledgeQuery: '' };
/** The ForceTheQuestion window's controller (question-window.ts); set once the services are composed. */
let questionWindow: QuestionWindow | null = null;
/** Who else wants the feature snapshot on change: the remote host's event stream. */
const featureListeners = new Set<(data: FeatureData) => void>();

async function boot(): Promise<void> {
    // genie:// — Tynn's sign-in hands its code back through it (openGenieUrl above).
    registerGenieProtocol();
    // The store this launch actually got, written down for the next (a probe can come back empty — genie#588).
    if (process.platform === 'linux') rememberPasswordStore(genieHome(), safeStorage.getSelectedStorageBackend());
    // BEFORE anything is spawned (the pty host, sessions, sites): the PATH order and PHP's CA ini a Check and repair
    // chose, so everything Genie starts inherits them. Two file reads; nothing runs (toolchain-ops.ts).
    restoreToolchainEnv({ platform: process.platform as Platform, env: processEnv, fs: nodeToolchainFs(), dataDir: toolchainDataDir() });
    // Genie's data root is ~/.genie on every version (paths.ts); `userData` stays Chromium's.
    const store = new Store(genieHome());
    // Doctor mode reads this: that normal Genie is running, and which agents it has started (none yet) — doctor starts
    // an agent beside it only in an awake workspace where none of those is running (core/genie-running.ts).
    markGenieRunning(genieHome(), []);
    // A local binding as well as the module-level one, so the callback below closes over a
    // Registry rather than a `Registry | null` that TypeScript cannot narrow inside a closure.
    const theRegistry = new Registry(store);
    registry = theRegistry;
    theRegistry.setWorkspaceNamer(workspaceNameFor);
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
            return { mode: record.mode, lastTurnEnd: host?.lastTurnEnd(id as AgentId) ?? null, plan: live.plan ?? null, promptable: host?.promptable(id as AgentId) != null, waitingOnPerson: asked || live.pendingApproval !== null };
        },
        prompt: (id, text) => { host?.prompt(id as AgentId, text, 'genie'); },
        stalled: (id, text) => { host?.notice(id as AgentId, text); },
    });
    keepaliveNow = keepalive;
    host = new SessionHost({
        userData: genieHome(),
        // Each turn's number is kept on the agent's record as the turn starts, so its next session numbers on at once.
        onTurnNumbered: (agentId, n) => { void registry?.setLastTurn(agentId, n); },
        // What an agent did (Tynn #766 C): pushed to every window, which plays the sound chosen for it.
        onAction: (agentId, kind) => { broadcast('genie:action', { agentId, kind }); if (kind === 'replied') keepalive.turnEnded(agentId); },
        // Each agent starts with its workspace's managed-service variables, by allow-list (the owner, 2026-10-16).
        serviceEnvFor: (workspaceId) => services?.engines.envFor(workspaceId) ?? {},
        // Doctor mode beside this Genie holds the workspace it runs an agent in; starting one there meanwhile is refused.
        heldElsewhere: (record) => {
            const hold = doctorHoldNow(genieHome());
            return hold !== null && hold.workspaceId === record.workspaceId
                ? `doctor mode is running an agent in this workspace (pid ${hold.pid}); stop it there, or close doctor mode, then start ${record.name}`
                : null;
        },
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
        // GENIE'S MCP for every agent session (the owner: it was not available to agents): the live endpoint, the
        // bearer token, and this agent's caller key so the tools know which agent is calling.
        mcpServersFor: (record) => genieMcpServers(mcp?.endpoint() ?? null, sessionCallers.keyFor(record.id)),
        // The Dashboard's comms (§4.1): AgentInbox traffic since the session started, read when the row is built.
        comms: (agentId, since) => (services ? commsOf(services.inbox.involving(agentId, 2000), agentId, since, Date.now()) : null),
        onThreadId: (agentId, threadId) => {
            void theRegistry.recordThread(agentId, threadId).then((result) => {
                if (!result.ok) console.error(`[genie] could not record the thread id: ${result.reason}`);
            });
        },
    });

    // Healthy means this process is up and answering, which is the only claim the local
    // workstation chip can honestly make from in here. A real health model belongs with
    // remote workstations, where there is something to be unreachable.
    await registry.load({ name: hostname(), healthy: true });
    // The first roster snapshot is in, and the session host was built above it: a question's agent can be judged now.
    askerLivenessKnown = host !== null;
    // The OSA's home (~/.genie/osa): its baked-in instructions and the diagnostics skill, replaced where they differ.
    await writeOsaHome({
        dir: osaHomeDir(),
        // On an Omarchy host, Omarchy's own agent skills come with it (main/omarchy-skills.ts); elsewhere, nothing about Omarchy.
        files: osaHomeFiles('normal', { version: app.getVersion(), platform: process.platform, installDir: installDir(process.execPath), genieHome: genieHome(), userData: app.getPath('userData'), omarchy: await omarchyFacts() }),
        fs: {
            read: async (p) => { try { return await readFileText(p, 'utf8'); } catch { return null; } },
            write: async (p, text) => { await mkdir(dirname(p), { recursive: true }); await writeFileText(p, text, 'utf8'); },
        },
    }).catch((error: unknown) => { console.error(`[genie] the OSA's home could not be written: ${(error as Error).message}`); });
    // The boot that imports Genie 1 is the one whose pty host just died — the only boot its orphaned shells are reaped.
    const importBoot = !existsSync(join(genieHome(), 'v1-import.json'));
    await importFromV1(theRegistry);
    await reapV1Runtime(importBoot);
    registry.setProbe((id) => host?.probe(id) ?? null);

    /*
     * TERMINALS — for shells, builds, services and hosted sites. No agent has one.
     *
     * The engine is fancy-term-host behind the PtyPort seam. Snapshots are encrypted with
     * Electron's safeStorage; on a machine that genuinely cannot encrypt the engine takes its
     * own documented plaintext fallback, which is its call and not decided here.
     */
    // ONE pty engine, shared by the terminal host and the composition root's supervisor.
    const ptyPort = realFancyTermPort(genieHome(), {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (bytes) => safeStorage.encryptString(bytes.toString('base64')),
        decrypt: (bytes) => Buffer.from(safeStorage.decryptString(bytes), 'base64'),
    // The engine gates its cwd hook and detached terminals on GENIE'S settings, read live (§6.5).
    }, () => services?.settings.snapshot() ?? {});
    terminals = new TerminalHost(ptyPort);
    // §6.5: what the terminals showed at the last quit, handed back once per workspace.
    snapshots = await TerminalSnapshots.open(genieHome());
    // THE FILE PANEL (§4.3): one host; attribution is the agents' own tool events, looked up live.
    filesHost = new FilesHost({
        // Each opened file carries its git state (the persona's `· committed`).
        gitStatus: gitFileStatus,
        gitShowHead,
        // Delete goes to the OS trash (Tynn #844), never an erase.
        trash: (absolutePath) => shell.trashItem(absolutePath),
        workspace: (id) => { const w = registry?.workspace(id); return w ? { id: w.id, path: w.path } : null; },
        agentsOf: (workspaceId) => (registry?.agentsOf(workspaceId) ?? []).map((a) => ({ id: a.id, name: a.name })),
        eventsOf: (agentId) => {
            const record = registry?.find(agentId as AgentId);
            if (!record || !host) return [];
            // One event per tool CALL, its rows folded (files-panel.ts): row by row, no Claude edit was ever attributed.
            return fileEventsOf(host.rowsFor(record.id), { id: record.id, name: record.name });
        },
    });
    // One broadcast per batch, with the paths that changed (genie#921): the panel re-lists once and re-reads the open file only if it changed.
    filesHost.onChange((workspaceId, paths) => broadcast('genie:files-changed', workspaceId, paths));
    // The popped-out panels (§4.3): tracked here, pushed as the whole list.
    filesWindows = new FilesWindows({ openWindow: openFilesWindow, closeWindow: closeWindowAt });
    filesWindows.onChange((list) => broadcast('genie:files-windows-changed', list));
    // Pushed, not polled (house rule). One channel per kind; the id rides the payload.
    terminals.onData((id, data) => {
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('genie:terminal-data', { id, data });
        }
    });
    terminals.onExit((id, exitCode) => {
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('genie:terminal-exit', { id, exitCode });
        }
    });

    /*
     * TAKE OVER (§1). The host opens the TUI in a workspace terminal and asks for a window on
     * it; the window is the session, so closing it closes the terminal. The registry reads
     * the host's probe to draw the Observed row. Nothing here manages the TUI.
     */
    const terminalsForTakeOver = terminals;
    takeOvers = new TakeOverHost({
        terminals: terminalsForTakeOver,
        openWindow: (route) => openTakeOverWindow(route),
        // The Take Over contract (§1, §6.9): the loopback MCP endpoint, read at open time so a late-starting server still reaches the TUI.
        mcp: () => { const e = mcp?.endpoint(); return e ? { mcpUrl: e.url, token: e.token } : null; },
    });
    const takeOversNow = takeOvers;
    theRegistry.setObservedProbe((id) => takeOversNow.probe(id));

    /*
     * UPDATES (§7). The host drives electron-updater; the renderer asks and shows. The install
     * directory is wherever this executable lives — `%LOCALAPPDATA%\Programs\Genie` when
     * installed, Electron's own dist in a dev run — and §7.2's teardown scans exactly that.
     * One check soon after boot and one every few hours (AUTO_CHECK) — v1 checked at boot, and
     * 2.0.0-beta.5, which never did, could not learn that the next build existed (genie2#91).
     * Nothing downloads by itself.
     */
    updates = new UpdateHost({
        port: realElectronUpdaterPort(),
        // What is in an update (core/update-notes.ts): GitHub's releases, whose bodies are our own Markdown notes. The repo
        // is public, so no token; 10 s at most, and a failure says "unavailable" in the window, never blocks the update.
        runningVersion: app.getVersion(),
        releases: async () => {
            const res = await fetch('https://api.github.com/repos/Renaissance-Analytics/genie/releases?per_page=100', {
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Genie' },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
            return (await res.json()) as import('../core/update-notes.js').ReleaseLike[];
        },
        installDir: dirname(process.execPath),
        ownPid: process.pid,
        processes: listProcesses,
        kill: killProcess,
        // §7.4: every session ends with the upgrade; no agent is asked for a handoff first (the owner, 2026-10-12).
        agents: {
            live: () => (registry?.snapshot().agents ?? []).filter((a) => host?.probe(a.id as AgentId)?.running === true).map((a) => ({ id: a.id, name: a.name })),
            stopAll: () => {
                // Record who was running and who was MID-TURN BEFORE the sessions end (§7.6; the owner, 2026-10-13).
                quit.markRecorded();
                void recordShutdown();
                host?.stopAll();
            },
        },
    });
    updates.onChange((state) => {
        refreshTray();
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('genie:updates-changed', state);
        }
    });
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
    ipcMain.handle('genie:updates-state', () => updates?.state() ?? null);
    autoCheckStop = updates.startAutoCheck((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    ipcMain.handle('genie:updates-check', () => updates?.check() ?? null);
    ipcMain.handle('genie:updates-download', () => updates?.download() ?? false);
    ipcMain.handle('genie:updates-install', () => {
        const result = updates?.install() ?? null;
        if (result) console.log(`[updater] ${result.report}`);
        return result ? { report: result.report } : null;
    });

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

    ipcMain.handle('genie:open-agent', (_event, raw: unknown) => {
        // The renderer is not trusted to hand over a well-formed id. `asAgentId` returning
        // `null` is a refusal, not a repair: looking up `''` would find nothing and render an
        // empty session forever, which is the §0.4 failure reached through the bridge.
        const record = agentFromRenderer(raw);
        if (!record || !host) return { ok: false, reason: 'unknown agent' };

        // An asleep workspace starts nothing (§6.1) — refused by name, never silently.
        const asleep = startRefusal(workspaceOps, record, {
            running: registry!.agentsOf(record.workspaceId).filter((a) => host!.probe(a.id)?.running === true).length,
            cap: agentCapFrom(services?.settings.snapshotFor(record.workspaceId) ?? {}),
        });
        if (asleep) return { ok: false, reason: asleep };
        // Start or REATTACH. Starting one that is already running returns the same session
        // rather than a second — two provider processes answering as one agent is how a user
        // ends up with something they cannot stop.
        return host.start(record, cwdFor(record));
    });

    ipcMain.handle('genie:stop-agent', (_event, raw: unknown) => {
        const record = agentFromRenderer(raw);
        if (!record || !host) return { ok: false };
        return { ok: host.stop(record.id) };
    });

    // `Stop this turn` (the chat's context line, the Agent view's header): the current turn ends, the agent keeps
    // running. Ending the agent is `genie:stop-agent` above — a separate action, never reached from here.
    // `Resume now` (Tynn #794): the agent's provider login is opened at once and its held agents go on.
    ipcMain.handle('genie:resume-limit', (_event, raw: unknown) => {
        const record = agentFromRenderer(raw);
        if (!record || !host) return { ok: false, reason: 'not-running' };
        host.resumeLimit(record.provider);
        return { ok: true };
    });

    ipcMain.handle('genie:cancel-turn', (_event, raw: unknown) => {
        const record = agentFromRenderer(raw);
        if (!record || !host) return { ok: false, reason: 'not-running' };
        return host.cancel(record.id);
    });

    ipcMain.handle('genie:prompt', (_event, raw: unknown, text: unknown, files: unknown) => {
        const record = agentFromRenderer(raw);
        const attachments = attachmentsFromRenderer(files);
        if (!record || !host || typeof text !== 'string' || attachments === null || (text.length === 0 && attachments.length === 0)) return { ok: false };
        // The composer: the turn is started by YOU, and the ledger says so.
        const sent = host.promptWith(record.id, text, attachments, 'you');
        return sent.ok ? { ok: true } : { ok: false, ...(sent.reason ? { reason: sent.reason } : {}) };
    });

    ipcMain.handle('genie:answer-approval', (_event, raw: unknown, optionId: unknown, note: unknown) => {
        const record = agentFromRenderer(raw);
        if (!record || !host || typeof optionId !== 'string') return { ok: false };
        // The session checks the id against the parked request. A refusal leaves the approval
        // parked, which is recoverable; answering with something meaningless is not.
        return { ok: host.answerApproval(record.id, optionId, typeof note === 'string' ? note : '') };
    });

    ipcMain.handle('genie:add-agent', async (_event, rawWorkspaceId: unknown) => {
        if (typeof rawWorkspaceId !== 'string' || !registry) return { ok: false };
        const record = await registry.register({
            workspaceId: rawWorkspaceId,
            provider: 'claude',
            name: `agent-${Date.now().toString(36)}`,
        });
        return { ok: true, id: record.id };
    });

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
    const agentOps: AgentOpsPorts = {
        registry: {
            find: (id) => registry?.find(id as AgentId) ?? null,
            forget: (id) => registry!.forget(id),
            clearThread: (id) => registry!.clearThread(id),
            setProvider: (id, provider) => registry!.setProvider(id, provider),
            setBudget: (id, usd) => registry!.setBudget(id, usd),
            setMode: (id, mode) => registry!.setMode(id, mode),
            setAccessScope: (id, scope) => registry!.setAccessScope(id, scope),
            setAutoApprove: (id, on) => registry!.setAutoApprove(id, on),
            setIssueWatch: (id, setting) => registry!.setIssueWatch(id, setting),
            setPermissions: (id, permissions) => registry!.setPermissions(id, permissions),
            setModel: (id, model) => registry!.setModel(id, model),
        },
        host: {
            start: (record, cwd) => host!.start(record, cwd),
            stop: (id) => host!.stop(id),
            probe: (id) => host!.probe(id),
        },
        cwdFor,
        workspacePathFor: (record) => registry?.snapshot().workspaces?.find((w) => w.id === record.workspaceId)?.path ?? null,
        readManifest: async (record) => {
            const workspace = registry?.snapshot().workspaces?.find((w) => w.id === record.workspaceId)?.path;
            if (!workspace) return null;
            try {
                return await readFile(join(workspace, record.instructions ?? join('.agents', record.name, 'AGENT.md')), 'utf8');
            } catch {
                return null;
            }
        },
        removeDir: (path) => rm(path, { recursive: true, force: true }),
        removeHandoff: async (record) => {
            const workspace = registry?.snapshot().workspaces?.find((w) => w.id === record.workspaceId)?.path;
            if (workspace) await rm(join(workspace, '.ai', 'handoff', `${record.name}.md`), { force: true });
        },
        linkedSystems: () => [],
        providerInstalled: (provider) => providerBinary(provider as AgentRecord['provider']) !== null,
        signedIn: () => true,
        applyOnStart: (id) => settingApplier!.requested(id),
    };
    // Background tasks die with the process: a setting waits for the agent's to end (the Shells tab's own count).
    settingApplier = new SettingApplier(agentOps, (id) => (host ? agentShells(host.rowsFor(id)).count : 0));
    // `Log in to <provider>` (the owner, 2026-10-18): the provider's own login in a scratch folder, in a window of its own.
    // Signed in (its status command exits 0), every agent that login signed out is restarted on its thread and told.
    const logins = new LoginHost({
        terminals: terminalsForTakeOver,
        openWindow: (route) => openTakeOverWindow(route),
        binaryFor: (provider) => providerBinary(provider as AgentRecord['provider']) ?? null,
        runStatus: (command, cwd) => new Promise<number>((resolve) => {
            execFileCb(command, { shell: true, cwd, timeout: 30_000, windowsHide: true }, (error) => {
                resolve(error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1);
            });
        }),
        onSignedIn: (provider) => {
            for (const id of host?.signedOutAgents(provider) ?? []) {
                void restartAgent(agentOps, id, 'graceful').then((r) => { if (r.ok) host?.prompt(id, SIGNED_IN_AGAIN, 'genie'); }).finally(() => registry?.touch());
            }
        },
    });
    loginHost = logins;
    // TRY AGAIN, for a login whose account the provider paused (core/account-pause.ts): every agent it stopped comes back.
    retryPausedAccount = (provider) => {
        for (const id of host?.pausedAgents(provider) ?? []) {
            void restartAgent(agentOps, id, 'graceful').then((r) => { if (r.ok) host?.prompt(id, ACCOUNT_BACK, 'genie'); }).finally(() => registry?.touch());
        }
    };
    ipcMain.handle('genie:account-retry', (_event, raw: unknown) => {
        const record = typeof raw === 'string' ? registry?.find(raw as AgentId) ?? null : null;
        if (!record) return { ok: false, reason: 'No agent named.' };
        retryPausedAccount?.(record.provider);
        return { ok: true };
    });
    ipcMain.handle('genie:provider-login', (_event, raw: unknown) => {
        const record = typeof raw === 'string' ? registry?.find(raw as AgentId) ?? null : null;
        if (!record) return { ok: false, reason: 'No agent named.' };
        const started = logins.start(record.provider);
        return started.ok ? { ok: true } : started;
    });
    ipcMain.handle('genie:agent-restart', (_event, raw: unknown, kind: unknown) => {
        if (typeof raw !== 'string' || (kind !== 'graceful' && kind !== 'fresh')) return { ok: false, reason: 'a restart names an agent and a kind: graceful or fresh' };
        return restartAgent(agentOps, raw, kind).finally(() => registry?.touch());
    });
    ipcMain.handle('genie:agent-preview-delete', (_event, raw: unknown, outcome: unknown, also: unknown) => {
        if (typeof raw !== 'string' || (outcome !== 'unmount' && outcome !== 'delete')) return { ok: false, reason: 'a delete names an agent and an outcome: unmount or delete' };
        return previewDelete(agentOps, raw, outcome, Array.isArray(also) ? also.map(String) : []);
    });
    ipcMain.handle('genie:agent-delete', (_event, raw: unknown, outcome: unknown, also: unknown) => {
        if (typeof raw !== 'string' || (outcome !== 'unmount' && outcome !== 'delete')) return { ok: false, reason: 'a delete names an agent and an outcome: unmount or delete' };
        return deleteAgent(agentOps, raw, outcome, Array.isArray(also) ? also.map(String) : []).finally(() => registry?.touch());
    });
    ipcMain.handle('genie:agent-switch-driver', (_event, raw: unknown, to: unknown) => {
        if (typeof raw !== 'string' || typeof to !== 'string') return { ok: false, reason: 'a switch names an agent and a provider' };
        return switchDriver(agentOps, raw, to).finally(() => registry?.touch());
    });
    ipcMain.handle('genie:agent-set-mode', (_event, raw: unknown, mode: unknown) =>
        (typeof raw === 'string' && (mode === 'automated' || mode === 'manual') ? setMode(agentOps, raw, mode).finally(() => registry?.touch()) : { ok: false, reason: 'mode is automated or manual' }));
    ipcMain.handle('genie:agent-set-permissions', (_event, raw: unknown, permissions: unknown) =>
        (typeof raw === 'string' && (permissions === 'all' || permissions === 'edits' || permissions === 'ask') ? setPermissions(agentOps, raw, permissions).finally(() => registry?.touch()) : { ok: false, reason: 'permissions are all, ask or edits' }));
    ipcMain.handle('genie:agent-set-model', (_event, raw: unknown, model: unknown) =>
        (typeof raw === 'string' && (model === null || typeof model === 'string') ? setModel(agentOps, raw, model).finally(() => registry?.touch()) : { ok: false, reason: 'a model is a name, or null for the provider default' }));
    // Autonomous or asked (Tynn #801): its next gated action reads it; nothing restarts.
    ipcMain.handle('genie:agent-set-auto-approve', (_event, raw: unknown, on: unknown) =>
        (typeof raw === 'string' && typeof on === 'boolean' ? setAutoApprove(agentOps, raw, on).finally(() => registry?.touch()) : { ok: false, reason: 'autonomy is on or off' }));
    // What it hears from IssueWatch (Tynn #806): the setting is checked in setIssueWatch, which says why it refuses one.
    ipcMain.handle('genie:agent-set-issue-watch', (_event, raw: unknown, setting: unknown) =>
        (typeof raw === 'string' ? setIssueWatch(agentOps, raw, setting).finally(() => registry?.touch()) : { ok: false, reason: 'unknown agent' }));
    ipcMain.handle('genie:agent-set-access-scope', (_event, raw: unknown, scope: unknown) =>
        (typeof raw === 'string' && (scope === 'none' || scope === 'self' || scope === 'all') ? setAccessScope(agentOps, raw, scope).finally(() => registry?.touch()) : { ok: false, reason: 'scope is none, self or all' }));
    ipcMain.handle('genie:agent-set-budget', (_event, raw: unknown, usd: unknown) => {
        if (typeof raw !== 'string' || (usd !== null && !(typeof usd === 'number' && usd >= 0))) return { ok: false, reason: 'a budget is a non-negative number of dollars, or null to clear it' };
        return setBudget(agentOps, raw, usd as number | null).finally(() => registry?.touch());
    });
    ipcMain.handle('genie:agent-diagnose', (_event, raw: unknown) => (typeof raw === 'string' ? diagnose(agentOps, raw) : { ok: false, reason: 'diagnose names an agent' }));

    ipcMain.handle('genie:restart-with-handoff', (_event, raw: unknown, finishedId: unknown) => {
        const record = agentFromRenderer(raw);
        if (!record || !host || !services || typeof finishedId !== 'string') return { ok: false, reason: 'unknown agent or finish' };
        // Stop → start → the handoff as the first prompt → seen. The order and the refusals live in
        // restart-with-handoff.ts; this is the thin call.
        const r = restartWithHandoff(host, services.attention, record, cwdFor(record), finishedId);
        registry?.touch();
        return r;
    });

    ipcMain.handle('genie:take-over', (_event, raw: unknown) => {
        if (!takeOvers || typeof raw !== 'string') return { ok: false, reason: 'No agent named.' };
        const record = registry?.find(raw as AgentId) ?? null;
        if (!record) return { ok: false, reason: `No agent is registered as ${raw}.` };
        const workspace = registry?.snapshot().workspaces?.find((w) => w.id === record.workspaceId) ?? null;
        if (!workspace) return { ok: false, reason: `${record.name}'s workspace is not registered.` };
        // The TUI is the provider's own CLI, resolved the way a session resolves it. No MCP
        // URL is set: genie2 has no MCP server yet, and a fake one would be worse than none.
        const tui = providerBinary(record.provider) ?? record.provider;
        return takeOvers.start(record, workspace.path, tui);
    });

    ipcMain.handle('genie:terminal-open', (_event, rawWorkspaceId: unknown, rawOptions: unknown) => {
        if (!terminals || typeof rawWorkspaceId !== 'string') return null;
        const workspace = registry?.snapshot().workspaces?.find((w) => w.id === rawWorkspaceId) ?? null;
        if (!workspace) return null;
        const options = (rawOptions ?? {}) as { cols?: unknown; rows?: unknown; command?: unknown };
        const cols = typeof options.cols === 'number' && options.cols > 0 ? Math.floor(options.cols) : undefined;
        const rows = typeof options.rows === 'number' && options.rows > 0 ? Math.floor(options.rows) : undefined;
        const command = typeof options.command === 'string' && options.command.trim() ? options.command : undefined;
        try {
            // cwd RESUME (§6.5): a new terminal opens where the workspace's last shell was, when tracking is on.
            const trackCwd = (services?.settings.snapshot() ?? {}).track_cwd !== false;
            const cwd = (trackCwd ? terminals.lastCwd(workspace.id) : null) ?? workspace.path;
            // A shell in a workspace sees the workspace's service engines (DB_*, REDIS_URL…), like its processes do, and
            // GENIE_MCP_URL / GENIE_MCP_TOKEN (§6.9); the pty port adds GENIE_TERMINAL_ID itself. The SAME function gives an
            // agent's `manageTerminals create` its env (the `terminalEnv` part below).
            const env = terminalEnvFor(services, workspace.id, mcpEnv());
            return terminals.open({ workspaceId: workspace.id, cwd, command, cols, rows, ...(Object.keys(env).length > 0 ? { env } : {}) });
        } catch (error: unknown) {
            // The engine's own words, on the main process's stderr, where a VM run's
            // installed-err.log catches them. The first fancy-pty failure on the installed app
            // (2026-10-10) reached nobody: the port handed back pid -1 and nothing was logged.
            console.error(`[terminal] open failed in ${workspace.path}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    });
    ipcMain.handle('genie:terminal-write', (_event, id: unknown, data: unknown) =>
        typeof id === 'string' && typeof data === 'string' ? (terminals?.write(id, data) ?? false) : false);
    ipcMain.handle('genie:terminal-resize', (_event, id: unknown, cols: unknown, rows: unknown) =>
        typeof id === 'string' && typeof cols === 'number' && typeof rows === 'number'
            ? (terminals?.resize(id, Math.floor(cols), Math.floor(rows)) ?? false)
            : false);
    ipcMain.handle('genie:terminal-close', (_event, id: unknown) =>
        typeof id === 'string' ? (terminals?.close(id) ?? false) : false);
    ipcMain.handle('genie:terminal-list', (_event, rawWorkspaceId: unknown) =>
        typeof rawWorkspaceId === 'string'
            ? (terminals?.list().filter((t) => t.workspaceId === rawWorkspaceId).map(({ id, pid, shell }) => ({ id, pid, shell })) ?? [])
            : []);

    // JOIN a running terminal (§6.5 multi-attach): scrollback so far; null for another workspace's id or a gone one.
    ipcMain.handle('genie:terminal-attach', (_event, workspaceId: unknown, id: unknown) => {
        if ((typeof workspaceId !== 'string' && workspaceId !== null) || typeof id !== 'string') return null;
        const joined = terminals?.attach(id) ?? null;
        // The host's own windows may join any terminal (null); a named workspace must match.
        if (!joined || (workspaceId !== null && joined.workspaceId !== workspaceId)) return null;
        return { id: joined.id, pid: joined.pid, shell: joined.shell, scrollback: joined.scrollback };
    });
    ipcMain.handle('genie:terminal-previous', (_event, workspaceId: unknown) => (typeof workspaceId === 'string' ? snapshots?.take(workspaceId) ?? null : null));

    // THE FILE PANEL (§4.3). Confinement happens in the host; the renderer never sees a path it did not ask about.
    ipcMain.handle('genie:files-last-committed', (_event, workspaceId: unknown, path: unknown) => (typeof workspaceId === 'string' && typeof path === 'string' ? filesHost?.lastCommitted(workspaceId, path) ?? null : null));
    ipcMain.handle('genie:files-tree', (_event, workspaceId: unknown) => (typeof workspaceId === 'string' ? filesHost?.tree(workspaceId) ?? null : null));
    ipcMain.handle('genie:files-children', (_event, workspaceId: unknown, dir: unknown) => (typeof workspaceId === 'string' && typeof dir === 'string' ? filesHost?.children(workspaceId, dir) ?? null : null));
    ipcMain.handle('genie:files-open', (_event, workspaceId: unknown, path: unknown) =>
        typeof workspaceId === 'string' && typeof path === 'string' ? filesHost?.open(workspaceId, path) ?? { ok: false, path, error: 'no files host' } : { ok: false, path: String(path), error: 'bad arguments' });
    // A MEDIA TAB'S BYTES (the owner, 2026-10-21: an image showed broken): the Files panel's own viewer, so no plugin gate —
    // the same confinement and size cap as the text read (files-host `readBytes`).
    ipcMain.handle('genie:files-read-media', (_event, workspaceId: unknown, path: unknown) =>
        typeof workspaceId === 'string' && typeof path === 'string' ? filesHost?.readBytes(workspaceId, path) ?? { ok: false, path, error: 'no files host' } : { ok: false, path: String(path), error: 'bad arguments' });
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
    // THE TREE'S FILE OPERATIONS (Tynn #844): confined, never overwriting, Delete to the trash — all in the host.
    const fileOp = (run: (host: FilesHost) => Promise<unknown>) => (filesHost ? run(filesHost) : Promise.resolve({ ok: false, reason: 'no files host' }));
    const str = (v: unknown): v is string => typeof v === 'string';
    ipcMain.handle('genie:files-create', (_event, workspaceId: unknown, path: unknown, kind: unknown) =>
        str(workspaceId) && str(path) && (kind === 'file' || kind === 'folder') ? fileOp((h) => h.create(workspaceId, path, kind)) : { ok: false, reason: 'bad arguments' });
    ipcMain.handle('genie:files-rename', (_event, workspaceId: unknown, from: unknown, to: unknown) =>
        str(workspaceId) && str(from) && str(to) ? fileOp((h) => h.rename(workspaceId, from, to)) : { ok: false, reason: 'bad arguments' });
    ipcMain.handle('genie:files-duplicate', (_event, workspaceId: unknown, path: unknown) =>
        str(workspaceId) && str(path) ? fileOp((h) => h.duplicate(workspaceId, path)) : { ok: false, reason: 'bad arguments' });
    ipcMain.handle('genie:files-trash', (_event, workspaceId: unknown, path: unknown) =>
        str(workspaceId) && str(path) ? fileOp((h) => h.trash(workspaceId, path)) : { ok: false, reason: 'bad arguments' });
    // A PLUGIN EDITOR'S BYTES (beta.33 item 14): through the plugin gate — an enabled plugin's own claimed and declared types only.
    const editorBytesDeps = (): EditorBytesDeps | null => (filesHost && services ? { gate: (pluginId, path) => services!.plugins.editorBytes(pluginId, path), files: filesHost } : null);
    ipcMain.handle('genie:files-read-bytes', (_event, workspaceId: unknown, pluginId: unknown, path: unknown) => {
        const deps = editorBytesDeps();
        return deps ? editorRead(deps, workspaceId, pluginId, path) : { ok: false, path: typeof path === 'string' ? path : '', error: 'no files host' };
    });
    ipcMain.handle('genie:files-write-bytes', (_event, workspaceId: unknown, pluginId: unknown, path: unknown, base64: unknown, expectedSha: unknown) => {
        const deps = editorBytesDeps();
        return deps ? editorWrite(deps, workspaceId, pluginId, path, base64, expectedSha) : { ok: false, reason: 'no files host' };
    });
    ipcMain.handle('genie:files-state', (_event, workspaceId: unknown) => (typeof workspaceId === 'string' ? filesHost?.state(workspaceId) ?? null : null));
    ipcMain.handle('genie:files-watch', (_event, workspaceId: unknown) => (typeof workspaceId === 'string' ? filesHost?.watch(workspaceId) : undefined));
    ipcMain.handle('genie:files-popout', (_event, workspaceId: unknown) => { if (typeof workspaceId === 'string') filesWindows?.popOut(workspaceId); });
    ipcMain.handle('genie:remote-open-window', (_event, url: unknown) => { if (typeof url === 'string') openRemoteWindow(url); });
    // THE TYNN NETWORK, AS A MEMBER (Tynn #837; Genie 1's workstation:connectable / workstation:open): the workstations
    // Tynn lists, and a connection to one — the grant and its proof key minted and held HERE, never in the window.
    ipcMain.handle('genie:tynn-workstations', async () => {
        const account = tynnAccount;
        if (!account) return { ok: false, reason: 'this Genie has no Tynn account' };
        const own = tynnWorkstationNow?.registered ? tynnWorkstationNow.workstationId : null;
        return connectableWorkstations((path, init) => account.request(path, init), own);
    });
    ipcMain.handle('genie:relay-open', async (event, workstationId: unknown) => {
        if (typeof workstationId !== 'string' || relayWorkstationOf(`relay:${workstationId}`) === null) return { ok: false, reason: 'not a Tynn workstation' };
        const account = tynnAccount;
        if (!account?.status().signedIn) return { ok: false, reason: 'sign in to Tynn to connect to a Tynn workstation' };
        const pop = PopKeypair.generate();
        const grant = await mintConnectGrant((path, init) => account.request(path, init), workstationId, pop.publicJwk);
        if (!grant.ok) return grant;
        const opened = await openRelayMember({ socket: relaySocket, relayUrl: grant.relayEndpoint, workstationId, grant: grant.token, pop });
        if (!opened.ok) return opened;
        const channel = `relay_${++nextRelayChannel}`;
        const sender = event.sender;
        relayChannels.set(channel, { transport: opened.transport, sender });
        opened.transport.onMessage((text) => { if (!sender.isDestroyed()) sender.send('genie:relay-message', channel, text); });
        opened.transport.onClose(() => {
            relayChannels.delete(channel);
            if (!sender.isDestroyed()) sender.send('genie:relay-closed', channel, opened.transport.closedBecause());
        });
        // The window went: its connection goes with it.
        sender.once('destroyed', () => opened.transport.close());
        return { ok: true, channel };
    });
    // SHARING THIS MACHINE THROUGH TYNN (Tynn #839; Genie 1's workspace share links), over the session.
    const ownWorkstation = () => (tynnWorkstationNow?.registered ? tynnWorkstationNow.workstationId : null);
    const shareRequest = (path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }) => {
        if (!tynnAccount) return Promise.reject(new Error('this Genie has no Tynn account'));
        return tynnAccount.request(path, init);
    };
    ipcMain.handle('genie:tynn-share-links', (_event, workspaceId: unknown) => listShareLinks(shareRequest, ownWorkstation(), typeof workspaceId === 'string' ? workspaceId : null));
    ipcMain.handle('genie:tynn-share-mint', (_event, input: unknown) => {
        const i = (input ?? {}) as { workspaceId?: unknown; capability?: unknown; expiresInDays?: unknown };
        return mintShareLink(shareRequest, ownWorkstation(), {
            workspaceId: typeof i.workspaceId === 'string' ? i.workspaceId : null,
            capability: i.capability === 'readonly' ? 'readonly' : 'control',
            expiresInDays: typeof i.expiresInDays === 'number' ? i.expiresInDays : 7,
        });
    });
    ipcMain.handle('genie:tynn-share-revoke', (_event, linkId: unknown) => (typeof linkId === 'string' ? revokeShareLink(shareRequest, ownWorkstation(), linkId) : { ok: false, reason: 'not a link' }));
    // Only the window that opened a channel may use it.
    ipcMain.on('genie:relay-send', (event, channel: unknown, text: unknown) => {
        const c = typeof channel === 'string' ? relayChannels.get(channel) : undefined;
        if (c && c.sender === event.sender && typeof text === 'string') c.transport.send(text);
    });
    ipcMain.on('genie:relay-close', (event, channel: unknown) => {
        const c = typeof channel === 'string' ? relayChannels.get(channel) : undefined;
        if (c && c.sender === event.sender) c.transport.close();
    });
    ipcMain.handle('genie:files-bringback', (_event, workspaceId: unknown) => { if (typeof workspaceId === 'string') filesWindows?.bringBack(workspaceId); });
    ipcMain.handle('genie:files-windows', () => filesWindows?.list() ?? []);
    ipcMain.handle('genie:files-write', (_event, workspaceId: unknown, path: unknown, text: unknown, expectedSha: unknown) =>
        (typeof workspaceId === 'string' && typeof path === 'string' && typeof text === 'string' ? filesHost?.write(workspaceId, path, text, typeof expectedSha === 'string' ? expectedSha : null) ?? { ok: false, reason: 'no files host' } : { ok: false, reason: 'bad arguments' }));

    /*
     * WORKSPACE OPERATIONS (§6.1). The plans live in core/workspace-model.ts, the sequencing in
     * workspace-ops-host.ts; these ports are the real registry, session host, terminal host,
     * supervisor and filesystem. Add is preview-then-confirm: the picker and the classification
     * write nothing; `confirmAdd` does the writes the plan showed.
     */
    const workspaceOps: WorkspaceOpsPorts = {
        fs: {
            exists: async (p) => { try { return (await statPath(p)).isDirectory(); } catch { return false; } },
            entries: (p) => readdir(p),
            readJson: async (p) => { try { return JSON.parse(await readFileText(p, 'utf8')) as unknown; } catch { return null; } },
            writeJson: (p, value) => writeFileText(p, `${JSON.stringify(value, null, 2)}\n`, 'utf8'),
            mkdir: (p) => mkdir(p, { recursive: true }).then(() => {}),
            gitInit,
            // The clone's own stderr is the reason a person reads; a bare exit code is not — see git-ports.ts, measured against a real git.
            // Signed in to GitHub, a repository of an account the app is installed on (with Contents) clones with that sign-in
            // (core/github.ts cloneAuthFor); anything else with the person's own git credentials, as before.
            gitClone: (url, into) => gitClone(url, into, githubAccount?.cloneAuth(url) ?? undefined),
        },
        registry: {
            workspace: (id) => registry?.workspace(id) ?? null,
            addWorkspace: (w) => registry!.addWorkspace(w),
            agentsOf: (id) => registry?.agentsOf(id) ?? [],
            setAsleep: (id, asleep) => registry!.setAsleep(id, asleep),
            forgetWorkspace: (id) => registry!.forgetWorkspace(id),
        },
        host: {
            probe: (id) => host?.probe(id) ?? null,
            prompt: (id, text) => host?.prompt(id, text) ?? false,
            stop: (id) => host?.stop(id) ?? false,
        },
        attention: { finished: () => services?.attention.finished() ?? [] },
        terminals: { list: () => terminals?.list() ?? [], close: (id) => terminals?.close(id) ?? false },
        supervisor: { list: () => services?.supervisor.list() ?? [], stop: (id) => services?.supervisor.stop(id) ?? false },
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        // TYNN (§6.1 add from Tynn): the host and token from settings, read at call time; the client is one fetch.
        tynn: {
            // The account's own host (settings, trimmed): the project.json link names the Tynn the projects came from.
            get host() { return tynnAccount?.host() ?? 'https://tynn.ai'; },
            // The signed-in person's projects (main/tynn-account.ts) — signed out is refused before any request.
            projects() {
                if (!tynnAccount) return Promise.reject(new Error('this Genie has no Tynn account'));
                return tynnAccount.projects();
            },
        },
    };
    // THE REPO REGISTRY (§6.1): the envelope's repos[], through the same fs ports; the host repo is protected in core.
    const repoOps: RepoOpsPorts = {
        fs: {
            ...workspaceOps.fs,
            // The repo chips read `.git/HEAD` and stat `.git/index.lock`; "Remove stale lock" unlinks it (only when stale).
            readText: async (p) => { try { return await readFileText(p, 'utf8'); } catch { return null; } },
            mtime: async (p) => { try { return (await statPath(p)).mtimeMs; } catch { return null; } },
            unlink: async (p) => { const { unlink } = await import('node:fs/promises'); await unlink(p); },
        },
        registry: { workspace: (id) => registry?.workspace(id) ?? null },
    };
    ipcMain.handle('genie:workspace-repo-unlock', (_event, raw: unknown, slug: unknown) => (typeof raw === 'string' && typeof slug === 'string' ? removeRepoLockOf(repoOps, raw, slug) : { ok: false, reason: 'name a workspace and a repo' }));
    ipcMain.handle('genie:workspace-repos', (_event, raw: unknown) => (typeof raw === 'string' ? listReposOf(repoOps, raw) : { ok: false, reason: 'name a workspace' }));
    // The commits in the workspace's repos since a moment (an observed agent's index): git's own account.
    ipcMain.handle('genie:workspace-commits-since', (_event, raw: unknown, since: unknown) => (typeof raw === 'string' && typeof since === 'number' ? commitsSinceIn(repoOps, raw, since) : { ok: false, reason: 'name a workspace and a moment' }));
    // "Locate repo" on a Dashboard group fault: a real folder the user picks, inside the envelope; the manifest's path moves.
    // The folder is picked in the window over the host's disk (Tynn #835); the manifest's path moves.
    ipcMain.handle('genie:workspace-repo-locate', (_event, raw: unknown, slug: unknown, path: unknown) =>
        (typeof raw === 'string' && typeof slug === 'string' && typeof path === 'string' && path !== '' ? relocateRepoIn(repoOps, raw, slug, path) : { ok: false, reason: 'name a workspace, a repo and its folder' }));
    ipcMain.handle('genie:workspace-repo-add', (_event, raw: unknown, input: unknown) => {
        const i = (typeof input === 'object' && input !== null ? input : {}) as { name?: unknown; path?: unknown };
        return typeof raw === 'string' ? addRepoTo(repoOps, raw, { name: String(i.name ?? ''), path: String(i.path ?? '') }) : { ok: false, reason: 'name a workspace' };
    });
    ipcMain.handle('genie:workspace-repo-remove', (_event, raw: unknown, slug: unknown) => (typeof raw === 'string' && typeof slug === 'string' ? removeRepoFrom(repoOps, raw, slug) : { ok: false, reason: 'name a workspace and a repo' }));
    // WORKSPACE SETTINGS (§6.1): the workspace-scoped keys with THIS workspace's effective values and its overrides.
    ipcMain.handle('genie:workspace-settings', (_event, raw: unknown) =>
        (typeof raw === 'string' && services ? { ok: true, values: services.settings.snapshotFor(raw), overridden: Object.keys(services.settings.workspaceValues(raw)) } : { ok: false, reason: 'name a workspace' }));
    ipcMain.handle('genie:workspace-setting-set', async (_event, raw: unknown, key: unknown, value: unknown) => {
        if (typeof raw !== 'string' || typeof key !== 'string' || !services) return { ok: false, reason: 'name a workspace and a setting' };
        try { await services.settings.setFor(raw, key, value); return { ok: true }; } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    });
    ipcMain.handle('genie:workspace-setting-reset', async (_event, raw: unknown, key: unknown) => {
        if (typeof raw !== 'string' || typeof key !== 'string' || !services) return { ok: false, reason: 'name a workspace and a setting' };
        try { await services.settings.resetFor(raw, key); return { ok: true }; } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    });
    // OPS PROJECTS (§6.1): which workspaces this one governs.
    ipcMain.handle('genie:workspace-set-governs', (_event, raw: unknown, children: unknown) =>
        (typeof raw === 'string' && registry ? registry.setGoverns(raw, Array.isArray(children) ? children.filter((c): c is string => typeof c === 'string') : []) : { ok: false, reason: 'name a workspace' }));
    // THE DEFAULT AGENT (Genie 1's): one of the workspace's own agents, or null.
    ipcMain.handle('genie:workspace-set-default-agent', (_event, raw: unknown, agentId: unknown) =>
        (typeof raw === 'string' && registry ? registry.setDefaultAgent(raw, typeof agentId === 'string' && agentId !== '' ? agentId : null) : { ok: false, reason: 'name a workspace' }));
    // The folder is picked IN THE WINDOW (Tynn #835: a FileBrowser over the host's disk) — no native dialog.
    ipcMain.handle('genie:workspace-preview-add', async (_event, path: unknown) =>
        (typeof path === 'string' && path !== '' ? previewAddWorkspace(workspaceOps, path) : { ok: false, reason: 'no folder picked' }));
    ipcMain.handle('genie:host-list-dir', (_event, path: unknown) => listHostDir(typeof path === 'string' ? path : '/'));
    // Where a folder picker starts when nothing better is known (core/add-workspace.ts `pickerStart`): the host's home.
    ipcMain.handle('genie:host-home', () => homedir());
    // ADD FROM A GIT URL (§6.1): the parent folder is picked on the host; the plan is shown before the clone.
    // The parent is picked in the window over the host's disk (Tynn #835).
    const previewGit = async (url: string, parent: string) => { const plan = await previewAddFromGit(workspaceOps, url, parent); return plan.ok ? { ...plan, parent } : plan; };
    ipcMain.handle('genie:workspace-preview-add-git', (_event, rawUrl: unknown, rawParent: unknown) =>
        (typeof rawUrl === 'string' && typeof rawParent === 'string' && rawParent !== '' ? previewGit(rawUrl, rawParent) : { ok: false, reason: 'give a git URL and a parent folder' }));
    ipcMain.handle('genie:workspace-confirm-add-git', (_event, rawUrl: unknown, rawParent: unknown) =>
        (typeof rawUrl === 'string' && typeof rawParent === 'string' ? addWorkspaceFromGit(workspaceOps, rawUrl, rawParent) : { ok: false, reason: 'give a git URL and a parent folder' }));
    // ADD FROM TYNN (§6.1, Genie 1's): the signed-in person's projects to pick from; then the parent folder, picked on the
    // host, and the plan for THAT project before anything is written.
    ipcMain.handle('genie:workspace-tynn-projects', () => listTynnProjects(workspaceOps));
    ipcMain.handle('genie:workspace-preview-add-tynn', (_event, rawId: unknown, rawParent: unknown) =>
        (typeof rawId === 'string' && rawId.length > 0 && typeof rawParent === 'string' && rawParent !== '' ? previewAddFromTynn(workspaceOps, rawParent, rawId) : { ok: false, reason: 'choose a Tynn project and a parent folder' }));
    ipcMain.handle('genie:workspace-confirm-add-tynn', (_event, rawParent: unknown, rawId: unknown) =>
        (typeof rawParent === 'string' && typeof rawId === 'string' ? addWorkspaceFromTynn(workspaceOps, rawParent, rawId) : { ok: false, reason: 'give a parent folder and a Tynn project' }));
    ipcMain.handle('genie:workspace-confirm-add', (_event, raw: unknown) => (typeof raw === 'string' ? addWorkspaceOp(workspaceOps, raw) : { ok: false, reason: 'confirmAdd names a folder' }));
    // A NEW workspace (Genie 1's): a name and a folder; Genie makes <folder>/<slug>.agi (main/workspace-ops-host.ts).
    ipcMain.handle('genie:workspace-create', (_event, rawName: unknown, rawParent: unknown) =>
        (typeof rawName === 'string' && typeof rawParent === 'string' ? createWorkspaceOp(workspaceOps, rawName, rawParent) : { ok: false, reason: 'give the workspace a name and a folder' }));
    ipcMain.handle('genie:workspace-hibernate', (_event, raw: unknown) =>
        typeof raw === 'string' ? hibernateWorkspace(workspaceOps, raw, { handoffWaitMs: 20_000, pollMs: 500 }).finally(() => registry?.touch()) : { ok: false, reason: 'hibernate names a workspace' });
    ipcMain.handle('genie:workspace-wake', (_event, raw: unknown) => (typeof raw === 'string' ? wakeWorkspace(workspaceOps, raw) : { ok: false, reason: 'wake names a workspace' }));
    ipcMain.handle('genie:workspace-remove', (_event, raw: unknown) => (typeof raw === 'string' ? removeWorkspace(workspaceOps, raw) : { ok: false, reason: 'remove names a workspace' }));

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

        await registry.addWorkspace({ id: basename(path), path });
        return { ok: true };
    });

    /*
     * THE FEATURE SERVICES — every store, the Flow scheduler, the supervisor, the site manager and
     * the .gen front door, composed once (compose.ts). The v1 settings carry-over runs here on first
     * run, from v1's own database under the same ~/.genie.
     */
    // THE BACKGROUND PROCESSES THE PERSON KEEPS (§6.6, process-book.ts): opened once the services are composed;
    // until then every snapshot is the supervisor's alone. Late-bound so no closure below can meet it uninitialised.
    let processBook: ProcessBook | null = null;
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
            const r = await installTailscale();
            openHttps(r.url);
            await refreshTailscale();
            return r;
        },
    };
    void refreshTailscale();
    const processPorts = (): FeaturePorts => ({ tailscale: tailscalePort, ...(remoteAccessNow ? { remoteAccess: remoteAccessNow } : {}), ...(process.platform === 'win32' ? { allowFirewall: () => ensureFirewallRule(REMOTE_PORT) } : {}), ...(processBook ? { processes: processBook } : {}), ...(tynnAccount ? { tynnAccount } : {}), ...(githubAccount ? { githubAccount } : {}), tynnWorkstation: () => (tynnWorkstationNow?.registered ? { ...tynnWorkstationNow, relay: relayStatusNow } : tynnWorkstationNow), issueWatch: () => issueWatchPanels(), whatsNew: (shown) => whatsNewFor(app.getVersion(), String(composed.settings.get('whats_new_seen_version') ?? ''), RELEASE_NOTES, shown), appVersion: () => app.getVersion() });
    // THE HOST'S SOCKET (§6.8): fancy-ws on the Tailscale IPv4 only; with no Tailscale nothing listens and Settings says why.
    const remoteSocket = remoteListener({
        tailscale: () => new Promise<string>((resolve, reject) => { execFileCb('tailscale', ['status', '--json'], { windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))); }),
        port: REMOTE_PORT,
        attach: attachWebSocketServer,
        // The phone's page (§6.8): the built renderer, from the same directory the window loads it from.
        serve: staticServer(join(here, '../renderer')),
    });
    remoteSocketNow = remoteSocket;
    const remoteHub = transportHub(remoteSocket.transport);
    // Genie's Caddy RUNS from a per-user copy under ~/.genie, refreshed when the bundled binary's hash changes — never
    // from the install dir, which an NSIS update replaces under a running front door (Genie 1's genie#265).
    const bundledCaddy = caddyBinPath(process.resourcesPath, process.platform);
    const caddyCopy = bundledCaddy === null ? null : await userCaddyCopy(bundledCaddy, join(runtimeDir(genieHome()), 'caddy-bin'));
    if (caddyCopy?.error) console.error(`[caddy] ${caddyCopy.error}`);
    const composed = await composeServices({
        userData: genieHome(),
        pty: ptyPort,
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
        // Genie 1's scheduled tasks, read-only, brought over ONCE as DISARMED flows (main/v1-schedules.ts); the person arms them.
        v1Schedules: { database: v1DatabaseFile() },
        // What a flow's agent prompt reaches (flow-runner.ts): the live sessions, late-bound — a prompt to an agent mid-turn
        // is held back, never queued inside its turn.
        agentSessions: {
            session: (id) => host?.probe(id as AgentId) ?? null,
            rows: (id) => host?.rowsFor(id as AgentId) ?? [],
            prompt: (id, text, by) => host?.prompt(id as AgentId, text, by) ?? false,
            subscribe: (listener) => host?.subscribe((agentId) => listener(agentId)) ?? (() => {}),
        },
        // Genie's own Caddy — the per-user copy above (caddy-runtime.ts); null in a dev tree without one.
        caddyBin: caddyCopy?.path ?? null,
        // Each site's php-cgi gets Genie's CA ini directory once Check and repair has written one — read at each start.
        phpWorkerEnv: () => phpWorkerEnv(processEnv),
        // The system roots for PHP's trust bundle, beside Genie's own CA (main/php-trust-host.ts).
        phpSystemRoots: () => systemRootsPem(process.platform, (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } }, toolchainPaths(toolchainDataDir()).bundle),
        // A php site's pin (T4): unpinned runs PATH php-cgi as before; pinned runs that Genie-managed version or is refused.
        resolvePhpCgi: (pin) => resolvePhpCgi(pin, phpVersionsBase()),
        // Genie 1's `.gen` CA, already in this machine's trust store: ADOPTED (copied) when Genie 2 has no CA of its own, so
        // an upgrade serves https://<name>.gen trusted with no prompt (main/gen-ca.ts). Genie 1's userData, and its mirror.
        v1CaDirs: [...new Set([join(app.getPath('userData'), 'host-gen'), join(app.getPath('appData'), 'Genie', 'host-gen')])],
        frontDoorPort: 0,
        hostName: hostname(),
        // The tailnet listener, and the Tynn relay while it runs (Tynn #838).
        remoteTransport: remoteHub,
        mcpEndpoint: () => mcp?.endpoint() ?? null,
        mcpVerification: () => mcpVerified,
        mcpTools: () => mcpToolList,
        // The live roster, late-bound: the human's inbox resolves, names and counts from the same agents the MCP tools do.
        // A plain list, never `registry.snapshot()`: the snapshot builds the Deck's items, which ask this roster for
        // names — reading the snapshot here recursed until the stack overflowed (CI's real window, #161).
        roster: () => registry?.listAgents() ?? [],
        // The registered workspaces, whose envelopes declare the sites Hosting lists and serves (§6.6); a plain
        // list for the same reason as the roster. Their changes (added, removed, hibernated, woken) re-sync the sites.
        workspaces: () => registry?.listWorkspaces() ?? [],
        onWorkspacesChange: (listener) => registry?.subscribe(() => listener()) ?? (() => {}),
        // The rail's namer, so a question in the Deck and its window names the workspace the way the rail does.
        workspaceName: workspaceNameFor,
        // Is the agent that asked still waiting: its live session (session host) or its Take Over terminal. A question
        // whose agent has neither, or whose running session started after it was asked, is STALE on the Deck.
        askerLive: (id) => {
            // Not heard yet: nothing is judged (undefined), never "gone" or "ended".
            if (!askerLivenessKnown) return undefined;
            const session = host?.probe(id as AgentId) ?? null;
            if (session?.running) return { running: true, startedAt: session.startedAt };
            const takeOver = takeOvers?.probe(id as AgentId) ?? null;
            if (takeOver) return { running: true, startedAt: takeOver.startedAt };
            return session ? { running: false, startedAt: session.startedAt } : null;
        },
        /*
         * What a remote connection may perform here (§6.8): the same parts the IPC handlers use,
         * behind one invoke. Late-bound through `services`/`featurePorts`, which exist by the time
         * any remote call arrives. The SOCKET is not wired yet — fancy-ws awaits its first npm publish
         * — so nothing listens and Settings → Workstation says devices cannot connect yet.
         */
        remoteApi: buildHostApi({
            snapshot: () => registry!.snapshot(),
            subscribeSnapshot: (cb) => registry!.subscribe(cb),
            subscribeAgentRecords: (cb) => registry!.subscribeAgentRecords(cb),
            find: (id) => registry?.find(id as AgentId) ?? null,
            detailFor: (id) => detailFor(id as AgentId),
            cwdFor,
            host: {
                start: (record, cwd) => host!.start(record, cwd),
                stop: (id) => host!.stop(id),
                cancel: (id) => host!.cancel(id),
                resumeLimit: (provider) => host!.resumeLimit(provider),
                prompt: (id, text) => host!.prompt(id, text),
                answerApproval: (id, optionId, note) => host!.answerApproval(id, optionId, note ?? ''),
                subscribe: (cb) => host!.subscribe(cb),
            },
            registerAgent: async (workspaceId) => {
                const record = await registry!.register({ workspaceId, provider: 'claude', name: `agent-${Date.now().toString(36)}` });
                return { id: record.id };
            },
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
            // A phone's upload (§6.8): a temp file under ~/.genie/uploads for exactly as long as the inbox copies it.
            uploads: uploadSender({ dir: join(genieHome(), 'uploads'), resolve: (to) => services!.resolveAddress(to), send: (input) => services!.inbox.send(input) }),
            serviceEnvFor: (workspaceId) => services!.engines.envFor(workspaceId),
            workspaceOps: {
                previewAdd: (path) => previewAddWorkspace(workspaceOps, path),
                previewAddFromGit: (url, parent) => previewGit(url, parent),
                tynnProjects: () => listTynnProjects(workspaceOps),
                previewAddFromTynn: (projectId, parent) => previewAddFromTynn(workspaceOps, parent, projectId),
                locateRepo: (id, slug, path) => relocateRepoIn(repoOps, id, slug, path),
                confirmAdd: (path) => addWorkspaceOp(workspaceOps, path),
                create: (name, parent) => createWorkspaceOp(workspaceOps, name, parent),
                confirmAddFromGit: (url, parent) => addWorkspaceFromGit(workspaceOps, url, parent),
                confirmAddFromTynn: (parent, projectId) => addWorkspaceFromTynn(workspaceOps, parent, projectId),
                hibernate: (id) => hibernateWorkspace(workspaceOps, id, { handoffWaitMs: 20_000, pollMs: 500 }),
                wake: (id) => wakeWorkspace(workspaceOps, id),
                remove: (id) => removeWorkspace(workspaceOps, id),
                listRepos: (id) => listReposOf(repoOps, id),
                addRepo: (id, input) => addRepoTo(repoOps, id, input),
                removeRepo: (id, slug) => removeRepoFrom(repoOps, id, slug),
                removeRepoLock: (id, slug) => removeRepoLockOf(repoOps, id, slug),
                commitsSince: (id, since) => commitsSinceIn(repoOps, id, since),
                settings: (id) => ({ ok: true as const, values: services!.settings.snapshotFor(id), overridden: Object.keys(services!.settings.workspaceValues(id)) }),
                setSetting: async (id, key, value) => { try { await services!.settings.setFor(id, key, value); return { ok: true as const }; } catch (error) { return { ok: false as const, reason: error instanceof Error ? error.message : String(error) }; } },
                resetSetting: async (id, key) => { try { await services!.settings.resetFor(id, key); return { ok: true as const }; } catch (error) { return { ok: false as const, reason: error instanceof Error ? error.message : String(error) }; } },
                setGoverns: (id, children) => registry!.setGoverns(id, children),
                setDefaultAgent: (id, agentId) => registry!.setDefaultAgent(id, agentId),
            },
            agentOps: {
                restart: (id, kind) => restartAgent(agentOps, id, kind),
                previewDelete: (id, outcome, also) => previewDelete(agentOps, id, outcome, also),
                delete: (id, outcome, also) => deleteAgent(agentOps, id, outcome, also),
                switchDriver: (id, to) => switchDriver(agentOps, id, to),
                setBudget: (id, usd) => setBudget(agentOps, id, usd),
                setMode: (id, mode) => setMode(agentOps, id, mode),
                setAccessScope: (id, scope) => setAccessScope(agentOps, id, scope),
                setAutoApprove: (id, on) => setAutoApprove(agentOps, id, on),
                setIssueWatch: (id, setting) => setIssueWatch(agentOps, id, setting),
                setPermissions: (id, permissions) => setPermissions(agentOps, id, permissions),
                setModel: (id, model) => setModel(agentOps, id, model),
                diagnose: (id) => diagnose(agentOps, id),
            },
            features: {
                snapshot: () => featureSnapshot(services!, featureState, processPorts()),
                act: (action) => handleFeatureAction(services!, action, featureState, featurePorts),
                onChange: (cb) => { featureListeners.add(cb); return () => { featureListeners.delete(cb); }; },
            },
            updates: updates
                ? {
                      state: () => updates!.state(),
                      check: () => updates!.check(),
                      download: () => updates!.download(),
                      install: () => { const r = updates!.install(); return r ? { report: r.report } : null; },
                      onChange: (cb) => updates!.onChange(cb),
                  }
                : null,
        }),
    });
    services = composed;
    const pushFeatures = () => {
        void featureSnapshot(composed, featureState, processPorts()).then((data) => {
            if (window && !window.isDestroyed()) window.webContents.send(FEATURE_CHANNELS.changed, data);
            for (const l of featureListeners) l(data);
        });
    };
    composed.flows.onChange(pushFeatures);
    composed.settings.onChange(pushFeatures);
    composed.supervisor.onChange(pushFeatures);
    composed.onFrontDoorChange(pushFeatures);
    // The Services and Hosting tabs redraw when an AGENT acts through its `services` / `sites` tools, not only when the
    // person does (their own action answers with the snapshot; an agent's has nobody to answer but this push).
    composed.engines.onChange(pushFeatures);
    composed.sites.onChange(pushFeatures);
    // THIS GENIE'S TYNN ACCOUNT: the key encrypted by the OS in ~/.genie, for the host in settings (main/tynn-account.ts).
    // Genie 1's Tynn session, in its own persistent partition: Chromium keeps its cookies on disk under the OS's own
    // encryption, and nothing else Genie loads (the window, the Genie Browser) shares them.
    const tynnSession = session.fromPartition('persist:tynn');
    tynnAccount = await TynnAccount.open({
        host: () => TYNN_HOST,
        // Tynn unreachable at launch is asked again on a bounded backoff (main/tynn-account.ts TYNN_RETRY_MS), not never.
        schedule: (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); },
        cookies: {
            // As Genie 1 set genie_token (v1 main/auth.ts redeemToken).
            set: async (host, name, value) => {
                const url = new URL(host);
                await tynnSession.cookies.set({ url: host, name, value, domain: url.hostname, path: '/', secure: url.protocol === 'https:', httpOnly: false });
            },
            get: async (host, name) => (await tynnSession.cookies.get({ url: host, name }))[0]?.value ?? null,
            // As Genie 1's signOut cleared them: every cookie for the Tynn origin.
            clear: async (host) => {
                for (const c of await tynnSession.cookies.get({ url: host })) {
                    const cookieUrl = `${c.secure ? 'https' : 'http'}://${c.domain?.replace(/^\./, '') ?? new URL(host).host}${c.path ?? '/'}`;
                    try { await tynnSession.cookies.remove(cookieUrl, c.name); } catch { /* best effort */ }
                }
            },
        },
        // Session-bound: the global fetch is Node's and ignores Electron's cookie store (Genie 1 learned this the hard way).
        fetch: (url, init) => tynnSession.fetch(url, init),
        openExternal: (url) => shell.openExternal(url),
    });
    tynnAccount.onChange(pushFeatures);
    afterTynnUrl = pushFeatures;
    // GITHUB (beta.33 item 25; Genie 1's main/github/*): Genie 1's sign-in carried over — read from its genie.db, decrypted
    // with this Genie's safeStorage (the same userData, so the same key: measured) and kept encrypted in ~/.genie — or the
    // device flow. Every change reaches Settings and the Deck's signal at once; GitHub is read once now, and again on
    // Check again or after a sign-in (no polling of the API).
    githubAccount = await GithubAccount.open({
        file: join(genieHome(), 'github.json'),
        cipher: {
            isAvailable: () => safeStorage.isEncryptionAvailable(),
            encrypt: (text) => safeStorage.encryptString(text),
            decrypt: (bytes) => safeStorage.decryptString(bytes),
        },
        fetch: (url, init) => net.fetch(url, init),
        v1Settings: () => readV1Settings(v1DatabaseFile()),
        openExternal: (url) => shell.openExternal(url),
    });
    githubAccount.onChange(() => { pushFeatures(); registry?.touch(); });
    void githubAccount.refresh();
    // THIS MACHINE ON THE TYNN NETWORK (Tynn #836; Genie 1's ensureLocalWorkstation): signed in, it registers with that
    // Tynn once and keeps its key encrypted by the OS; every sign-in re-checks. One registration at a time, so a
    // sign-in landing during the launch's own check cannot make two workstations.
    const identities = workstationKeyStore(join(genieHome(), 'workstation.json'), {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (bytes) => safeStorage.decryptString(bytes),
    });
    let registering: Promise<void> | null = null;
    const registerWorkstation = (): Promise<void> => {
        if (registering) return registering;
        const account = tynnAccount;
        if (!account) return Promise.resolve();
        registering = (async () => {
            const host = account.host();
            if (!account.status().signedIn) {
                tynnWorkstationNow = { registered: false, reason: 'sign in to Tynn to register this machine' };
                return;
            }
            const result = await ensureWorkstation({ host: () => host, hostname, request: (path, init) => account.request(path, init), store: identities })
                .catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
            tynnWorkstationNow = result.ok ? { registered: true, host, workstationId: result.workstationId } : { registered: false, reason: result.reason };
        })().finally(() => { registering = null; void applyRelayHost(); pushFeatures(); });
        return registering;
    };
    // THIS GENIE ON THE TYNN RELAY, AS A HOST (Tynn #838; Genie 1's relay-host-controller): while remote access is on and
    // this machine is registered with the Tynn in use. Off, or registered elsewhere: the link stops.
    let relayFor: string | null = null;
    const applyRelayHost = async (): Promise<void> => {
        const account = tynnAccount;
        const registered = tynnWorkstationNow?.registered ? tynnWorkstationNow : null;
        const want = registered && account && composed.settings.get('remote_access') === true ? `${registered.host} ${registered.workstationId}` : null;
        if (want === relayFor) return;
        relayHostNow?.stop();
        relayHostNow = null;
        relayFor = want;
        relayStatusNow = { state: 'off' };
        if (!want || !registered) { pushFeatures(); return; }
        const stored = await identities.read(registered.host);
        if (!stored || relayFor !== want) { pushFeatures(); return; }
        const identity = identityFrom(stored);
        relayHostNow = startRelayHost({
            ports: relayHostPorts({ tynnHost: registered.host, workstationId: identity.workstationId, authHeader: () => identity.authHeader(), fetch }),
            socket: relaySocket,
            workstationId: identity.workstationId,
            fingerprint: identity.fingerprint,
            sign: (data) => identity.sign(data),
            attach: (transport) => remoteHub.add(transport),
            onStatus: (status) => { relayStatusNow = status; pushFeatures(); },
            log: (message) => console.log(`[tynn relay] ${message}`),
        });
    };
    relayAfterSwitch = () => { void applyRelayHost(); };
    tynnAccount.onChange(() => { void registerWorkstation(); });
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
    // `openSite` checks the site is served first): the pane loads it, the window comes up on the browser surface, and
    // the snapshot's address bar says it. The person sees what the agent opened; nothing opens outside Genie.
    const openInBrowser: OpenInBrowser = async (url) => {
        if (!browserPane) return { ok: false, reason: 'Genie’s window is not open yet' };
        featureState = { ...featureState, browserUrl: url };
        broadcast('genie:navigate', browserRoute.format({ url }));
        const shown = await browserPane.show(url);
        pushFeatures();
        return shown.ok ? { ok: true } : { ok: false, reason: shown.reason };
    };
    // Bring back what the person keeps running (Genie 1 did, from terminal_specs); a hibernated workspace starts nothing.
    // Genie's own quit stops these through the supervisor and never touches the book, so a quit is not a stop.
    processBook = await ProcessBook.open(genieHome(), {
        supervisor: composed.supervisor,
        envFor: (workspaceId) => composed.engines.envFor(workspaceId),
        asleep: (workspaceId) => registry?.workspace(workspaceId)?.asleep === true,
        // Genie 1's background processes, imported ONCE as the book opens (core/v1-processes.ts) — before the restore.
        v1: { database: v1DatabaseFile(), workspaces: () => registry?.listWorkspaces() ?? [] },
    });
    const restoredProcesses = processBook.restore();
    if (restoredProcesses.heldBack.length > 0) console.log(`[genie] ${restoredProcesses.heldBack.length} kept background process(es) held back: their workspace is hibernated`);
    // UPDATE CHANNEL (the owner, 2026-10-12: "stable and dev update channels"): the setting decides what the
    // updater may see — read once here, then followed on every change. `channelFrom` reads a legacy `beta` as dev.
    updates?.setChannel(channelFrom(composed.settings.snapshot().update_channel));
    composed.settings.onChange((key, value) => { if (key === 'update_channel') updates?.setChannel(channelFrom(value)); });
    // GENIE'S OWN MCP SERVER (§6.9): every tool registered, the loopback listening, the boot probe recorded.
    {
        // A Take Over terminal, or an agent SESSION by its caller key (`mcp-callers.ts`); anything else is nobody.
        const resolveCaller = (terminalId: string) => takeOvers?.callerFor(terminalId) ?? sessionCaller(terminalId);
        const roster = () => (registry!.snapshot().workspaces ?? []).flatMap((w) => registry!.agentsOf(w.id));
        // ONE builder for the tools' wiring (genie-tool-deps.ts) — doctor mode builds its agent's tools with it too.
        const registrations = allGenieTools(genieToolDeps({
            // agentinbox list: whether each peer is running, read-only — never started by asking (core/liveness.ts).
            liveness: (id) => livenessOf(host?.probe(id as AgentId) ?? null, host?.rowsFor(id as AgentId).at(-1)?.at ?? null),
            inbox: composed.inbox,
            attention: composed.attention,
            knowledge: composed.knowledge,
            settings: composed.settings,
            approve: (caller, action, detail) => composed.approvals.gate(caller, action, detail),
            roster,
            resolveCaller,
            // createAgent: the workspace's default agent asks, the person approves in the Deck, the registry registers.
            agents: {
                defaultAgentOf: (workspaceId) => registry?.defaultAgentOf(workspaceId) ?? null,
                register: (input) => registry!.register(input),
            },
            userActive: () => powerMonitor.getSystemIdleTime() < 120,
            glow: (terminalId) => { broadcast('genie:glow', terminalId); return true; },
            // A sound row of its own (Tynn #766 C2a): the window plays genie:action by its kind.
            thumbsUp: (caller, reason) => { broadcast('genie:action', { agentId: caller.agentId, kind: 'thumbsup', reason }); },
            issueWatch: { forWorkspace: (workspaceId) => issueWatchSummaryFor(workspaceId), refresh: (workspaceId) => issueWatchRefreshFor(workspaceId), recheckSignIn: () => { void tynnAccount?.recheck(); } },
            // In GENIE (genie#922): that workspace's file panel on the file, and Genie brought forward — never the OS's default app.
            openFile: async ({ workspaceId, path, line }) => { revealMainWindow(); broadcast('genie:navigate', openFileRoute(workspaceId, path, line)); return { ok: true }; },
            // The `plan` tool: into the caller's own session, so its Active Plan column shows it.
            reportPlan: (agentId, steps) => host?.reportPlan(agentId as AgentId, steps) ?? false,
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
            // `sites open` shows the site in the same browser pane the Hosting row's Open does.
            openInBrowser,
            // The agents' `processes` tool acts on the Processes tab's own book, and reads the supervisor's kept logs.
            ...(processBook ? { processes: { book: processBook, logs: (id: string, lines?: number) => composed.supervisor.readLog(id, lines) } } : {}),
            // `services exec`: a one-off command with the workspace's service variables (main/service-exec.ts).
            serviceExec: runServiceExec,
            plugins: {
                tools: () => composed.plugins.tools(),
                guard: (id) => composed.plugins.guard(id),
                run: (input) => runPluginTool({
                    pluginDir: input.dir,
                    tool: input.tool,
                    args: input.args,
                    caller: { agentName: input.caller.agentName, workspaceId: input.caller.workspaceId, workspacePath: input.caller.workspacePath },
                    guard: input.guard,
                    // The genie API a plugin may ask for, by name: knowledge search only, for now; everything else is not offered.
                    api: async (method, params) => {
                        if (method === 'knowledge.search') return composed.knowledge.search({ ...(typeof params === 'object' && params !== null ? params : {}) } as never);
                        throw new Error(`${method} is not offered to plugins`);
                    },
                    launch: launchSubprocess,
                    timeoutMs: 30_000,
                    label: `${input.manifest.id}.${input.tool.name}`,
                }),
            },
        }));
        // The endpoint is REMEMBERED across launches (a private file in Genie's home), so the URL and token config sync
        // wrote into workspaces stay valid after a restart.
        mcpToolList = registrations.map((r) => ({ name: r.definition.name, description: r.definition.description ?? '' }));
        const endpointFile = join(genieHome(), 'mcp-endpoint.json');
        mcp = genieMcpServer({
            registrations,
            remember: {
                read: () => {
                    try {
                        const v = JSON.parse(readFileSync(endpointFile, 'utf8')) as { port?: unknown; token?: unknown };
                        return typeof v.port === 'number' && typeof v.token === 'string' && v.token.length >= 32 ? { port: v.port, token: v.token } : null;
                    } catch { return null; }
                },
                write: (value) => { try { writeFileSync(endpointFile, JSON.stringify(value), { mode: 0o600 }); } catch (error) { console.error('[mcp] could not remember the endpoint:', (error as Error).message); } },
            },
        });
        try {
            await mcp.start();
            mcpVerified = await mcp.verify();
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
        } catch (error) {
            mcpVerified = { ok: false, reason: error instanceof Error ? error.message : String(error) };
            console.error('[mcp] the loopback server did not start:', mcpVerified.reason);
        }
        pushFeatures();
    }
    // RESTORE AFTER A RELAUNCH OR UPGRADE (§7.6): only with the ONE setting on; starts spaced three seconds apart; what the
    // user stopped was not running at quit, so it is not in the list. Taken once, so a crash mid-restore starts nobody twice.
    // The agents a shutdown cut off mid-turn are resumed WHATEVER the setting (Genie cancelled their turn, not you) and
    // told to continue; the rest only with the setting on, unprompted.
    void Promise.all([registry.takeRunningAtQuit(), registry.takeInterruptedAtQuit()]).then(([running, interrupted]) => {
        // NO AGENT DRIVEN BY TWO PROCESSES (Tynn #796): a provider a previous Genie left running on an agent's session
        // (its quit cut short by an installer, a crash) ends BEFORE any agent here is started or resumed.
        sweepLeftoverProviders((registry?.listAgents() ?? []).map((a) => ({ name: a.name, threadId: a.threadId })));
        const plan = relaunchPlan({ runningAtQuit: running, interruptedAtQuit: interrupted });
        for (const { agentId, at, resume } of plan) {
            setTimeout(() => {
                const record = registry?.find(agentId as AgentId);
                if (!record || !host) return;
                host.start(record, cwdFor(record));
                if (resume) host.prompt(record.id, RESUME_AFTER_RESTART, 'genie');
            }, at);
        }
    });
    // Listening (or the reason not) reaches Settings → Workstation as soon as it is known.
    // OFF BY DEFAULT (Tynn #820; the owner, 2026-10-19): the listener runs only while `remote_access` is on — applied now and
    // whenever the setting changes (feature-ipc's settings.set). Listening, or why not, reaches Settings as soon as known.
    remoteAccessNow = remoteAccess({ listener: remoteSocket, enabled: () => composed.settings.get('remote_access') === true, onChange: () => { relayAfterSwitch?.(); pushFeatures(); } });
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
    // MAIL WAKES THE AGENT: the open-agent path — an asleep workspace or the agent cap refuses, and the notice waits.
    // One path for every source that may wake an agent: mail, and IssueWatch's `push`.
    const wakeAgent = (agentId: string): boolean => {
        const record = registry?.find(agentId as AgentId);
        if (!record || !host) return false;
        const refused = startRefusal(workspaceOps, record, {
            running: registry!.agentsOf(record.workspaceId).filter((a) => host!.probe(a.id)?.running === true).length,
            cap: agentCapFrom(composed.settings.snapshotFor(record.workspaceId) ?? {}),
        });
        if (refused) { console.log(`[genie] a notice for ${record.name} waits: ${refused}`); return false; }
        return host.start(record, cwdFor(record)).ok;
    };
    // §6.4 THE INBOX PUSH (main/inbox-push.ts): Genie itself puts the notice into the agent's session, for every provider.
    wireInboxPush({
        inbox: composed.inbox, host, reminders: (input) => composed.inboxReminders(input), settled: (agentId, delivered) => composed.inboxNoticeSettled(agentId, delivered),
        wake: wakeAgent,
    });
    // ISSUEWATCH (Tynn #806): Tynn polls GitHub and pushes each project's entry on the person's own channel; the client
    // listens with the Tynn token Genie already holds, and what changed reaches the agents of the linked workspace through
    // the SAME delivery as mail — Genie's turn, told only when it ends — each agent by its own setting and in its mode.
    const issueWatchDelivery = new IssueWatchDelivery({
        agents: () => registry?.listAgents() ?? [],
        defaultAgentOf: (workspaceId) => registry?.defaultAgentOf(workspaceId) ?? null,
        workspaceFor: (projectId) => {
            for (const w of registry?.snapshot().workspaces ?? []) {
                let manifest: string | null = null;
                try { manifest = readFileSync(join(w.path, 'project.json'), 'utf8'); } catch { manifest = null; }
                if (tynnProjectIdOf(manifest) === projectId) return { id: w.id, name: workspaceNameFor(w.path) };
            }
            return null;
        },
    });
    wireInboxPush({
        inbox: { onSend: (listener) => issueWatchDelivery.onQueued(listener) },
        host,
        reminders: (input) => issueWatchDelivery.due(input),
        settled: (agentId, delivered) => issueWatchDelivery.settled(agentId, delivered),
        // `push` wakes a stopped agent as mail does; `next-turn` waits for it to be running.
        wake: (agentId) => issueWatchDelivery.wakes(agentId) && wakeAgent(agentId),
    });
    const issueWatchClient = new IssueWatchClient({
        // The signed-in Tynn SESSION (main/tynn-account.ts), on Genie 1's routes: the person's id and session-bound requests.
        tynn: () => {
            const account = tynnAccount;
            const userId = tynnAccount?.userId() ?? null;
            if (!account || userId === null) return null;
            return { userId, request: (path, init) => account.request(path, init) };
        },
        socket: (url) => new WebSocket(url) as unknown as SocketLike,
        schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
        onEvents: (projectId, events) => {
            issueWatchRecent.set(projectId, [...[...events].reverse(), ...(issueWatchRecent.get(projectId) ?? [])].slice(0, PANEL_RECENT));
            issueWatchDelivery.onEvents(projectId, events);
            // The person's GitHub sound rows (core/alerts.ts): one per kind per batch, played by the window like any action.
            for (const kind of issueWatchSoundKinds(events)) broadcast('genie:action', { agentId: null, kind });
            pushFeatures();
        },
        onEntry: (entry) => { issueWatchLatest.set(entry.projectId, entry); pushFeatures(); },
        onState: (state) => {
            issueWatchState = state.kind;
            pushFeatures();
            console.log(`[genie] issuewatch: ${state.kind}${'reason' in state && state.reason ? ` — ${state.reason}` : ''}`);
        },
    });
    issueWatchRunning = issueWatchClient;
    issueWatchClient.start();
    // Signing in or out of Tynn, or pointing at another one, starts it over with what is set now.
    const restartIssueWatch = () => { issueWatchClient.stop(); issueWatchClient.start(); };
    tynnAccount.onChange(restartIssueWatch);
    // The human's conversation is in the features snapshot (an observed agent's chat): new mail and read receipts
    // push it, so a reply or a "read 14:07" lands without anyone polling.
    composed.inbox.onSend(() => { pushFeatures(); });
    composed.inbox.onRead(() => { pushFeatures(); });
    // Agent-to-agent mail changes the Dashboard's comms cells: rebuild the snapshot on every send.
    composed.inbox.onSend(() => { registry?.touch(); });
    // One agent writing to another is the sender's action, with its own sound row (Tynn #766 C2a).
    composed.inbox.onSend((_to, message) => { const action = mailAction(message); if (action) broadcast('genie:action', action); });
    // ...and the recipient's chat, whose system rows show it (the sender's own turn pushes the sender's).
    composed.inbox.onSend((to) => { if (to !== 'human') pushAgent(to as AgentId); });
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
    });
    const phpVersionsPorts = (): PhpVersionsPorts => ({
        ...phpVersionsBase(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        // The VC++ runtime through T1's own consented install (winget); the click on Install PHP is the consent.
        ensureVcRuntime: async () => {
            const r = await installTool('vcredist', true, toolchainOps());
            return r.kind === 'installed' || r.kind === 'already-installed' ? { ok: true } : { ok: false, reason: r.reason };
        },
        progress: (step) => { featureState = { ...featureState, toolchainBusy: step }; pushFeatures(); },
    });
    const featurePorts: FeaturePorts = {
        ...processPorts(),
        openInBrowser,
        // An approval's note reaches the agent (beta.33 item 16): now, or when its turn ends.
        deliverToAgent: (agentId, text) => host?.deliver(agentId as AgentId, text, 'you') ?? false,
        // The Deck's Dismiss on a recorded main-process error.
        mainErrors,
        toolchain: {
            probe: () => probeToolsLive(latestFor),
            update: async (tool) => runUpdate(tool, { platform: process.platform as Platform, packageManager: await packageManager() }, longRunner, null),
            now: Date.now,
            // THE UPDATE GUARD's input, read at the moment of the click: running sessions with their provider, Genie-run
            // processes with their command, running service engines by name.
            activity: async () => ({
                sessions: (registry?.listAgents() ?? []).filter((a) => host?.probe(a.id as AgentId)?.running === true).map((a) => ({ label: a.name, provider: a.provider })),
                processes: composed.supervisor.list().filter((p) => p.state === 'running' || p.state === 'restarting').map((p) => ({ label: p.name, command: composed.supervisor.command(p.id) ?? '' })),
                engines: (await composed.engineStatuses()).filter((e) => e.status === 'running').map((e) => e.instance.containerName ?? `${e.instance.engine} ${e.instance.version}`),
            }),
            install: (tool, consent) => installTool(tool, consent, toolchainOps()),
            preview: async (tool) => {
                const plan = planInstall({ tool, platform: process.platform as Platform, packageManager: await packageManager() });
                return 'refused' in plan ? { refused: plan.refused } : { label: plan.label, elevated: plan.elevated };
            },
            repair: () => checkAndRepair(toolchainOps()),
            // T4: managed PHP versions (main/php-versions.ts) — the installer's progress is the same pushed busy line.
            php: {
                list: (pins) => listPhpVersions(phpVersionsPorts(), pins),
                install: (version, consent) => installPhpVersion(version, consent, phpVersionsPorts()),
                remove: (version, pins) => removePhpVersion(version, pins, phpVersionsBase()),
            },
        },
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
    ipcMain.handle(FEATURE_CHANNELS.snapshot, () => featureSnapshot(composed, featureState, processPorts()));
    // An alert's own sound file, by setting key (feature-ipc customSoundData): never a path from the renderer.
    ipcMain.handle(FEATURE_CHANNELS.soundData, (_event, key: unknown) => (typeof key === 'string' ? customSoundData(composed.settings, key) : null));
    ipcMain.handle(FEATURE_CHANNELS.act, async (_event, raw: unknown) => {
        const action = raw as FeatureAction;
        const data = await handleFeatureAction(composed, action, featureState, featurePorts);
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
        featureState = { ...featureState, siteAdding: data.hosting?.adding ?? null, siteEditing: data.hosting?.editing ?? null, flowAdding: data.flows?.adding ?? null, serviceAdding: data.services?.adding ?? null, serviceLogs: data.services?.logs ?? null };
        return data;
    });

    // PUSH, both ways. The registry says when the estate changed; the host says when one
    // agent did. Nothing here is on a timer.
    registry.subscribe((snapshot) => {
        if (window && !window.isDestroyed()) window.webContents.send('genie:changed', snapshot);
    });
    let published = '';
    /*
     * A ledger row can change a Dashboard cell — a plan step, a context figure — so the estate-wide snapshot is refreshed
     * too: at most every AGENT_PUSH_INTERVAL_MS, the first at once (core/coalesce.ts). Per event it read every agent's
     * session and pushed the whole estate to the window many times a second for one busy agent (the owner, 2026-10-20).
     */
    const estate = new Coalescer<'estate'>({ intervalMs: AGENT_PUSH_INTERVAL_MS, flush: () => registry?.touch(), schedule: realSchedule, now: () => Date.now() });
    host.subscribe((agentId) => {
        refreshTray();
        pushAgent(agentId);
        // Which agents are started, for doctor mode — rewritten only when that set changes.
        const started = host?.startedIds().sort() ?? [];
        if (started.join(',') !== published) { published = started.join(','); markGenieRunning(genieHome(), started); }
        // A model or tool setting waiting for this agent to be free applies the moment it is.
        settingApplier?.changed(agentId);
        estate.request('estate');
    });
    // A saved setting changes the agent's RECORD, not its session: the Agent view reads it from the detail.
    registry.subscribeAgentRecords(pushAgent);

    // TRAY-RESIDENT (core/tray-resident.ts): start minimised keeps the window in the tray at boot; closing it hides it
    // (Windows, Linux) and Genie keeps running — the agents, the terminals, the services. A quit is asked for.
    window = createWindow(showOnBoot({ startMinimized: composed.settings.snapshot().start_minimized === true, argv: process.argv }));
    wireCloseToTray(window, {
        platform: process.platform,
        quitting: () => quit.quitting,
        settings: composed.settings,
        notify: (notice) => {
            if (!Notification.isSupported()) return;
            const n = new Notification({ title: notice.title, body: notice.body });
            n.on('click', revealMainWindow);
            n.show();
        },
    });
    // Windows ends a session (shutdown, restart, sign-out) WITHOUT a before-quit (Electron documents it): quit on the
    // way out so the shutdown runs, without a question nothing could answer.
    window.on('session-end', () => { quit.force(); app.quit(); });
    // LAUNCH AT SIGN-IN: adopt Genie 1's entry, apply at boot, follow every change.
    void wireLoginItem(composed.settings, loginItemPort, {
        platform: process.platform,
        packaged: app.isPackaged,
        execPath: process.execPath,
        appImage: process.env.APPIMAGE ?? null,
        configHome: process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0 ? process.env.XDG_CONFIG_HOME : join(homedir(), '.config'),
    });
    trayHandlers = {
        onUpdate: revealMainWindow,
        onTaskManager: () => { revealMainWindow(); broadcast('genie:navigate', 'genie://hosting?tab=processes'); },
        // New scratch terminal (Tynn #761; the owner, 2026-10-19: in Genie's own workspace): home folder, its own window.
        // A signed-out login named in the tray (#967): its own login, in a window of its own.
        onProviderLogin: (provider) => {
            const r = loginHost?.start(provider);
            if (r && !r.ok) console.error('[genie] provider login:', r.reason);
        },
        onScratchTerminal: () => {
            if (!terminals) return;
            const r = openScratchTerminal({ terminals, openWindow: (route) => openTakeOverWindow(route), home: homedir() });
            if (!r.ok) console.error('[genie] scratch terminal:', r.reason);
        },
        onOpen: revealMainWindow,
        onSettings: () => {
            revealMainWindow();
            broadcast('genie:navigate', 'genie://settings');
        },
        onCheckUpdates: () => { void updates?.check(); },
        onQuit: requestQuit,
        onResumeLimit: (provider) => { host?.resumeLimit(provider); refreshTray(); },
        // A paused account named in the tray: Try again brings its agents back.
        onAccountRetry: (provider) => { retryPausedAccount?.(provider); },
    };
    tray = createTray(trayHandlers, trayIconPath());
    // GENIE'S APPLICATION MENU (Tynn #759, main/app-menu.ts): without one Electron's default is in force, and its Ctrl+W
    // closes — on this window, hides — Genie from any field. Settings… on Ctrl+, (⌘, on macOS).
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, app.getVersion(), {
        onSettings: () => {
            revealMainWindow();
            broadcast('genie:navigate', 'genie://settings');
        },
        onCheckUpdates: () => { void updates?.check(); },
        onQuit: requestQuit,
        onCloseWindow: () => { (BrowserWindow.getFocusedWindow() ?? window)?.close(); },
        onOpenRepo: () => { void shell.openExternal('https://github.com/Renaissance-Analytics/genie'); },
        // HELP (Tynn #762): Genie's documentation is the Tynn docs site; What's new opens over the page, again.
        onDocs: () => { void shell.openExternal(genieDocsUrl(tynnHost())); },
        onWhatsNew: () => { revealMainWindow(); broadcast('genie:navigate', WHATS_NEW_ROUTE); },
        onReportIssue: () => { void shell.openExternal(`https://github.com/Renaissance-Analytics/genie/issues/new?title=${encodeURIComponent(`[v${app.getVersion()}] `)}`); },
    })));
    // S7: each .gen site at its own https origin — the pane's session routes *.gen to the in-app front door and trusts
    // Genie's CA for .gen hosts only (electron-browser-view.ts). Without a CA, .gen pages are refused and the reason logged.
    const browserTrust = composed.browserTrust();
    if (browserTrust.caPem === null) console.error(`[genie] browser: .gen sites cannot open in the Genie Browser: ${browserTrust.reason}`);
    browserPane = new BrowserPane(electronBrowserView(window, { frontDoorPort: composed.frontDoorPort, caPem: browserTrust.caPem }), () => composed.routes());
    // What the page did (a link, a redirect, back/forward) is the address bar and the history buttons — pushed, not polled.
    // A hidden pane reports no url; the surface keeps the last page it showed.
    browserPane.onChange((state) => {
        if (state.url === null) return;
        featureState = { ...featureState, browserUrl: state.url, browserCanGoBack: state.canGoBack, browserCanGoForward: state.canGoForward };
        pushFeatures();
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

app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    answerSecondInstance(argv, additionalData, { quit: requestQuit, reveal: revealMainWindow, defer: (run) => { setImmediate(run); }, open: openGenieUrl });
});

/**
 * Every agent session ends with the app, and none is revived on the way out.
 *
 * The NEXT launch starts again exactly the agents that were running at quit (always — there is no
 * setting since 2026-10-20). There is no second branch here that revives anything "because the
 * window went away" — that branch, in a previous build, resurrected eleven agents the owner
 * had deliberately stopped: what the person stopped is not running at quit, so it stays stopped.
 */
/**
 * EVERY SHUTDOWN — a quit or an upgrade — records who was running and, separately, who was MID-TURN, before any session
 * ends. Ending the sessions is what cancels those turns; the next launch resumes exactly those agents and tells them to
 * continue (the owner, 2026-10-13: "ONLY active agents in the middle of turning, not any idle ones … on shutdown of
 * genie, not just an upgrade").
 */
function recordShutdown(): Promise<unknown> {
    if (!registry || !host) return Promise.resolve();
    const live = registry.snapshot().agents.map((a) => ({ id: a.id as AgentId, probe: host!.probe(a.id as AgentId) }));
    const running = live.filter((a) => a.probe?.running === true).map((a) => a.id);
    const midTurn = midTurnAgents(live.map((a) => ({ id: a.id, turnState: a.probe?.turnState ?? null }))) as AgentId[];
    return Promise.all([registry.markRunningAtQuit(running), registry.markInterruptedAtQuit(midTurn)]);
}

let remoteSocketNow: ReturnType<typeof remoteListener> | null = null;
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
            return quitPlan({ runningAgents: running, liveTerminals: terminals?.count ?? 0, detachedTerminals: (services?.settings.snapshot() ?? {}).detached_terminals === true });
        },
        ask: (plan) => dialog.showMessageBoxSync({ type: 'question', title: plan.title, message: plan.message, buttons: [...plan.buttons], defaultId: 0, cancelId: 0 }) !== 0,
    });
    if (step === 'cancel') { event.preventDefault(); return; }
    autoCheckStop?.();
    autoCheckStop = null;
    // §7.6: remember who was running, BEFORE anything is stopped; the write finishes, then the quit resumes.
    if (step === 'record') {
        event.preventDefault();
        // §6.5: the terminals' last screens, saved beside the running set, before the ptys go.
        const shown = (terminals?.list() ?? []).map((t) => ({ workspaceId: t.workspaceId, scrollback: terminals?.scrollback(t.id) ?? '' }));
        void Promise.all([recordShutdown(), snapshots?.save(shown) ?? Promise.resolve()]).catch(() => { /* an unsaved list means no restore, never a blocked quit */ }).finally(() => app.quit());
        return;
    }
    // The shutdown already ran (a second quit request arrived while the running set was being written): nothing twice.
    if (step === 'pass') return;
    host?.stopAll();
    // A nudge waiting out its grace is not sent into a quit (core/plan-keepalive.ts); with the sessions gone it would find none.
    keepaliveNow?.stop();
    // Every supervised process, the front door, an in-flight flow run, the knowledge database.
    void services?.shutdown();
    void remoteSocketNow?.stop();
    void filesHost?.close();
    // §7.1: nothing Genie spawned may outlive it. An upgrade jammed on 31 orphaned
    // OpenConsole.exe processes with no message, because nothing reaped them.
    terminals?.closeAll();
    clearGenieRunning(genieHome());
});

// THE LINUX PASSWORD STORE (Tynn #846; Genie 1's genie#379/#588): Chromium picks its secret store from the desktop's
// name and does not know Hyprland (Omarchy) — so safeStorage could encrypt nothing there. Chosen from what owns the
// session bus, or what a previous launch was seen using; BEFORE app-ready, when OSCrypt reads the switch.
applyLinuxPasswordStore({
    platform: process.platform,
    argv: process.argv,
    probe: () => probeOwnedBusNames(passwordStoreBusNames()),
    remembered: () => readRememberedPasswordStore(genieHome()),
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
powerMonitor.on('resume', () => { if (tynnAccount && !tynnAccount.status().signedIn) void tynnAccount.recheck(); });
powerMonitor.on('shutdown', (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    quit.force();
    app.quit();
});
