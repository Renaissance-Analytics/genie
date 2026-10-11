import { BrowserWindow, app, dialog, ipcMain, safeStorage } from 'electron';
import { realFancyTermPort } from './fancy-term-port.js';
import { TerminalHost } from './terminal-host.js';
import { TakeOverHost } from './take-over-host.js';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asAgentId, type AgentId, type AgentRecord } from '../core/identity.js';
import type { AgentDetail } from '../renderer/bridge.js';
import { OS_WORKSPACE, Registry } from './registry.js';
import { readFile, rm } from 'node:fs/promises';
import { deleteAgent, diagnose, previewDelete, restartAgent, setAccessScope, setBudget, setMode, switchDriver, type AgentOpsPorts } from './agent-ops-host.js';
import { quitPlan } from '../core/quit.js';
import { buildHostApi } from './host-api.js';
import { addWorkspace as addWorkspaceOp, addWorkspaceFromGit, hibernateWorkspace, previewAddFromGit, previewAddWorkspace, removeWorkspace, startRefusal, wakeWorkspace, type WorkspaceOpsPorts } from './workspace-ops-host.js';
import { mkdir, readdir, readFile as readFileText, stat as statPath, writeFile as writeFileText } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { restartWithHandoff } from './restart-with-handoff.js';
import { SessionHost, providerBinary } from './session-host.js';
import { Store } from './store.js';
import { composeServices, type ComposedServices } from './compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from './feature-ipc.js';
import { readV1Settings } from './v1-settings.js';
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
import { addRepoTo, listReposOf, removeRepoFrom, type RepoOpsPorts } from './repo-ops-host.js';
import { agentCapFrom } from '../core/inbox.js';
import type { FileEvent } from '../core/files-panel.js';
import { remoteListener } from './remote-listen.js';
import { staticServer } from './static-page.js';
import { uploadSender } from './uploads.js';
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
let registry: Registry | null = null;
let terminals: TerminalHost | null = null;
let filesHost: FilesHost | null = null;
let snapshots: TerminalSnapshots | null = null;
let takeOvers: TakeOverHost | null = null;
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

function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        // The board's chrome is Genie's own 36px bar, so the OS frame would be a second title
        // bar above it. `titleBarStyle: 'hidden'` keeps the real window controls while letting
        // our bar occupy the top.
        titleBarStyle: 'hidden',
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

    return {
        agent: {
            id: record.id,
            name: record.name,
            provider: record.provider,
            // Every registered agent speaks ACP. `observed` belongs to a Take Over window,
            // which Genie does not register, and `remote` to another workstation.
            fidelity: 'declared',
            cwd: cwdFor(record),
            dailyBudgetUsd: record.dailyBudgetUsd ?? null,
            mode: record.mode,
            accessScope: record.accessScope,
        },
        session: host.probe(record.id),
        rows: host.rowsFor(record.id),
        turns: host.turnsFor(record.id),
        // No provider reports a cost over ACP today. `null` means there is no Cost row —
        // never a `$0.00`, which would claim the work was free.
        cost: null,
        refusal: host.refusals.get(record.id) ?? null,
    };
}

function pushAgent(agentId: AgentId): void {
    if (!window || window.isDestroyed()) return;
    // One channel per agent, so a ledger is never broadcast to a renderer looking elsewhere.
    window.webContents.send(`genie:agent-changed:${agentId}`, detailFor(agentId));
}

/** Narrow an id from the renderer. A refusal, never a repair — see the note in `open-agent`. */
function agentFromRenderer(raw: unknown): AgentRecord | null {
    const id = typeof raw === 'string' ? asAgentId(raw) : null;
    return id ? registry?.find(id) ?? null : null;
}

