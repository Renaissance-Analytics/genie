import { BrowserWindow, ipcMain, screen, shell } from 'electron';
import { join } from 'node:path';
import type { QuestionView, QuestionWindow, QuestionWindowPort } from './question-window.js';
import { genieWindowIcon } from './app-identity.js';

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

export function electronQuestionWindow(input: { here: string; preload: string; controller: () => QuestionWindow | null }): (onClosed: () => void) => QuestionWindowPort {
    // The page's calls, registered once: what to show (asked on load), an answer, Later, Dismiss — an answer and a
    // Dismiss name the question they are for (any question in the window's queue, in any order) — a pick from the
    // queue, and the draft being written (kept in main, so a closed window loses nothing).
    let last: QuestionView | null = null;
    const idOf = (raw: unknown): string | undefined => (typeof raw === 'string' && raw.length > 0 ? raw : undefined);
    const notesOf = (raw: unknown): string[] => (Array.isArray(raw) ? raw.map((n) => (typeof n === 'string' ? n : '')) : []);
    ipcMain.handle('question:current', () => last);
    ipcMain.handle('question:answer', (_e, selections: unknown, notes: unknown, rawId: unknown) => {
        const ctl = input.controller();
        if (!ctl) return { ok: false, reason: 'Genie is not ready' };
        const sel = Array.isArray(selections) ? selections.map((s) => (Array.isArray(s) ? s.map(String) : [])) : [];
        // One note per question; anything that is not a string is no note.
        const per = notesOf(notes);
        const id = idOf(rawId);
        return id === undefined ? ctl.answer(sel, per) : ctl.answer(sel, per, id);
    });
    ipcMain.handle('question:later', () => { input.controller()?.later(); });
    // Dismiss carries the person's notes, one per question, like an answer; anything that is not a string is no note.
    ipcMain.handle('question:dismiss', (_e, notes: unknown, rawId: unknown) => {
        const ctl = input.controller();
        if (!ctl) return { ok: false, reason: 'Genie is not ready' };
        const id = idOf(rawId);
        return id === undefined ? ctl.dismiss(notesOf(notes)) : ctl.dismiss(notesOf(notes), id);
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
        win.once('ready-to-show', () => win.showInactive());
        win.on('closed', onClosed);
        void win.loadFile(join(input.here, '../renderer/question.html'));
        return {
            show: (view) => {
                last = view;
                if (!win.isDestroyed()) win.webContents.send('question:show', view);
            },
            close: () => { if (!win.isDestroyed()) win.close(); },
        };
    };
}
