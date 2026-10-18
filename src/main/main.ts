import { systemRootsPem } from './php-trust-host.js';
import { runServiceExec } from './service-exec.js';
import { MainErrorBook, installMainErrorPolicy } from '../core/main-errors.js';
import { livenessOf } from '../core/liveness.js';
import { CallerBook, genieMcpServers, sessionCallerOf } from './mcp-callers.js';
import type { Caller } from './mcp-tools.js';
import { sessionCostOf } from '../core/stream-view.js';
import { commsOf } from '../core/comms.js';
import { BrowserWindow, Menu, Notification, Tray, app, dialog, globalShortcut, ipcMain, powerMonitor, safeStorage, shell } from 'electron';
import { guardWindowLinks } from './external-links.js';
import { FEEDBACK_ROUTE, feedbackTargets } from '../core/feedback.js';
import { workspaceLabel } from '../core/workspace-label.js';
import { wireFeedbackHotkey } from './feedback-hotkey.js';
import { WHATS_NEW_ROUTE, genieDocsUrl, whatsNewFor } from '../core/whats-new.js';
import { RELEASE_NOTES } from './release-notes.js';
import { sendFeedback } from './feedback-send.js';
import { appMenuTemplate } from './app-menu.js';
import { realFancyTermPort } from './fancy-term-port.js';
import { TerminalHost } from './terminal-host.js';
import { TakeOverHost } from './take-over-host.js';
import { FilesWindows } from './files-windows.js';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asAgentId, asAgentRef, type AgentId, type AgentRecord } from '../core/identity.js';
import type { AgentDetail } from '../renderer/bridge.js';
import { OS_WORKSPACE, Registry } from './registry.js';
import { readFile, rm } from 'node:fs/promises';
import { deleteAgent, diagnose, previewDelete, restartAgent, setAccessScope, setAutoApprove, setBudget, setIssueWatch, setMode, setModel, setPermissions, SettingApplier, switchDriver, type AgentOpsPorts } from './agent-ops-host.js';
import { issueWatchPrefsFor } from '../core/issue-watch.js';
import { mailAction } from '../core/agent-actions.js';
import { ThingSounds, flowRunSound } from '../core/thing-sounds.js';
import { agentShells } from '../core/agent-shells.js';
import { quitPlan, quitSequence } from '../core/quit.js';
import { QUIT_DATA, answerSecondInstance, asksToQuit, launchDecision } from '../core/quit-flag.js';
import { attachmentsFromRenderer } from '../core/prompt-content.js';
import { buildHostApi } from './host-api.js';
import { addWorkspace as addWorkspaceOp, addWorkspaceFromGit, addWorkspaceFromTynn, hibernateWorkspace, previewAddFromGit, previewAddFromTynn, previewAddWorkspace, removeWorkspace, startRefusal, wakeWorkspace, type WorkspaceOpsPorts } from './workspace-ops-host.js';
import { mkdir, readdir, readFile as readFileText, stat as statPath, writeFile as writeFileText } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { restartWithHandoff } from './restart-with-handoff.js';
import { sweepLeftoverProviders } from './leftover-sweep.js';
import { raisesApprovals, SessionHost, providerBinary } from './session-host.js';
import { Store } from './store.js';
import { composeServices, type ComposedServices } from './compose.js';
import { customSoundData, featureSnapshot, handleFeatureAction, toolchainStateFrom, type FeatureState } from './feature-ipc.js';
import { SOUND_FILE_EXTENSIONS } from '../core/custom-sound.js';
import { QuestionWindow } from './question-window.js';
import { electronQuestionWindow } from './question-window-electron.js';
import { readV1Settings } from './v1-settings.js';
import { readV1Catalog, readV1Knowledge } from './v1-import.js';
import { readV1Inbox } from './v1-inbox.js';
import { planV1Import } from '../core/v1-import.js';
import { v1Leftovers } from '../core/v1-reap.js';
import { workspaceDisplayName } from '../core/workspace-name.js';
import { TITLE_BAR_HEIGHT, mainWindowOptions, overlayColorsOk } from '../core/window.js';
import { createTray, trayMenuTemplate, trayTooltip, trayUpdate, type TrayHandlers } from './tray.js';
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
import { realElectronUpdaterPort } from './electron-updater-port.js';
import { killProcess, listProcesses } from './process-list.js';
import { RESUME_AFTER_RESTART, midTurnAgents, relaunchPlan } from '../core/upgrade-drain.js';
import { FilesHost } from './files-host.js';
import { TerminalSnapshots } from './terminal-snapshots.js';
import { addRepoTo, commitsSinceIn, listReposOf, relocateRepoIn, removeRepoFrom, removeRepoLockOf, type RepoOpsPorts } from './repo-ops-host.js';
import { agentCapFrom } from '../core/inbox.js';
import { fileEventsOf, openFileRoute } from '../core/files-panel.js';
import { remoteListener } from './remote-listen.js';
import { staticServer } from './static-page.js';
import { uploadSender } from './uploads.js';
import { tynnClient } from './tynn-client.js';
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
function refreshTray(): void {
    if (!tray || !trayHandlers) return;
    const held = (host?.heldLogins() ?? []).flatMap((l) => { const words = limitWords(l.view); return words ? [{ provider: l.provider, words }] : []; });
    // An update on offer leads the menu (Tynn #761).
    const update = trayUpdate(updates?.state() ?? null);
    const key = JSON.stringify({ held, update });
    if (key === trayHeldKey) return;
    trayHeldKey = key;
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(trayHandlers, held, update)));
    tray.setToolTip(trayTooltip(held));
}
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
let filesHost: FilesHost | null = null;
let snapshots: TerminalSnapshots | null = null;
let takeOvers: TakeOverHost | null = null;
let filesWindows: FilesWindows | null = null;
let host: SessionHost | null = null;
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
    let prior: { hibernationApplied?: boolean } | null = null;
    if (existsSync(marker)) {
        try { prior = JSON.parse(readFileSync(marker, 'utf8')) as { hibernationApplied?: boolean }; } catch { prior = {}; }
        if (prior?.hibernationApplied === true) return;
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
    for (const id of plan.hibernate) await theRegistry.setAsleep(id, true);
    const result = { at: new Date().toISOString(), sawV1: catalog !== null, workspaces: prior === null ? plan.workspaces.length : 0, agents: prior === null ? plan.agents.length : 0, hibernated: plan.workspaces.filter((w) => w.asleep).length + plan.hibernate.length, hibernationApplied: true, skipped: prior === null ? plan.skipped : [] };
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

function createWindow(show: boolean): BrowserWindow {
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

    void win.loadFile(join(here, '../renderer/index.html'));
    return win;
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
            issueWatch: issueWatchPrefsFor(record, registry?.listAgents() ?? []),
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
        turns: host.turnsFor(record.id),
        // The engine's own recent words, for the process-ended block (the board's error state).
        log: host.recentStderrFor(record.id),
        // The session's running total, from the latest usage report (claude reports it; codex does not). `null` means
        // there is no Cost row — never a `$0.00`, which would claim the work was free.
        cost: sessionCostOf(host.rowsFor(record.id)),
        refusal: host.refusals.get(record.id) ?? null,
        takeOver,
        // Its mail with other agents, for the system rows in its chat (the person's mail is the chat itself).
        comms: services
            ? services.inbox.involving(record.id, 50).filter((m) => m.from !== 'human' && m.to !== 'human').map((m) => ({ id: m.id, from: m.from, to: m.to, text: m.text, sentAt: m.sentAt, readAt: m.readAt }))
            : null,
    };
}

