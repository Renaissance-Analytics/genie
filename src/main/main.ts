import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asAgentId } from '../core/identity.js';
import { Registry } from './registry.js';
import { Store } from './store.js';

/**
 * THE MAIN PROCESS.
 *
 * Owns the registry, the window, and the four IPC channels the renderer is allowed to use.
 * Nothing here renders and nothing here decides what a row says — those are `src/core`, which
 * is why they can be tested without Electron.
 *
 * ## No agent is ever attached to a pty, and this file is where that is enforced in practice
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
 * a second instance focuses the first one. Verification happens on a VM, where there is no
 * first instance to collide with.
 */
if (!app.requestSingleInstanceLock()) {
    app.quit();
}

let window: BrowserWindow | null = null;
let registry: Registry | null = null;

function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        // The board's chrome is Genie's own 36px bar, so the OS frame would be a second title
        // bar above it. `titleBarStyle: 'hidden'` keeps the real window controls on Windows and
        // macOS while letting our bar occupy the top.
        titleBarStyle: 'hidden',
        backgroundColor: '#0a0a0c',
        show: false,
        webPreferences: {
            preload: join(here, 'preload.cjs'),
            // The renderer gets `window.genie` and nothing else: no Node, no `require`, no
            // `ipcRenderer`. A renderer with Node integration is a renderer where a prompt
            // injection reaches the filesystem.
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

async function boot(): Promise<void> {
    const store = new Store(app.getPath('userData'));
    registry = new Registry(store);

    // Healthy means this process is up and answering, which is the only claim the local
    // workstation chip can honestly make from in here. A real health model belongs with
    // remote workstations, where there is something to be unreachable.
    await registry.load({ name: hostname(), healthy: true });

    ipcMain.handle('genie:snapshot', () => registry?.snapshot() ?? null);

    ipcMain.handle('genie:open-agent', (_event, rawId: unknown) => {
        // The renderer is not trusted to hand over a well-formed id. `asAgentId` returning
        // `null` is a refusal, not a repair: looking up `''` would find nothing and render an
        // empty session forever, which is the §0.4 failure reached through the bridge.
        const id = typeof rawId === 'string' ? asAgentId(rawId) : null;
        if (!id || !registry?.find(id)) return { ok: false, reason: 'unknown agent' };

        // Starting a session lands with the Agent view in P3. Registering, persisting and
        // listing an agent all work now, and this says so rather than pretending.
        return { ok: false, reason: 'the agent surface arrives in P3' };
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

    // PUSH. The registry says when it changed; nothing here is on a timer.
    registry.subscribe((snapshot) => {
        if (window && !window.isDestroyed()) window.webContents.send('genie:changed', snapshot);
    });

    window = createWindow();
}

app.on('second-instance', () => {
    if (window) {
        if (window.isMinimized()) window.restore();
        window.focus();
    }
});

app.whenReady().then(boot).catch((error: unknown) => {
    // A boot failure is shown, not logged to a console nobody is reading. The most likely
    // cause is a `store` fault — and an unreadable `agents.json` is exactly the case where
    // continuing would overwrite it.
    dialog.showErrorBox('Genie could not start', String(error));
    app.quit();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
