import { BrowserWindow, ipcMain, screen, shell } from 'electron';
import { relative } from 'node:path';
import { loadWindowPage } from './window-pages.js';
import type { QuestionView, QuestionWindow, QuestionWindowPort } from './question-window.js';
import { genieWindowIcon } from './app-identity.js';
import { askWindowBounds } from '../core/question-drawer.js';
import { questionFileInside } from './question-files.js';
import { actOnRemoteQuestion } from './remote-questions.js';
import { onceShowable } from '../core/window-activation.js';
import type { DeckItem } from '../core/deck.js';

/**
 * THE FORCETHEQUESTION WINDOW — the Electron half of `question-window.ts`. Genie 1's window, carried over (genie
 * main/ask/force-question.ts): frameless, ON TOP of every other window including full-screen apps, on every
 * workspace, shown WITHOUT taking focus (a question must never take the keyboard out of a sentence the person is typing),
 * resizable, kept on the display, and a link in the question opens outside it — never navigating this window. A
 * question arriving while it is up is PUSHED to it (`show`) and nothing else: no focus, no raise, no reload — the page
 * lists it in its queue and leaves the form the person is filling in alone (genie#156 in Genie 1).
 */
const WIDTH = 560;
const HEIGHT = 520;

export function electronQuestionWindow(input: {
    here: string; preload: string; controller: () => QuestionWindow | null; workspacePath?: (workspaceId: string) => string | null; openInFiles?: (workspaceId: string, path: string) => void;
    /** Is this (shown) id another machine's question (RemoteQuestions)? Only those cross to main (Tynn #912, 2f-1). */
    owns?: (id: string) => boolean;
    /** Another machine's question's visuals, through the window driving that machine (Tynn #835). */
    visuals?: (item: DeckItem) => Promise<{ posts: readonly unknown[] }>;
    /** Admit the window's page to main's IPC door, so it reaches genie-host over its own frame port (Tynn #912, 2f-1). */
    admit?: (contents: Electron.WebContents) => void;
}): (onClosed: () => void) => QuestionWindowPort {
    // The page's calls, registered once: what to show (asked on load), Later, a pick from the queue, and the draft being
    // written (kept in main, so a closed window loses nothing). THIS machine's answer and Dismiss, and its question's files
    // and visuals, are the page's own calls to genie-host over the one protocol (renderer/question-bridge.ts; Tynn #912).
    let last: QuestionView | null = null;
    const idOf = (raw: unknown): string | undefined => (typeof raw === 'string' && raw.length > 0 ? raw : undefined);
    /** A question this window holds, by id: never one the page names that it was not shown. */
    const held = (id: string | undefined): DeckItem | null => {
        const queue = last ? (last.queue && last.queue.length > 0 ? last.queue : [last.item]) : [];
        return queue.find((q) => q.id === id) ?? null;
    };
    ipcMain.handle('question:current', () => last);
    ipcMain.handle('question:later', () => { input.controller()?.later(); });
    // ANOTHER MACHINE'S QUESTION (Tynn #726): its answer, its Dismiss (each with the person's notes) and its visuals go back
    // through the window driving that machine (remote-questions.ts). This machine's are refused here: they are the protocol's.
    ipcMain.handle('question:remote', (_e, raw: unknown) => {
        const ctl = input.controller();
        if (!ctl) return { ok: false, reason: 'Genie is not ready' };
        return actOnRemoteQuestion(raw, {
            owns: (id) => input.owns?.(id) === true,
            answer: (selections, notes, id) => ctl.answer(selections, notes, id),
            dismiss: (notes, id) => ctl.dismiss(notes, id),
            visuals: async (id) => {
                const item = held(id);
                if (!item || !input.visuals) throw new Error('Genie does not know this question');
                return input.visuals(item);
            },
        });
    });
    ipcMain.handle('question:select', (_e, rawId: unknown) => { const id = idOf(rawId); if (id !== undefined) input.controller()?.select(id); });
    ipcMain.handle('question:draft', (_e, rawId: unknown, raw: unknown) => {
        const id = idOf(rawId);
        const d = raw as { selections?: unknown; notes?: unknown; revision?: unknown } | null;
        if (id === undefined || !d || !Array.isArray(d.selections)) return;
        const selections = d.selections.map((s) => (Array.isArray(s) ? s.map(String) : []));
        const revision = typeof d.revision === 'number' && Number.isFinite(d.revision) ? d.revision : 0;
        input.controller()?.draft(id, { selections, notes: notesOf(d.notes), revision });
    });
    // A file the drawer cannot draw (a PDF, a binary) opens in Genie's Files panel, in THIS machine's main window: the
    // question is looked up in what this window holds and the path confined to its workspace, so the page cannot name a file
    // the drawer would have refused.
    ipcMain.handle('question:open-in-files', (_e, rawId: unknown, path: unknown) => {
        const item = held(idOf(rawId));
        const root = item?.workspaceId ? input.workspacePath?.(item.workspaceId) ?? null : null;
        const inside = !item?.workspaceId || root === null || typeof path !== 'string' ? null : questionFileInside(root, path);
        if (!item?.workspaceId || root === null || inside === null) return false;
        // The Files panel takes a workspace-relative path, forward slashes.
        input.openInFiles?.(item.workspaceId, relative(root, inside).replace(/\\/g, '/'));
        return true;
    });
    // The window WIDENS for the drawer and back (Genie 1's askWindowBounds): the width it had before is what it returns to.
    let current: BrowserWindow | null = null;
    let baseWidth: number | null = null;
    ipcMain.handle('question:drawer', (_e, open: unknown) => {
        const win = current;
        if (!win || win.isDestroyed()) return;
        const bounds = win.getBounds();
        if (open === true && baseWidth === null) baseWidth = bounds.width;
        const workArea = screen.getDisplayMatching(bounds).workArea;
        win.setBounds(askWindowBounds({ current: bounds, workArea, drawerOpen: open === true, baseWidth: baseWidth ?? bounds.width }));
        if (open !== true) baseWidth = null;
    });

    return (onClosed) => {
        const area = screen.getPrimaryDisplay().workArea;
        const win = new BrowserWindow({
            width: Math.min(WIDTH, area.width),
            height: Math.min(HEIGHT, area.height),
            minWidth: 380,
            minHeight: 300,
            show: false,
            frame: false,
            resizable: true,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: true,
            center: true,
            skipTaskbar: false,
            title: 'Genie — a question for you',
            // On the taskbar (skipTaskbar false), so it carries Genie's icon like every Genie window (main/app-identity.ts).
            ...genieWindowIcon(input.here),
            backgroundColor: '#09090b',
            webPreferences: { preload: input.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        // Above full-screen apps and other always-on-top windows, on every desktop.
        win.setAlwaysOnTop(true, 'screen-saver');
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        // A link in the question never navigates this window: it opens in the machine's browser.
        win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url).catch(() => {}); return { action: 'deny' }; });
        win.webContents.on('will-navigate', (event, url) => { event.preventDefault(); void shell.openExternal(url).catch(() => {}); });
        // Its page reaches genie-host over the one protocol, on main's door like every Genie window (Tynn #912, 2f-1).
        input.admit?.(win.webContents);
        onceShowable(win, process.platform, () => win.showInactive());
        current = win;
        win.on('closed', () => { if (current === win) { current = null; baseWidth = null; } onClosed(); });
        void loadWindowPage(win.webContents, 'question').catch((error: unknown) => console.error(`[window-pages] ${String(error)}`));
        return {
            show: (view) => {
                last = view;
                if (!win.isDestroyed()) win.webContents.send('question:show', view);
            },
            close: () => { if (!win.isDestroyed()) win.close(); },
        };
    };
}
