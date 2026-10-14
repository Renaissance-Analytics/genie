import { BrowserWindow, ipcMain, screen, shell } from 'electron';
import { join } from 'node:path';
import type { QuestionView, QuestionWindow, QuestionWindowPort } from './question-window.js';

/**
 * THE FORCETHEQUESTION WINDOW — the Electron half of `question-window.ts`. Genie 1's window, carried over (genie
 * main/ask/force-question.ts): frameless, ON TOP of every other window including full-screen apps, on every
 * workspace, shown WITHOUT taking focus (a question must never take the keyboard out of a sentence the person is typing),
 * resizable, kept on the display, and a link in the question opens outside it — never navigating this window.
 */
const WIDTH = 560;
const HEIGHT = 520;

export function electronQuestionWindow(input: { here: string; preload: string; controller: () => QuestionWindow | null }): (onClosed: () => void) => QuestionWindowPort {
    // The page's three calls, registered once: what to show (asked on load), an answer, Later.
    let last: QuestionView | null = null;
    ipcMain.handle('question:current', () => last);
    ipcMain.handle('question:answer', (_e, selections: unknown, note: unknown) => {
        const ctl = input.controller();
        if (!ctl) return { ok: false, reason: 'Genie is not ready' };
        const sel = Array.isArray(selections) ? selections.map((s) => (Array.isArray(s) ? s.map(String) : [])) : [];
        return ctl.answer(sel, typeof note === 'string' ? note : '');
    });
    ipcMain.handle('question:later', () => { input.controller()?.later(); });

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
