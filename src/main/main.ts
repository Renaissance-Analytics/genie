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
import { BrowserPane } from './browser-pane.js';
import { electronBrowserView } from './electron-browser-view.js';
import { FEATURE_CHANNELS } from '../renderer/bridge.js';
import type { FeatureAction } from '../renderer/features.js';
import { UpdateHost } from './updater.js';
import { genieHome } from './paths.js';
import { realElectronUpdaterPort } from './electron-updater-port.js';
import { killProcess, listProcesses } from './process-list.js';

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
let takeOvers: TakeOverHost | null = null;
let host: SessionHost | null = null;
let updates: UpdateHost | null = null;

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
    });
    terminals = new TerminalHost(ptyPort);
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
            return terminals.open({ workspaceId: workspace.id, cwd: workspace.path, command, cols, rows, ...(Object.keys(serviceEnv).length > 0 ? { env: serviceEnv } : {}) });
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
    const composed = await composeServices({
        userData: genieHome(),
        pty: ptyPort,
        v1Settings: () => readV1Settings(join(genieHome(), 'genie.db')),
        // Genie's own Caddy, shipped beside the app (caddy-runtime.ts); null in a dev tree without it.
        caddyBin: caddyBinPath(process.resourcesPath, process.platform),
        frontDoorPort: 0,
    });
    services = composed;
    const pushFeatures = () => {
        void featureSnapshot(composed, featureState).then((data) => {
            if (window && !window.isDestroyed()) window.webContents.send(FEATURE_CHANNELS.changed, data);
        });
    };
    composed.flows.onChange(pushFeatures);
    composed.settings.onChange(pushFeatures);
    composed.supervisor.onChange(pushFeatures);
    composed.onFrontDoorChange(pushFeatures);
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
    ipcMain.handle(FEATURE_CHANNELS.snapshot, () => featureSnapshot(composed, featureState));
    ipcMain.handle(FEATURE_CHANNELS.act, async (_event, raw: unknown) => {
        const action = raw as FeatureAction;
        const data = await handleFeatureAction(composed, action, featureState, featurePorts);
        if (action.kind === 'toolchain.check' || action.kind === 'toolchain.update') featureState = { ...featureState, toolStatuses: data.toolchain?.tools ?? null, toolchainCheckedAt: data.toolchain?.checkedAt ?? null };
        if (action.kind === 'knowledge.search') featureState = { ...featureState, knowledgeQuery: action.query };
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
app.on('before-quit', () => {
    host?.stopAll();
    // Every supervised process, the front door, an in-flight flow run, the knowledge database.
    void services?.shutdown();
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
