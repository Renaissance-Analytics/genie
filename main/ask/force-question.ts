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
 * Genie is multi-agent, so several agents can call ForceTheQuestion at once. We
 * present them ONE AT A TIME via a FIFO queue through a SINGLE shared window:
 * the first request opens the window, later requests enqueue, and each
 * answer/cancel/dismiss advances to the next. Each `forceQuestion(...)` call
 * still returns its OWN promise that resolves with THAT request's result, so the
 * MCP `tools/call` per-caller await is preserved. The request id rides in
 * `ask:show` (along with how many more are queued); the renderer replies with
 * `ask:answer` / `ask:cancel`, and closing the window counts as cancelling the
 * whole queue.
 */

interface Config {
    isDev: boolean;
    preloadPath: string;
}

/** One queued ForceTheQuestion request awaiting (or currently taking) its turn. */
interface QueueItem {
    id: string;
    resolve: (r: ForceQuestionResult) => void;
    questions: ForceQuestion[];
    workspaceLabel?: string;
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

/** The single shared modal window, or null when nothing is being asked. */
let win: BrowserWindow | null = null;
/** FIFO queue. The head (index 0) is the request currently shown in the window. */
const queue: QueueItem[] = [];

/**
 * Subscribers notified whenever the pending-question set changes (a question is
 * enqueued in forceQuestion, or removed in finish). The mobile server registers
 * one of these so it can push question:new / question:resolved to `/ws/events`.
 * Module-private; fired AFTER the queue mutation so a listener that reads
 * listPendingQuestions() sees the new state.
 */
const questionChangeListeners = new Set<() => void>();

function notifyQuestionsChanged(): void {
    for (const cb of questionChangeListeners) {
        try {
            cb();
        } catch {
            /* a listener throwing must never disturb the modal path */
        }
    }
}

/**
 * One pending ForceTheQuestion as the mobile server / API exposes it — the same
 * id + questions + workspaceLabel the desktop modal renders, plus a `queued`
 * timestamp so the phone can order them. Mirrors payloadFor() minus the live
 * "N behind" badge (the phone shows the whole list).
 */
export interface PendingQuestion {
    id: string;
    questions: ForceQuestion[];
    workspaceLabel?: string;
    /** Position in the FIFO queue (0 = currently shown on the desktop). */
    index: number;
}

/**
 * Snapshot the pending questions for the mobile `/api/questions` + bootstrap.
 * Read-only — does not touch the modal. Returns them in FIFO order (head first).
 */
export function listPendingQuestions(): PendingQuestion[] {
    return queue.map((item, index) => ({
        id: item.id,
        questions: item.questions,
        workspaceLabel: item.workspaceLabel,
        index,
    }));
}

/**
 * Answer a pending question from the mobile phone. Routes through the SAME
 * private finish(id, …) the desktop's `ask:answer` uses, so the blocked agent
 * unblocks AND the desktop modal advances/closes exactly as if answered locally.
 * Returns false when `id` is unknown — the benign phone-after-desktop race (the
 * desktop already answered it), surfaced to the phone as "already answered".
 */
export function answerPendingQuestion(
    id: string,
    answers: ForceAnswer[],
): boolean {
    if (!queue.some((q) => q.id === id)) return false;
    finish(id, { cancelled: false, answers: answers ?? [] });
    return true;
}

/** Subscribe to pending-question changes (mobile push). Returns an unsubscribe. */
export function onQuestionsChanged(cb: () => void): () => void {
    questionChangeListeners.add(cb);
    return () => questionChangeListeners.delete(cb);
}

/**
 * Seed a pending question WITHOUT opening the desktop modal (test-only). Enqueues
 * an item exactly as `forceQuestion` would (same id format, fires
 * notifyQuestionsChanged), so it appears in `listPendingQuestions()` and unblocks
 * through the normal `answerPendingQuestion` → `finish` path — but never creates a
 * BrowserWindow, so the mobile E2E harness can exercise the Questions flow with no
 * stray window. Returns the new question id. Used only by main/e2e/mock.ts (gated
 * on GENIE_E2E).
 */
export function _seedPendingQuestionForTest(
    questions: ForceQuestion[],
    workspaceLabel?: string,
): string {
    const id = crypto.randomBytes(9).toString('hex');
    queue.push({ id, resolve: () => {}, questions, workspaceLabel });
    notifyQuestionsChanged();
    return id;
}

/** Build the payload the renderer renders, including how many requests follow. */
function payloadFor(item: QueueItem): {
    id: string;
    questions: ForceQuestion[];
    workspaceLabel?: string;
    queued: number;
} {
    return {
        id: item.id,
        questions: item.questions,
        workspaceLabel: item.workspaceLabel,
        // How many OTHER requests are still waiting behind the current one.
        queued: Math.max(0, queue.length - 1),
    };
}

/** Push the current head's payload to the renderer (no-op if nothing pending). */
function showHead(): void {
    const head = queue[0];
    if (head && win && !win.isDestroyed()) {
        win.webContents.send('ask:show', payloadFor(head));
    }
}

/**
 * Resolve the request with the given id and advance the queue. If it was the
 * head (the shown one), reveal the next request in the same window, or close
 * the window when the queue drains. Resolving a NON-head id (rare) just removes
 * it without disturbing what's shown.
 */
function finish(id: string, result: ForceQuestionResult): void {
    const idx = queue.findIndex((q) => q.id === id);
    if (idx === -1) return;
    const [item] = queue.splice(idx, 1);
    item.resolve(result);
    // A pending question was removed — tell the mobile push channel so it can
    // emit question:resolved. Fires for BOTH head and queued removals.
    notifyQuestionsChanged();

    // Only the head drives the window. If a queued (not-yet-shown) item was
    // resolved, leave the current view alone.
    if (idx !== 0) return;

    if (queue.length === 0) {
        // Nothing left — close the shared window. The `closed` handler is a
        // no-op now that the queue is empty.
        if (win && !win.isDestroyed()) win.close();
        win = null;
        return;
    }
    showHead();
}

/** Find the queued request whose window owns the given webContents id. */
function itemBySender(senderId: number): QueueItem | undefined {
    if (!win || win.isDestroyed() || win.webContents.id !== senderId) return undefined;
    return queue[0];
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
    // current head NOW (race-free) — pushing on did-finish-load could fire
    // before the React effect registers the listener, leaving the modal stuck
    // "Waiting…".
    ipcMain.handle('ask:ready', (e) => {
        if (win && !win.isDestroyed() && win.webContents.id === e.sender.id) showHead();
    });
    // Dismiss the current question regardless of state (works even before the
    // payload loads — the loading view's only escape). Resolves the SHOWN
    // request as cancelled and advances to the next queued one.
    ipcMain.handle('ask:dismiss', (e) => {
        const item = itemBySender(e.sender.id);
        if (item) finish(item.id, { cancelled: true, answers: [] });
    });
}

function createAskWindow(): BrowserWindow {
    if (!config) throw new Error('ForceTheQuestion IPC not registered');
    const w = new BrowserWindow({
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
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    if (config.isDev) {
        w.loadURL('http://localhost:8888/ask');
    } else {
        w.loadFile(path.join(__dirname, 'ask.html'));
    }
    w.once('ready-to-show', () => {
        w.show();
        w.focus();
    });
    // A close without an answer (window control, OS, or our own teardown when
    // the queue drains) cancels EVERY still-queued request so no caller hangs.
    w.on('closed', () => {
        if (win === w) win = null;
        const dropped = queue.splice(0, queue.length);
        for (const item of dropped) item.resolve({ cancelled: true, answers: [] });
        // The whole queue was cancelled — push the cleared state to the mobile
        // channel too (one notify covers the batch).
        if (dropped.length) notifyQuestionsChanged();
    });
    return w;
}

/**
 * Raise the modal and resolve with the user's answers. Concurrent calls queue:
 * each resolves with ITS OWN result when its turn is answered or dismissed.
 * Resolves cancelled if the window is closed before this request is answered.
 */
export function forceQuestion(
    questions: ForceQuestion[],
    workspaceLabel?: string,
): Promise<ForceQuestionResult> {
    return new Promise((resolve) => {
        const id = crypto.randomBytes(9).toString('hex');
        const item: QueueItem = { id, resolve, questions, workspaceLabel };

        // First in line opens the shared window; later ones just enqueue and
        // wait their turn (the window is reused as each is answered).
        const startsQueue = queue.length === 0;
        queue.push(item);
        // A new pending question — tell the mobile push channel (question:new).
        notifyQuestionsChanged();

        if (!startsQueue) {
            // A modal is already up. Refresh its "N more queued" badge so the
            // user sees the new arrival, then return — this item shows later.
            showHead();
            return;
        }

        try {
            win = createAskWindow();
        } catch {
            queue.pop();
            resolve({ cancelled: true, answers: [] });
            return;
        }
        // Distinct chime so the user can tell ForceTheQuestion from imDone by ear.
        notifyForceQuestion();

        // Primary delivery is the renderer's `ask:ready` handshake (race-free).
        // Also push on load as a best-effort fallback; the renderer dedupes.
        const w = win;
        if (w.webContents.isLoading()) {
            w.webContents.once('did-finish-load', () => showHead());
        } else {
            showHead();
        }
    });
}
