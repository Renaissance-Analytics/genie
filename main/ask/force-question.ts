import { BrowserWindow, ipcMain } from 'electron';
import crypto from 'crypto';
import path from 'path';
import { getAllSettings } from '../db';
import type {
    ForceAnswer,
    ForceQuestion,
    ForceQuestionResult,
} from '../mcp/protocol';

/**
 * ForceTheQuestion — an OS-level, always-on-top modal an agent can raise to ask
 * the user one or more questions and block until they answer. Distinct from the
 * imDone glow (passive) and the in-window quit dialog (Genie-scoped): this
 * window floats above EVERY application (`screen-saver` z-level) so the user
 * can't miss it.
 *
 * One window per call (concurrent agents stack their own modals). The request
 * id rides in `ask:show`; the renderer replies with `ask:answer` / `ask:cancel`,
 * and closing the window without answering counts as a cancel.
 */

interface Config {
    isDev: boolean;
    preloadPath: string;
}

interface Pending {
    resolve: (r: ForceQuestionResult) => void;
    win: BrowserWindow;
    /** The payload to (re)deliver when the renderer signals it's ready. */
    payload: { id: string; questions: ForceQuestion[]; workspaceLabel?: string };
}

/**
 * Play the distinct ForceTheQuestion chime (gated by Settings → notify_sound).
 * Mirrors notifyImDone: send `notify:sound` to ONE live renderer so the chime
 * plays once; the renderer branches on `kind` to a more urgent motif.
 */
function notifyForceQuestion(): void {
    try {
        if (getAllSettings().notify_sound !== 'on') return;
    } catch {
        return; // settings unreadable — skip the chime, never block the modal
    }
    const target = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    target?.webContents.send('notify:sound', { kind: 'force-question' });
}

let config: Config | null = null;
let registered = false;
const pending = new Map<string, Pending>();

/** Find the pending request whose window owns the given webContents id. */
function findBySender(senderId: number): Pending | undefined {
    for (const p of pending.values()) {
        if (!p.win.isDestroyed() && p.win.webContents.id === senderId) return p;
    }
    return undefined;
}

function finish(id: string, result: ForceQuestionResult): void {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.resolve(result);
    if (!p.win.isDestroyed()) p.win.close();
}

/** Register the ask IPC handlers + capture window config. Idempotent. */
export function registerForceQuestionIpc(cfg: Config): void {
    config = cfg;
    if (registered) return;
    registered = true;

    ipcMain.handle('ask:answer', (_e, id: string, answers: ForceAnswer[]) => {
        finish(id, { cancelled: false, answers: answers ?? [] });
    });
    ipcMain.handle('ask:cancel', (_e, id: string) => {
        finish(id, { cancelled: true, answers: [] });
    });
    // The renderer signals it has attached its `ask:show` listener. Deliver the
    // payload NOW (race-free) — pushing on did-finish-load could fire before the
    // React effect registers the listener, leaving the modal stuck "Waiting…".
    ipcMain.handle('ask:ready', (e) => {
        const p = findBySender(e.sender.id);
        if (p && !p.win.isDestroyed()) p.win.webContents.send('ask:show', p.payload);
    });
    // Dismiss this window regardless of state (works even before the payload
    // loads — the loading view's only escape). Resolves the call as cancelled.
    ipcMain.handle('ask:dismiss', (e) => {
        const p = findBySender(e.sender.id);
        if (p) finish(p.payload.id, { cancelled: true, answers: [] });
    });
}

function createAskWindow(): BrowserWindow {
    if (!config) throw new Error('ForceTheQuestion IPC not registered');
    const win = new BrowserWindow({
        width: 560,
        height: 560,
        show: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        center: true,
        backgroundColor: '#0a0a0c',
        title: 'Genie — a question for you',
        webPreferences: {
            preload: config.preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    // Float above full-screen apps and other always-on-top windows, then grab
    // focus so the user lands on the modal immediately.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    if (config.isDev) {
        win.loadURL('http://localhost:8888/ask');
    } else {
        win.loadFile(path.join(__dirname, 'ask.html'));
    }
    win.once('ready-to-show', () => {
        win.show();
        win.focus();
    });
    return win;
}

/**
 * Raise the modal and resolve with the user's answers. Resolves cancelled if
 * the window is closed without a submit.
 */
export function forceQuestion(
    questions: ForceQuestion[],
    workspaceLabel?: string,
): Promise<ForceQuestionResult> {
    return new Promise((resolve) => {
        let win: BrowserWindow;
        try {
            win = createAskWindow();
        } catch {
            resolve({ cancelled: true, answers: [] });
            return;
        }
        // Distinct chime so the user can tell ForceTheQuestion from imDone by ear.
        notifyForceQuestion();
        const id = crypto.randomBytes(9).toString('hex');
        const payload = { id, questions, workspaceLabel };
        pending.set(id, { resolve, win, payload });

        // A close without an answer (window control, OS) resolves cancelled.
        win.on('closed', () => {
            if (pending.has(id)) {
                pending.delete(id);
                resolve({ cancelled: true, answers: [] });
            }
        });

        // Primary delivery is the renderer's `ask:ready` handshake (race-free).
        // Also push on load as a best-effort fallback; the renderer dedupes.
        const push = () => {
            if (!win.isDestroyed()) win.webContents.send('ask:show', payload);
        };
        if (win.webContents.isLoading()) {
            win.webContents.once('did-finish-load', push);
        } else {
            push();
        }
    });
}