let services: ComposedServices | null = null;
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
        workspace: (id) => { const w = registry?.workspace(id); return w ? { id: w.id, path: w.path } : null; },
        agentsOf: (workspaceId) => (registry?.agentsOf(workspaceId) ?? []).map((a) => ({ id: a.id, name: a.name })),
        eventsOf: (agentId) => {
            const record = registry?.find(agentId as AgentId);
            if (!record || !host) return [];
            return host.rowsFor(record.id).flatMap((row): FileEvent[] =>
                row.event.kind === 'tool' ? [{ agentId: record.id, agentName: record.name, toolKind: row.event.toolKind, status: row.event.status, rawInput: row.event.rawInput }] : []);
        },
    });
    filesHost.onChange((workspaceId) => { if (window && !window.isDestroyed()) window.webContents.send('genie:files-changed', workspaceId); });
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
    });
    const takeOversNow = takeOvers;
    theRegistry.setObservedProbe((id) => takeOversNow.probe(id));

    /*
     * UPDATES (§7). The host drives electron-updater; the renderer asks and shows. The install
     * directory is wherever this executable lives — `%LOCALAPPDATA%\Programs\Genie` when
     * installed, Electron's own dist in a dev run — and §7.2's teardown scans exactly that.
     * Nothing checks on a timer: the first check is the user's, or the smoke's.
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
        return { ok: host.prompt(record.id, text) };
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
            return terminals.open({ workspaceId: workspace.id, cwd, command, cols, rows, ...(Object.keys(serviceEnv).length > 0 ? { env: serviceEnv } : {}) });
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

    ipcMain.handle('genie:terminal-previous', (_event, workspaceId: unknown) => (typeof workspaceId === 'string' ? snapshots?.take(workspaceId) ?? null : null));

    // THE FILE PANEL (§4.3). Confinement happens in the host; the renderer never sees a path it did not ask about.
    ipcMain.handle('genie:files-tree', (_event, workspaceId: unknown) => (typeof workspaceId === 'string' ? filesHost?.tree(workspaceId) ?? null : null));
    ipcMain.handle('genie:files-open', (_event, workspaceId: unknown, path: unknown) =>
        typeof workspaceId === 'string' && typeof path === 'string' ? filesHost?.open(workspaceId, path) ?? { ok: false, path, error: 'no files host' } : { ok: false, path: String(path), error: 'bad arguments' });
    ipcMain.handle('genie:files-state', (_event, workspaceId: unknown) => (typeof workspaceId === 'string' ? filesHost?.state(workspaceId) ?? null : null));
    ipcMain.handle('genie:files-watch', (_event, workspaceId: unknown) => (typeof workspaceId === 'string' ? filesHost?.watch(workspaceId) : undefined));
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
            gitInit: (p) => new Promise<void>((resolve, reject) => { execFileCb('git', ['init'], { cwd: p }, (error) => (error ? reject(error) : resolve())); }),
            // The clone's own stderr is the reason a person reads; a bare exit code is not.
            gitClone: (url, into) => new Promise<void>((resolve, reject) => {
                execFileCb('git', ['clone', '--', url, into], { windowsHide: true }, (error, _stdout, stderr) => (error ? reject(new Error(String(stderr ?? error.message).trim() || error.message)) : resolve()));
            }),
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
    };
    // THE REPO REGISTRY (§6.1): the envelope's repos[], through the same fs ports; the host repo is protected in core.
    const repoOps: RepoOpsPorts = { fs: workspaceOps.fs, registry: { workspace: (id) => registry?.workspace(id) ?? null } };
    ipcMain.handle('genie:workspace-repos', (_event, raw: unknown) => (typeof raw === 'string' ? listReposOf(repoOps, raw) : { ok: false, reason: 'name a workspace' }));
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
        v1Settings: () => readV1Settings(join(genieHome(), 'genie.db')),
        // Genie's own Caddy, shipped beside the app (caddy-runtime.ts); null in a dev tree without it.
        caddyBin: caddyBinPath(process.resourcesPath, process.platform),
        frontDoorPort: 0,
        hostName: hostname(),
        remoteTransport: remoteSocket.transport,
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
                onData: (cb) => terminals!.onData(cb),
                onExit: (cb) => terminals!.onExit(cb),
            },
            // A phone's upload (§6.8): a temp file under ~/.genie/uploads for exactly as long as the inbox copies it.
            uploads: uploadSender({ dir: join(genieHome(), 'uploads'), resolve: (to) => services!.resolveAddress(to), send: (input) => services!.inbox.send(input) }),
            serviceEnvFor: (workspaceId) => services!.engines.envFor(workspaceId),
            workspaceOps: {
                confirmAdd: (path) => addWorkspaceOp(workspaceOps, path),
                confirmAddFromGit: (url, parent) => addWorkspaceFromGit(workspaceOps, url, parent),
                hibernate: (id) => hibernateWorkspace(workspaceOps, id, { handoffWaitMs: 20_000, pollMs: 500 }),
                wake: (id) => wakeWorkspace(workspaceOps, id),
                remove: (id) => removeWorkspace(workspaceOps, id),
                listRepos: (id) => listReposOf(repoOps, id),
                addRepo: (id, input) => addRepoTo(repoOps, id, input),
                removeRepo: (id, slug) => removeRepoFrom(repoOps, id, slug),
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
            host?.prompt(r.agentId as AgentId, r.text);
        }
    };
    composed.inbox.onSend((to) => { if (to !== 'human') remind(to); });
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
