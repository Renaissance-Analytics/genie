import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asAgentId, type AgentId, type AgentRecord } from '../core/identity.js';
import type { AgentDetail } from '../renderer/bridge.js';
import { OS_WORKSPACE, Registry } from './registry.js';
import { SessionHost } from './session-host.js';
import { Store } from './store.js';

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
let host: SessionHost | null = null;

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

async function boot(): Promise<void> {
    const store = new Store(app.getPath('userData'));
    registry = new Registry(store);
    host = new SessionHost({ userData: app.getPath('userData') });

    // Healthy means this process is up and answering, which is the only claim the local
    // workstation chip can honestly make from in here. A real health model belongs with
    // remote workstations, where there is something to be unreachable.
    await registry.load({ name: hostname(), healthy: true });
    registry.setProbe((id) => host?.probe(id) ?? null);

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