function pushAgent(agentId: AgentId): void {
    if (!window || window.isDestroyed()) return;
    // One channel per agent, so a ledger is never broadcast to a renderer looking elsewhere.
    window.webContents.send(`genie:agent-changed:${agentId}`, detailFor(agentId));
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
    host = new SessionHost({
        userData: genieHome(),
        // Each turn's number is kept on the agent's record, so its next session numbers on at once (no "Turn 1").
        onTurnEnded: (agentId, turns) => { void registry?.setLastTurn(agentId, turns); },
        // What an agent did (Tynn #766 C): pushed to every window, which plays the sound chosen for it.
        onAction: (agentId, kind) => broadcast('genie:action', { agentId, kind }),
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
        files: osaHomeFiles('normal', { version: app.getVersion(), platform: process.platform, installDir: installDir(process.execPath), genieHome: genieHome(), userData: app.getPath('userData') }),
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

    ipcMain.handle('genie:answer-approval', (_event, raw: unknown, optionId: unknown) => {
        const record = agentFromRenderer(raw);
        if (!record || !host || typeof optionId !== 'string') return { ok: false };
        // The session checks the id against the parked request. A refusal leaves the approval
        // parked, which is recoverable; answering with something meaningless is not.
        return { ok: host.answerApproval(record.id, optionId) };
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
    ipcMain.handle('genie:files-open', (_event, workspaceId: unknown, path: unknown) =>
        typeof workspaceId === 'string' && typeof path === 'string' ? filesHost?.open(workspaceId, path) ?? { ok: false, path, error: 'no files host' } : { ok: false, path: String(path), error: 'bad arguments' });
    ipcMain.handle('genie:files-state', (_event, workspaceId: unknown) => (typeof workspaceId === 'string' ? filesHost?.state(workspaceId) ?? null : null));
    ipcMain.handle('genie:files-watch', (_event, workspaceId: unknown) => (typeof workspaceId === 'string' ? filesHost?.watch(workspaceId) : undefined));
    ipcMain.handle('genie:files-popout', (_event, workspaceId: unknown) => { if (typeof workspaceId === 'string') filesWindows?.popOut(workspaceId); });
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
            gitClone,
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
            get host() { const h = services?.settings.snapshot().tynn_host; return typeof h === 'string' && h.trim().length > 0 ? h.trim() : 'https://tynn.ai'; },
            project() {
                const token = services?.settings.snapshot().tynn_token;
                return tynnClient((url, init) => fetch(url, init)).project(this.host, typeof token === 'string' ? token : '');
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
    ipcMain.handle('genie:workspace-repo-locate', async (_event, raw: unknown, slug: unknown) => {
        if (typeof raw !== 'string' || typeof slug !== 'string') return { ok: false, reason: 'name a workspace and a repo' };
        if (!window) return { ok: false, reason: 'no window to ask in' };
        const picked = await dialog.showOpenDialog(window, { title: `Where is ${slug} now? Pick its folder inside the envelope`, properties: ['openDirectory'] });
        const path = picked.filePaths[0];
        if (picked.canceled || !path) return { ok: false, reason: 'no folder picked' };
        return relocateRepoIn(repoOps, raw, slug, path);
    });
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
    ipcMain.handle('genie:workspace-preview-add', async () => {
        if (!window) return { ok: false, reason: 'no window to pick a folder from' };
        const picked = await dialog.showOpenDialog(window, { title: 'Add a workspace', properties: ['openDirectory'] });
        const path = picked.filePaths[0];
        if (picked.canceled || !path) return { ok: false, reason: 'no folder picked' };
        return previewAddWorkspace(workspaceOps, path);
    });
    // ADD FROM A GIT URL (§6.1): the parent folder is picked on the host; the plan is shown before the clone.
    ipcMain.handle('genie:workspace-preview-add-git', async (_event, rawUrl: unknown) => {
        if (typeof rawUrl !== 'string' || !window) return { ok: false, reason: 'give a git URL' };
        const picked = await dialog.showOpenDialog(window, { title: 'Where should the clone land? Pick the parent folder', properties: ['openDirectory'] });
        const parent = picked.filePaths[0];
        if (picked.canceled || !parent) return { ok: false, reason: 'no folder picked' };
        const plan = await previewAddFromGit(workspaceOps, rawUrl, parent);
        return plan.ok ? { ...plan, parent } : plan;
    });
    ipcMain.handle('genie:workspace-confirm-add-git', (_event, rawUrl: unknown, rawParent: unknown) =>
        (typeof rawUrl === 'string' && typeof rawParent === 'string' ? addWorkspaceFromGit(workspaceOps, rawUrl, rawParent) : { ok: false, reason: 'give a git URL and a parent folder' }));
    // ADD FROM TYNN (§6.1): the parent folder is picked on the host; Tynn is asked for the project; the plan is shown before anything is written.
    ipcMain.handle('genie:workspace-preview-add-tynn', async () => {
        if (!window) return { ok: false, reason: 'no window' };
        const picked = await dialog.showOpenDialog(window, { title: 'Where should the Tynn envelope be created? Pick the parent folder', properties: ['openDirectory'] });
        const parent = picked.filePaths[0];
        if (picked.canceled || !parent) return { ok: false, reason: 'no folder picked' };
        return previewAddFromTynn(workspaceOps, parent);
    });
    ipcMain.handle('genie:workspace-confirm-add-tynn', (_event, rawParent: unknown) =>
        (typeof rawParent === 'string' ? addWorkspaceFromTynn(workspaceOps, rawParent) : { ok: false, reason: 'give a parent folder' }));
    ipcMain.handle('genie:workspace-confirm-add', (_event, raw: unknown) => (typeof raw === 'string' ? addWorkspaceOp(workspaceOps, raw) : { ok: false, reason: 'confirmAdd names a folder' }));
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
    // THE FEEDBACK WINDOW (Tynn #760): it can go to the workspaces linked to a Tynn project; it goes by Genie's own token.
    const tynnHost = (): string => {
        const host = composed.settings.get('tynn_host');
        return typeof host === 'string' && host.trim().length > 0 ? host.trim() : 'https://tynn.ai';
    };
    const tynnCredentials = (): { host: string; token: string } | null => {
        const values = composed.settings.snapshot();
        const token = typeof values.tynn_token === 'string' ? values.tynn_token.trim() : '';
        return token.length > 0 ? { host: tynnHost(), token } : null;
    };
    const feedbackPort: NonNullable<FeaturePorts['feedback']> = {
        targets: (current) => {
            const workspaces = registry?.snapshot().workspaces ?? [];
            return feedbackTargets(workspaces.map((w) => ({ id: w.id, name: workspaceLabel(workspaces, w.id) })), tynnProjectFor, current);
        },
        signedIn: () => tynnCredentials() !== null,
        send: (request) => sendFeedback({ credentials: tynnCredentials, fetch: (url, init) => fetch(url, init) }, { ...request, meta: { ...request.meta, genie_version: app.getVersion() } }),
    };
    const processPorts = (): FeaturePorts => ({ ...(processBook ? { processes: processBook } : {}), issueWatch: () => issueWatchPanels(), feedback: feedbackPort, whatsNew: (shown) => whatsNewFor(app.getVersion(), String(composed.settings.get('whats_new_seen_version') ?? ''), RELEASE_NOTES, shown), appVersion: () => app.getVersion() });
    // THE HOST'S SOCKET (§6.8): fancy-ws on the Tailscale IPv4 only; with no Tailscale nothing listens and Settings says why.
    const remoteSocket = remoteListener({
        tailscale: () => new Promise<string>((resolve, reject) => { execFileCb('tailscale', ['status', '--json'], { windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))); }),
        port: REMOTE_PORT,
        attach: attachWebSocketServer,
        // The phone's page (§6.8): the built renderer, from the same directory the window loads it from.
        serve: staticServer(join(here, '../renderer')),
    });
    remoteSocketNow = remoteSocket;
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
        remoteTransport: remoteSocket.transport,
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
                answerApproval: (id, optionId) => host!.answerApproval(id, optionId),
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
                confirmAdd: (path) => addWorkspaceOp(workspaceOps, path),
                confirmAddFromGit: (url, parent) => addWorkspaceFromGit(workspaceOps, url, parent),
                confirmAddFromTynn: (parent) => addWorkspaceFromTynn(workspaceOps, parent),
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
            feedback: composed.feedback,
            approve: (caller, action, detail) => composed.approvals.gate(caller, action, detail),
            roster,
            resolveCaller,
            userActive: () => powerMonitor.getSystemIdleTime() < 120,
            glow: (terminalId) => { broadcast('genie:glow', terminalId); return true; },
            // A sound row of its own (Tynn #766 C2a): the window plays genie:action by its kind.
            thumbsUp: (caller, reason) => { broadcast('genie:action', { agentId: caller.agentId, kind: 'thumbsup', reason }); },
            issueWatch: { forWorkspace: (workspaceId) => issueWatchSummaryFor(workspaceId), refresh: (workspaceId) => issueWatchRefreshFor(workspaceId) },
            // In GENIE (genie#922): that workspace's file panel on the file, and Genie brought forward — never the OS's default app.
            openFile: async ({ workspaceId, path, line }) => { revealMainWindow(); broadcast('genie:navigate', openFileRoute(workspaceId, path, line)); return { ok: true }; },
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
            sidecar: {
                register: (input) => registry!.register(input),
                start: (record, cwd) => host!.start(record, cwd),
                running: (agentId) => host!.probe(agentId as AgentId)?.running === true,
            },
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
        const plan = relaunchPlan({ runningAtQuit: running, interruptedAtQuit: interrupted, restoreAll: composed.settings.snapshot().restore_agents_on_launch === true });
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
    void remoteSocket.start().then(pushFeatures, pushFeatures);
    // The Deck's signal strip, MEASURED (§4.5): flows in flight, mail agents have not collected, GitHub blocking, the OS agent working.
    registry.setSignals(() => composed.signals({ osAgentWorking: (() => { const os = registry?.osAgent(); return os ? host?.probe(os.id)?.turnState === 'working' : false; })() }));
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
        credentials: () => {
            const values = composed.settings.snapshot();
            const token = typeof values.tynn_token === 'string' ? values.tynn_token.trim() : '';
            const tynnHost = typeof values.tynn_host === 'string' && values.tynn_host.trim().length > 0 ? values.tynn_host.trim() : 'https://tynn.ai';
            return token.length > 0 ? { host: tynnHost, token } : null;
        },
        fetch: (url, init) => fetch(url, init),
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
    composed.settings.onChange((key) => { if (key === 'tynn_token' || key === 'tynn_host') { issueWatchClient.stop(); issueWatchClient.start(); } });
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
        // The Deck's Dismiss on a recorded main-process error.
        mainErrors,
        // An alert's own sound (Tynn #766 B2): the host's picker, sound files only.
        pickSound: async () => {
            if (!window || window.isDestroyed()) return null;
            const picked = await dialog.showOpenDialog(window, { title: 'Choose a sound', properties: ['openFile'], filters: [{ name: 'Sounds', extensions: [...SOUND_FILE_EXTENSIONS] }] });
            return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]!;
        },
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
        open: electronQuestionWindow({ here, preload: join(here, 'question-preload.cjs'), controller: () => questionWindow }),
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
    // §6.4 attachments: the host's own picker; what it answers is all a send may attach.
    ipcMain.handle(FEATURE_CHANNELS.pickFiles, async () => {
        if (!window || window.isDestroyed()) return [];
        const picked = await dialog.showOpenDialog(window, { title: 'Attach files', properties: ['openFile', 'multiSelections'] });
        return picked.canceled ? [] : picked.filePaths;
    });
    ipcMain.handle(FEATURE_CHANNELS.snapshot, () => featureSnapshot(composed, featureState, processPorts()));
    // An alert's own sound file, by setting key (feature-ipc customSoundData): never a path from the renderer.
    ipcMain.handle(FEATURE_CHANNELS.soundData, (_event, key: unknown) => (typeof key === 'string' ? customSoundData(composed.settings, key) : null));
    ipcMain.handle(FEATURE_CHANNELS.act, async (_event, raw: unknown) => {
        const action = raw as FeatureAction;
        const data = await handleFeatureAction(composed, action, featureState, featurePorts);
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
    host.subscribe((agentId) => {
        refreshTray();
        pushAgent(agentId);
        // Which agents are started, for doctor mode — rewritten only when that set changes.
        const started = host?.startedIds().sort() ?? [];
        if (started.join(',') !== published) { published = started.join(','); markGenieRunning(genieHome(), started); }
        // A model or tool setting waiting for this agent to be free applies the moment it is.
        settingApplier?.changed(agentId);
        // A ledger row can change a Dashboard cell — a plan step, a context figure — so the
        // estate-wide snapshot is refreshed too. It carries no ledgers, so this is cheap.
        registry?.touch();
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
    // The Feedback window (Tynn #760), over whatever page is showing: from the tray, and from the global key below.
    const openFeedback = (): void => { revealMainWindow(); broadcast('genie:navigate', FEEDBACK_ROUTE); };
    trayHandlers = {
        onFeedback: openFeedback,
        onUpdate: revealMainWindow,
        onTaskManager: () => { revealMainWindow(); broadcast('genie:navigate', 'genie://hosting?tab=processes'); },
        onOpen: revealMainWindow,
        onSettings: () => {
            revealMainWindow();
            broadcast('genie:navigate', 'genie://settings');
        },
        onCheckUpdates: () => { void updates?.check(); },
        onQuit: requestQuit,
        onResumeLimit: (provider) => { host?.resumeLimit(provider); refreshTray(); },
    };
    tray = createTray(trayHandlers, trayIconPath());
    // THE FEEDBACK KEY (Tynn #760; Genie 1's global hotkey): from anywhere on the computer. The OS may refuse it — another
    // application holds it — and that is logged, never thrown; it is released when Genie quits.
    const feedbackKey = wireFeedbackHotkey({ get: () => composed.settings.get('feedback_hotkey'), onChange: (cb) => composed.settings.onChange(cb) }, { register: (acc, fn) => globalShortcut.register(acc, fn), unregister: (acc) => globalShortcut.unregister(acc) }, openFeedback);
    const feedbackKeyStatus = feedbackKey();
    if (feedbackKeyStatus.state !== 'registered') console.log(`[genie] the Feedback key ${feedbackKeyStatus.accelerator} is ${feedbackKeyStatus.state === 'taken' ? 'held by another application' : 'not a key Genie can read'}`);
    app.on('will-quit', () => { globalShortcut.unregisterAll(); });
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
app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    answerSecondInstance(argv, additionalData, { quit: requestQuit, reveal: revealMainWindow, defer: (run) => { setImmediate(run); } });
});

/**
 * Every agent session ends with the app, and none is revived on the way out.
 *
 * `restore_agents_on_launch` defaults off and is the ONE setting that governs every path that
 * could restart an agent. There is no second branch here that revives anything "because the
 * window went away" — that branch, in the previous build, resurrected eleven agents the owner
 * had deliberately stopped.
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
    // Every supervised process, the front door, an in-flight flow run, the knowledge database.
    void services?.shutdown();
    void remoteSocketNow?.stop();
    void filesHost?.close();
    // §7.1: nothing Genie spawned may outlive it. An upgrade jammed on 31 orphaned
    // OpenConsole.exe processes with no message, because nothing reaped them.
    terminals?.closeAll();
    clearGenieRunning(genieHome());
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
powerMonitor.on('shutdown', (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    quit.force();
    app.quit();
});
