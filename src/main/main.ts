import { CallerBook, genieMcpServers } from './mcp-callers.js';
import { sessionCostOf } from '../core/stream-view.js';
import { commsOf } from '../core/comms.js';
import { BrowserWindow, Tray, app, dialog, ipcMain, powerMonitor, safeStorage, shell } from 'electron';
import { realFancyTermPort } from './fancy-term-port.js';
import { TerminalHost } from './terminal-host.js';
import { TakeOverHost } from './take-over-host.js';
import { FilesWindows } from './files-windows.js';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asAgentId, asAgentRef, type AgentId, type AgentRecord } from '../core/identity.js';
import type { AgentDetail } from '../renderer/bridge.js';
import { OS_WORKSPACE, Registry } from './registry.js';
import { readFile, rm } from 'node:fs/promises';
import { deleteAgent, diagnose, previewDelete, restartAgent, setAccessScope, setBudget, setMode, switchDriver, type AgentOpsPorts } from './agent-ops-host.js';
import { quitPlan } from '../core/quit.js';
import { buildHostApi } from './host-api.js';
import { addWorkspace as addWorkspaceOp, addWorkspaceFromGit, addWorkspaceFromTynn, hibernateWorkspace, previewAddFromGit, previewAddFromTynn, previewAddWorkspace, removeWorkspace, startRefusal, wakeWorkspace, type WorkspaceOpsPorts } from './workspace-ops-host.js';
import { mkdir, readdir, readFile as readFileText, stat as statPath, writeFile as writeFileText } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { restartWithHandoff } from './restart-with-handoff.js';
import { raisesApprovals, SessionHost, providerBinary } from './session-host.js';
import { Store } from './store.js';
import { composeServices, type ComposedServices } from './compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from './feature-ipc.js';
import { readV1Settings } from './v1-settings.js';
import { readV1Catalog } from './v1-import.js';
import { planV1Import } from '../core/v1-import.js';
import { v1Leftovers } from '../core/v1-reap.js';
import { workspaceDisplayName } from '../core/workspace-name.js';
import { mainWindowOptions } from '../core/window.js';
import { createTray } from './tray.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { caddyBinPath } from './caddy-runtime.js';
import { execFileRunner, probeToolsLive } from './toolchain-runner.js';
import { runUpdate } from './toolchain-prober.js';
import { HOST_TOOLS } from '../core/toolchain.js';
import { latestFromBrewOutdated, latestFromNodeIndex, latestFromNpmOutdated, latestFromWingetUpgrade, phpLatestFromReleases } from '../core/toolchain-indexes.js';
import type { FeaturePorts } from './feature-ipc.js';
import type { FeatureData } from '../renderer/features.js';
import { BrowserPane } from './browser-pane.js';
import { electronBrowserView } from './electron-browser-view.js';
import { FEATURE_CHANNELS } from '../renderer/bridge.js';
import type { FeatureAction } from '../renderer/features.js';
import { UpdateHost } from './updater.js';
import { genieHome } from './paths.js';
import { realElectronUpdaterPort } from './electron-updater-port.js';
import { killProcess, listProcesses } from './process-list.js';
import { restoreSchedule } from '../core/upgrade-drain.js';
import { FilesHost } from './files-host.js';
import { TerminalSnapshots } from './terminal-snapshots.js';
import { addRepoTo, commitsSinceIn, listReposOf, relocateRepoIn, removeRepoFrom, removeRepoLockOf, type RepoOpsPorts } from './repo-ops-host.js';
import { agentCapFrom } from '../core/inbox.js';
import type { FileEvent } from '../core/files-panel.js';
import { remoteListener } from './remote-listen.js';
import { staticServer } from './static-page.js';
import { uploadSender } from './uploads.js';
import { tynnClient } from './tynn-client.js';
import { gitClone, gitFileStatus, gitInit, gitShowHead } from './git-ports.js';
import { genieMcpServer, type GenieMcpServer, type Verification } from './mcp-server.js';
import { allGenieTools } from './mcp-registrations.js';
import { launchSubprocess, runPluginTool } from './plugin-runner.js';
import { addressOf, inboxSettingFrom } from '../core/inbox.js';
import { REMOTE_PORT } from '../core/tailscale.js';
import { attachWebSocketServer } from '@particle-academy/fancy-ws';

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

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * A single instance, with no exception.
 *
 * The previous build short-circuited this lock under an env var so an E2E suite could run
 * beside a live Genie, and the measured result was two instances both opening windows on the
 * owner's desktop while real agents were mid-turn. There is no `GENIE_E2E` escape hatch here:
 * a second instance focuses the first. Verification happens on a VM, where there is no first
 * instance to collide with.
 */
if (!app.requestSingleInstanceLock()) {
    app.quit();
}

let window: BrowserWindow | null = null;
/** The tray outlives every window; held so it is not garbage-collected into nothing. */
let tray: Tray | null = null;
/** The automatic update checks (§7, genie2#91): stopped on quit so no check fires into a closing app. */
let autoCheckStop: (() => void) | null = null;
let registry: Registry | null = null;
let terminals: TerminalHost | null = null;
let filesHost: FilesHost | null = null;
let snapshots: TerminalSnapshots | null = null;
let takeOvers: TakeOverHost | null = null;
let filesWindows: FilesWindows | null = null;
let host: SessionHost | null = null;
let updates: UpdateHost | null = null;
let drainTimer: ReturnType<typeof setInterval> | null = null;
/** Set once the running set has been recorded for §7.6, so quit does not overwrite it with an empty list after the drain stopped everyone. */
let runningRecorded = false;

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
        backgroundColor: '#0a0a0c',
        show: false,
        webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
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
        backgroundColor: '#0a0a0c',
        show: false,
        webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
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
 * Runs at every boot: it matches only v1's binaries and shells nobody is attached to.
 */
async function reapV1Runtime(): Promise<void> {
    const userData = app.getPath('userData');
    const roots = ['runtime', 'toolchain', 'pty-host'].map((d) => join(userData, d));
    const victims = v1Leftovers(listProcesses(), { roots, selfPid: process.pid });
    if (victims.length === 0) return;
    const killed = victims.filter((v) => killProcess(v.pid));
    const report = { at: new Date().toISOString(), found: victims.length, killed: killed.length, victims: victims.map((v) => ({ pid: v.pid, executable: v.executable, why: v.why })) };
    await writeFileText(join(genieHome(), 'v1-reap.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(`[genie] reaped v1's runtime: ${killed.length} of ${victims.length} (${victims.filter((v) => v.why === 'orphaned shell').length} orphaned shells, ${victims.filter((v) => v.why === 'v1 runtime binary').length} v1 binaries)`);
}

function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
        // The frame — hidden OS title bar, the native window buttons drawn over our 36 px bar on
        // Windows/Linux, a minimum size — is core/window.ts, where a test holds it. The owner's
        // first run had none of it: a window that could not be moved, resized or closed.
        ...mainWindowOptions(process.platform),
        // Genie's own icon on the window and the taskbar in a dev run and on Linux; the packaged Windows app carries it in the exe.
        ...(existsSync(join(here, '..', '..', 'build', 'icon.png')) ? { icon: join(here, '..', '..', 'build', 'icon.png') } : {}),
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

    // Paint when there is something to paint. A visible empty frame that then fills in is the
    // app looking broken for the length of a load.
    win.once('ready-to-show', () => win.show());

    void win.loadFile(join(here, '../renderer/index.html'));
    return win;
}

/** Where an agent runs: its workspace's path. The OS agent runs in the user's data directory. */
function cwdFor(record: AgentRecord): string {
    if (record.workspaceId === OS_WORKSPACE) return app.getPath('userData');
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
            instructions: record.instructions ?? null,
            // Whether this provider can ask for approval at all (the driver's own claim); a Take Over window says nothing.
            raisesApprovals: takeOver ? null : raisesApprovals(record.provider),
        },
        session: host.probe(record.id),
        rows: host.rowsFor(record.id),
        turns: host.turnsFor(record.id),
        // The engine's own recent words, for the process-ended block (the board's error state).
        log: host.recentStderrFor(record.id),
        // The session's running total, from the latest usage report (claude reports it; codex does not). `null` means
        // there is no Cost row — never a `$0.00`, which would claim the work was free.
        cost: sessionCostOf(host.rowsFor(record.id)),
        refusal: host.refusals.get(record.id) ?? null,
        takeOver,
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
/** The agents' MCP caller keys (one per agent, for the run). */
const sessionCallers = new CallerBook();
/** An agent session calling Genie's MCP, by its caller key: the agent and its workspace, now. */
function sessionCaller(key: string): { agentId: AgentId; agentName: string; workspaceId: string; workspacePath: string } | null {
    const id = sessionCallers.agentFor(key);
    const record = id ? registry?.find(id as AgentId) ?? null : null;
    const ws = record ? registry?.workspace(record.workspaceId) ?? null : null;
    return record && ws ? { agentId: record.id, agentName: record.name, workspaceId: ws.id, workspacePath: ws.path } : null;
}
const mcpEnv = (): Record<string, string> => { const e = mcp?.endpoint(); return e ? { GENIE_MCP_URL: e.url, GENIE_MCP_TOKEN: e.token } : {}; };
let browserPane: BrowserPane | null = null;

/** Where "latest" comes from, per tool. An unreachable or unreadable source yields null — the honest `unknown`. */
async function latestFor(tool: string): Promise<{ version: string; source: string } | null> {
    try {
        if (tool === 'node') return latestFromNodeIndex(await (await fetch('https://nodejs.org/dist/index.json')).json());
        if (tool === 'php') return phpLatestFromReleases(await (await fetch('https://www.php.net/releases/index.php?json')).json());
        if (tool === 'claude-code') return latestFromNpmOutdated((await execFileRunner('npm', ['outdated', '-g', '--json'])).stdout, '@anthropic-ai/claude-code');
        if (tool === 'codex') return latestFromNpmOutdated((await execFileRunner('npm', ['outdated', '-g', '--json'])).stdout, '@openai/codex');
        const def = HOST_TOOLS.find((t) => t.name === tool);
        const pm = packageManagerHere();
        if (!def || !pm) return null;
        if (pm === 'winget' && def.packages.winget) return latestFromWingetUpgrade((await execFileRunner('winget', ['upgrade', '--id', def.packages.winget])).stdout, def.packages.winget);
        if (pm === 'brew' && def.packages.brew) return latestFromBrewOutdated((await execFileRunner('brew', ['outdated', '--json'])).stdout, def.packages.brew);
        return null;
    } catch {
        return null;
    }
}

function packageManagerHere(): 'winget' | 'brew' | 'apt' | 'dnf' | null {
    if (process.platform === 'win32') return 'winget';
    if (process.platform === 'darwin') return 'brew';
    return null;
}
let featureState: FeatureState = { toolStatuses: null, knowledgeQuery: '' };
/** Who else wants the feature snapshot on change: the remote host's event stream. */
const featureListeners = new Set<(data: FeatureData) => void>();

async function boot(): Promise<void> {
    // Genie's data root is ~/.genie on every version (paths.ts); `userData` stays Chromium's.
    const store = new Store(genieHome());
    // A local binding as well as the module-level one, so the callback below closes over a
    // Registry rather than a `Registry | null` that TypeScript cannot narrow inside a closure.
    const theRegistry = new Registry(store);
    registry = theRegistry;
    theRegistry.setWorkspaceNamer(workspaceNameFor);
    host = new SessionHost({
        userData: genieHome(),
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
    await importFromV1(theRegistry);
    await reapV1Runtime();
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
            return host.rowsFor(record.id).flatMap((row): FileEvent[] =>
                row.event.kind === 'tool' ? [{ agentId: record.id, agentName: record.name, toolKind: row.event.toolKind, status: row.event.status, rawInput: row.event.rawInput, at: row.at }] : []);
        },
    });
    filesHost.onChange((workspaceId) => broadcast('genie:files-changed', workspaceId));
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
        // §7.5: the live agents to drain before installing; §7.4: every session ends with the upgrade.
        agents: {
            live: () => (registry?.snapshot().agents ?? []).filter((a) => host?.probe(a.id as AgentId)?.running === true).map((a) => ({ id: a.id, name: a.name })),
            ask: (id, text) => { host?.prompt(id as AgentId, text); },
            handoffSince: (id, since) => (services?.attention.finished() ?? []).some((f) => f.agentId === id && Date.parse(f.at) >= since),
            stopAll: () => {
                // Record who was running BEFORE the sessions end, so a restore after the upgrade knows (§7.6).
                const running = (registry?.snapshot().agents ?? []).filter((a) => host?.probe(a.id as AgentId)?.running === true).map((a) => a.id as AgentId);
                runningRecorded = true;
                void registry?.markRunningAtQuit(running);
                host?.stopAll();
            },
        },
    });
    // The drain advances on a clock while it lasts: handoffs that landed, agents gone quiet, the limit.
    updates.onChange((state) => {
        if (state.phase === 'draining' && drainTimer === null) drainTimer = setInterval(() => updates?.tick(), 1_000);
        else if (state.phase !== 'draining' && drainTimer !== null) { clearInterval(drainTimer); drainTimer = null; }
    });
    updates.onChange((state) => {
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('genie:updates-changed', state);
        }
    });
    ipcMain.handle('genie:updates-state', () => updates?.state() ?? null);
    autoCheckStop = updates.startAutoCheck((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    ipcMain.handle('genie:updates-check', () => updates?.check() ?? null);
    ipcMain.handle('genie:updates-download', () => updates?.download() ?? false);
    ipcMain.handle('genie:updates-install', () => {
        const result = updates?.install() ?? null;
        if (result) console.log(`[updater] ${result.report}`);
        return result ? { report: result.report } : null;
    });

    ipcMain.handle('genie:updates-cancel', () => updates?.cancel() ?? false);
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

    ipcMain.handle('genie:prompt', (_event, raw: unknown, text: unknown) => {
        const record = agentFromRenderer(raw);
        if (!record || !host || typeof text !== 'string' || text.length === 0) return { ok: false };
        // The composer: the turn is started by YOU, and the ledger says so.
        return { ok: host.prompt(record.id, text, 'you') };
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
    };
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
            // A shell in a workspace sees the workspace's service engines (DB_*, REDIS_URL…), like its processes do.
            const serviceEnv = services?.engines.envFor(workspace.id) ?? {};
            // cwd RESUME (§6.5): a new terminal opens where the workspace's last shell was, when tracking is on.
            const trackCwd = (services?.settings.snapshot() ?? {}).track_cwd !== false;
            const cwd = (trackCwd ? terminals.lastCwd(workspace.id) : null) ?? workspace.path;
            // GENIE_MCP_URL / GENIE_MCP_TOKEN in EVERY terminal (§6.9); the pty port adds GENIE_TERMINAL_ID itself.
            const env = { ...serviceEnv, ...mcpEnv() };
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
    // THE HOST'S SOCKET (§6.8): fancy-ws on the Tailscale IPv4 only; with no Tailscale nothing listens and Settings says why.
    const remoteSocket = remoteListener({
        tailscale: () => new Promise<string>((resolve, reject) => { execFileCb('tailscale', ['status', '--json'], { windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))); }),
        port: REMOTE_PORT,
        attach: attachWebSocketServer,
        // The phone's page (§6.8): the built renderer, from the same directory the window loads it from.
        serve: staticServer(join(here, '../renderer')),
    });
    remoteSocketNow = remoteSocket;
    const composed = await composeServices({
        userData: genieHome(),
        pty: ptyPort,
        v1Settings: () => readV1Settings(v1DatabaseFile()),
        // Genie's own Caddy, shipped beside the app (caddy-runtime.ts); null in a dev tree without it.
        caddyBin: caddyBinPath(process.resourcesPath, process.platform),
        frontDoorPort: 0,
        hostName: hostname(),
        remoteTransport: remoteSocket.transport,
        mcpEndpoint: () => mcp?.endpoint() ?? null,
        mcpVerification: () => mcpVerified,
        // The live roster, late-bound: the human's inbox resolves, names and counts from the same agents the MCP tools do.
        // A plain list, never `registry.snapshot()`: the snapshot builds the Deck's items, which ask this roster for
        // names — reading the snapshot here recursed until the stack overflowed (CI's real window, #161).
        roster: () => registry?.listAgents() ?? [],
        /*
         * What a remote connection may perform here (§6.8): the same parts the IPC handlers use,
         * behind one invoke. Late-bound through `services`/`featurePorts`, which exist by the time
         * any remote call arrives. The SOCKET is not wired yet — fancy-ws awaits its first npm publish
         * — so nothing listens and Settings → Workstation says devices cannot connect yet.
         */
        remoteApi: buildHostApi({
            snapshot: () => registry!.snapshot(),
            subscribeSnapshot: (cb) => registry!.subscribe(cb),
            find: (id) => registry?.find(id as AgentId) ?? null,
            detailFor: (id) => detailFor(id as AgentId),
            cwdFor,
            host: {
                start: (record, cwd) => host!.start(record, cwd),
                stop: (id) => host!.stop(id),
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
                diagnose: (id) => diagnose(agentOps, id),
            },
            features: {
                snapshot: () => featureSnapshot(services!, featureState),
                act: (action) => handleFeatureAction(services!, action, featureState, featurePorts),
                onChange: (cb) => { featureListeners.add(cb); return () => { featureListeners.delete(cb); }; },
            },
            updates: updates
                ? {
                      state: () => updates!.state(),
                      check: () => updates!.check(),
                      download: () => updates!.download(),
                      install: () => { const r = updates!.install(); return r ? { report: r.report } : null; },
                      cancel: () => updates!.cancel(),
                      onChange: (cb) => updates!.onChange(cb),
                  }
                : null,
        }),
    });
    services = composed;
    const pushFeatures = () => {
        void featureSnapshot(composed, featureState).then((data) => {
            if (window && !window.isDestroyed()) window.webContents.send(FEATURE_CHANNELS.changed, data);
            for (const l of featureListeners) l(data);
        });
    };
    composed.flows.onChange(pushFeatures);
    composed.settings.onChange(pushFeatures);
    composed.supervisor.onChange(pushFeatures);
    composed.onFrontDoorChange(pushFeatures);
    // GENIE'S OWN MCP SERVER (§6.9): every tool registered, the loopback listening, the boot probe recorded.
    {
        // A Take Over terminal, or an agent SESSION by its caller key (`mcp-callers.ts`); anything else is nobody.
        const resolveCaller = (terminalId: string) => takeOvers?.callerFor(terminalId) ?? sessionCaller(terminalId);
        const roster = () => (registry!.snapshot().workspaces ?? []).flatMap((w) => registry!.agentsOf(w.id));
        const values = () => composed.settings.snapshot();
        const registrations = allGenieTools({
            genie: {
                inbox: composed.inbox,
                attention: composed.attention,
                roster,
                resolveCaller,
                workspaceSetting: (workspaceId) => inboxSettingFrom(composed.settings.snapshotFor(workspaceId)),
                userActive: () => powerMonitor.getSystemIdleTime() < 120,
                glow: (terminalId) => { broadcast('genie:glow', terminalId); return true; },
                thumbsUp: (caller, reason) => { broadcast('genie:thumbs-up', { agentId: caller.agentId, reason }); },
                dnd: () => ({ on: values().do_not_disturb === true, reply: String(values().dnd_reply ?? '') }),
            },
            more: {
                knowledge: composed.knowledge,
                terminals: {
                    list: () => terminals!.list(),
                    open: (options) => terminals!.open(options),
                    write: (id, data) => terminals!.write(id, data),
                    scrollback: (id) => terminals!.scrollback(id),
                    // fancy-term-host's SCROLLBACK_MAX (1e6 characters): a buffer at the cap has been cut, and `manageTerminals` reads report `dropped`.
                    scrollbackCap: 1_000_000,
                },
                approve: (caller, action, detail) => composed.approvals.gate(caller, action, detail),
                resolveCaller,
            },
            attention: {
                resolveCaller,
                openFile: async (absolutePath) => { const failed = await shell.openPath(absolutePath); return failed ? { ok: false, reason: failed } : { ok: true }; },
                feedback: composed.feedback,
            },
            sidecar: {
                resolveCaller,
                roster,
                register: (input) => registry!.register(input),
                start: (record, cwd) => host!.start(record, cwd),
                running: (agentId) => host!.probe(agentId as AgentId)?.running === true,
                addressOf: (record) => addressOf(record, 'full'),
            },
            plugins: {
                plugins: { tools: () => composed.plugins.tools(), guard: (id) => composed.plugins.guard(id) },
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
                approve: (caller, action, detail) => composed.approvals.gate(caller, action, detail),
                resolveCaller,
            },
        });
        // The endpoint is REMEMBERED across launches (a private file in Genie's home), so the URL and token config sync
        // wrote into workspaces stay valid after a restart.
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
        } catch (error) {
            mcpVerified = { ok: false, reason: error instanceof Error ? error.message : String(error) };
            console.error('[mcp] the loopback server did not start:', mcpVerified.reason);
        }
        pushFeatures();
    }
    // RESTORE AFTER A RELAUNCH OR UPGRADE (§7.6): only with the ONE setting on; starts spaced three seconds apart; what the
    // user stopped was not running at quit, so it is not in the list. Taken once, so a crash mid-restore starts nobody twice.
    void registry.takeRunningAtQuit().then((ids) => {
        if (composed.settings.snapshot().restore_agents_on_launch !== true) return;
        for (const { agentId, at } of restoreSchedule(ids)) {
            setTimeout(() => { const record = registry?.find(agentId as AgentId); if (record && host) host.start(record, cwdFor(record)); }, at);
        }
    });
    // Listening (or the reason not) reaches Settings → Workstation as soon as it is known.
    void remoteSocket.start().then(pushFeatures, pushFeatures);
    // The Deck's signal strip, MEASURED (§4.5): flows in flight, mail agents have not collected, GitHub blocking, the OS agent working.
    registry.setSignals(() => composed.signals({ osAgentWorking: (() => { const os = registry?.osAgent(); return os ? host?.probe(os.id)?.turnState === 'working' : false; })() }));
    // §6.4 REMINDERS, event-driven: a message landing for an agent, or that agent's session changing (a turn
    // ending), never a poll. Only an IDLE agent is told; the book keeps the gap. Other agents' gaps are untouched
    // when one agent is being considered.
    const remind = (only: string) => {
        for (const r of composed.inboxReminders({ now: Date.now(), idle: (id) => id === only && host?.probe(id as AgentId)?.turnState === 'idle' })) {
            host?.prompt(r.agentId as AgentId, r.text, 'genie');
        }
    };
    composed.inbox.onSend((to) => { if (to !== 'human') remind(to); });
    // The human's conversation is in the features snapshot (an observed agent's chat): new mail and read receipts
    // push it, so a reply or a "read 14:07" lands without anyone polling.
    composed.inbox.onSend(() => { pushFeatures(); });
    composed.inbox.onRead(() => { pushFeatures(); });
    // Agent-to-agent mail changes the Dashboard's comms cells: rebuild the snapshot on every send.
    composed.inbox.onSend(() => { registry?.touch(); });
    host.subscribe((agentId) => remind(agentId));
    const featurePorts: FeaturePorts = {
        toolchain: {
            probe: () => probeToolsLive(latestFor),
            update: (tool) => runUpdate(tool, { platform: process.platform as 'win32' | 'darwin' | 'linux', packageManager: packageManagerHere() }, execFileRunner, null),
            now: Date.now,
        },
    };
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
    ipcMain.handle(FEATURE_CHANNELS.snapshot, () => featureSnapshot(composed, featureState));
    ipcMain.handle(FEATURE_CHANNELS.act, async (_event, raw: unknown) => {
        const action = raw as FeatureAction;
        const data = await handleFeatureAction(composed, action, featureState, featurePorts);
        if (action.kind === 'toolchain.check' || action.kind === 'toolchain.update') featureState = { ...featureState, toolStatuses: data.toolchain?.tools ?? null, toolchainCheckedAt: data.toolchain?.checkedAt ?? null };
        featureState = { ...featureState, knowledgeQuery: data.knowledge.query, knowledgeAdding: data.knowledge.adding, knowledgeLastAdd: data.knowledge.lastAdd, lastSync: data.integrations?.lastSync ?? featureState.lastSync ?? null };
        if (action.kind === 'browser.navigate') featureState = { ...featureState, browserUrl: data.browser.url };
        if (action.kind === 'browser.navigate' && browserPane && data.browser.url) {
            const shown = await browserPane.show(data.browser.url);
            if (!shown.ok) console.error('[genie] browser:', shown.reason);
        }
        featureState = { ...featureState, siteAdding: data.hosting?.adding ?? null, flowAdding: data.flows?.adding ?? null, serviceAdding: data.services?.adding ?? null };
        return data;
    });

    // PUSH, both ways. The registry says when the estate changed; the host says when one
    // agent did. Nothing here is on a timer.
    registry.subscribe((snapshot) => {
        if (window && !window.isDestroyed()) window.webContents.send('genie:changed', snapshot);
    });
    host.subscribe((agentId) => {
        pushAgent(agentId);
        // A ledger row can change a Dashboard cell — a plan step, a context figure — so the
        // estate-wide snapshot is refreshed too. It carries no ledgers, so this is cheap.
        registry?.touch();
    });

    window = createWindow();
    tray = createTray({
        onOpen: () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } },
        onSettings: () => {
            if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
            broadcast('genie:navigate', 'genie://settings');
        },
        onQuit: () => app.quit(),
    }, trayIconPath());
    browserPane = new BrowserPane(electronBrowserView(window), () => composed.routes());
}

app.on('second-instance', () => {
    if (window) {
        if (window.isMinimized()) window.restore();
        window.focus();
    }
});

/**
 * Every agent session ends with the app, and none is revived on the way out.
 *
 * `restore_agents_on_launch` defaults off and is the ONE setting that governs every path that
 * could restart an agent. There is no second branch here that revives anything "because the
 * window went away" — that branch, in the previous build, resurrected eleven agents the owner
 * had deliberately stopped.
 */
let quitConfirmed = false;
let remoteSocketNow: ReturnType<typeof remoteListener> | null = null;
app.on('before-quit', (event) => {
    autoCheckStop?.();
    autoCheckStop = null;
    // QUIT CONFIRMATION (§6.5): defaults to the safe thing. Asked once; a confirmed quit proceeds.
    if (!quitConfirmed && host && registry) {
        const running = registry.snapshot().agents.filter((a) => host!.probe(a.id as AgentId)?.running === true).map((a) => a.name);
        const plan = quitPlan({ runningAgents: running, liveTerminals: terminals?.count ?? 0, detachedTerminals: (services?.settings.snapshot() ?? {}).detached_terminals === true });
        if (plan.confirm) {
            const choice = dialog.showMessageBoxSync({ type: 'question', title: plan.title, message: plan.message, buttons: [...plan.buttons], defaultId: 0, cancelId: 0 });
            if (choice === 0) { event.preventDefault(); return; }
        }
        quitConfirmed = true;
    }
    // §7.6: remember who was running, BEFORE anything is stopped; the write finishes, then the quit resumes.
    if (!runningRecorded && registry && host) {
        runningRecorded = true;
        const running = registry.snapshot().agents.filter((a) => host!.probe(a.id as AgentId)?.running === true).map((a) => a.id as AgentId);
        event.preventDefault();
        // §6.5: the terminals' last screens, saved beside the running set, before the ptys go.
        const shown = (terminals?.list() ?? []).map((t) => ({ workspaceId: t.workspaceId, scrollback: terminals?.scrollback(t.id) ?? '' }));
        void Promise.all([registry.markRunningAtQuit(running), snapshots?.save(shown) ?? Promise.resolve()]).catch(() => { /* an unsaved list means no restore, never a blocked quit */ }).finally(() => app.quit());
        return;
    }
    host?.stopAll();
    // Every supervised process, the front door, an in-flight flow run, the knowledge database.
    void services?.shutdown();
    void remoteSocketNow?.stop();
    void filesHost?.close();
    // §7.1: nothing Genie spawned may outlive it. An upgrade jammed on 31 orphaned
    // OpenConsole.exe processes with no message, because nothing reaped them.
    terminals?.closeAll();
});

app.whenReady().then(boot).catch((error: unknown) => {
    // A boot failure is shown, not logged to a console nobody is reading. The most likely
    // cause is a store fault — and an unreadable `agents.json` is exactly the case where
    // continuing would overwrite it.
    dialog.showErrorBox('Genie could not start', String(error));
    app.quit();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
