import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForceQuestion } from '../../mcp/protocol';

/**
 * The modal window is actually RESIZED when the file drawer opens (Tynn #272).
 *
 * `drawer-bounds.test.ts` proves the arithmetic against a plain object. Nothing
 * there proves the arithmetic reaches a window: delete the `ask:drawer` handler,
 * or hand it the wrong bounds, and all eight of those cases still pass while the
 * drawer renders in a 560px window with the question squeezed to nothing beside
 * it — the exact failure the drawer exists to avoid.
 *
 * So this drives the real path: raise a question, take the IPC handler the modal
 * registered, and open the drawer through it.
 *
 * It also pins the sender check. The modal is a SHARED window that questions take
 * turns in, and a renderer from a window that has since closed can still have an
 * `ask:drawer` call in flight; resizing the live modal on its say-so would move a
 * window under someone who is mid-answer.
 */

interface FakeWin {
    id: number;
    destroyed: boolean;
    bounds: { x: number; y: number; width: number; height: number };
    resizable: boolean;
    /** Every `resizable` value set, in order — the lift-and-restore is asserted. */
    resizableLog: boolean[];
    closedHandlers: Array<() => void>;
    close: () => void;
    webContents: Record<string, unknown>;
}

const state: { windows: FakeWin[]; nextId: number; handlers: Record<string, Function> } = {
    windows: [],
    nextId: 1,
    handlers: {},
};

vi.mock('electron', () => {
    class BrowserWindow {
        static getAllWindows(): unknown[] {
            return [];
        }
        constructor(opts: { width: number; height: number }) {
            const self = this as unknown as FakeWin;
            self.id = state.nextId++;
            self.destroyed = false;
            self.bounds = { x: 700, y: 200, width: opts.width, height: opts.height };
            self.resizable = false;
            self.resizableLog = [];
            self.closedHandlers = [];
            self.webContents = {
                id: self.id,
                isLoading: () => false,
                once: () => {},
                send: () => {},
                getURL: () => 'http://localhost:8888/ask',
                on: () => {},
                setWindowOpenHandler: () => {},
            };
            state.windows.push(self);
        }
        getBounds(): { x: number; y: number; width: number; height: number } {
            return { ...(this as unknown as FakeWin).bounds };
        }
        setBounds(b: { x: number; y: number; width: number; height: number }): void {
            (this as unknown as FakeWin).bounds = { ...b };
        }
        isResizable(): boolean {
            return (this as unknown as FakeWin).resizable;
        }
        setResizable(v: boolean): void {
            const self = this as unknown as FakeWin;
            self.resizable = v;
            self.resizableLog.push(v);
        }
        setAlwaysOnTop(): void {}
        setVisibleOnAllWorkspaces(): void {}
        loadURL(): void {}
        loadFile(): void {}
        on(ev: string, fn: () => void): void {
            if (ev === 'closed') (this as unknown as FakeWin).closedHandlers.push(fn);
        }
        once(): void {}
        focus(): void {}
        show(): void {}
        isDestroyed(): boolean {
            return (this as unknown as FakeWin).destroyed;
        }
        close(): void {
            const self = this as unknown as FakeWin;
            if (self.destroyed) return;
            self.destroyed = true;
            for (const fn of self.closedHandlers) fn();
        }
    }
    return {
        BrowserWindow,
        ipcMain: {
            handle: (channel: string, fn: Function) => {
                state.handlers[channel] = fn;
            },
        },
        shell: { openExternal: () => Promise.resolve() },
        screen: {
            getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
        },
    };
});

const mockDb = vi.hoisted(() => ({
    settings: { notify_sound: 'off' } as Record<string, string>,
}));
vi.mock('../../db', () => ({
    getAllSettings: () => mockDb.settings,
    setSettings: () => {},
    listWorkspaces: () => [{ id: 'ws-1', path: '/work/space' }],
}));
vi.mock('../../notify-sound', () => ({
    resolveAlertSound: () => null,
    deliverAlertSound: () => {},
    // The chime goes through ONE gate now (genie#546); inert here, like the
    // two above, so these tests are about the modal and not about audio.
    playAlertSound: () => false,
}));
vi.mock('../../testing-browser', () => ({
    LOCAL_CONN_KEY: 'local',
    openTestingBrowser: () => Promise.resolve(),
}));

import { forceQuestion, registerForceQuestionIpc, setQuestionTransport } from '../force-question';
import { ASK_DRAWER_WIDTH, ASK_MODAL_WIDTH } from '../drawer-bounds';

const Q: ForceQuestion[] = [
    { header: 'Pick', question: 'Does `.ai/plans/spec.md` still hold?', options: [{ label: 'Yes' }] },
];

/** Raise a question and hand back the modal window it opened. */
function openModal(): { w: FakeWin; done: Promise<unknown> } {
    const done = forceQuestion(Q, 'Workspace', 'normal', { workspaceId: 'ws-1' });
    return { w: state.windows[state.windows.length - 1]!, done };
}

/** Open/close the drawer as the renderer does — through the registered handler. */
function setDrawer(senderId: number, open: boolean): void {
    state.handlers['ask:drawer']!({ sender: { id: senderId } }, open);
}

describe('the ask modal makes room for the file drawer (Tynn #272)', () => {
    beforeEach(() => {
        setQuestionTransport(null); // the desktop BrowserWindow path
        state.windows = [];
        state.nextId = 1;
        mockDb.settings = { notify_sound: 'off' };
        registerForceQuestionIpc({
            isDev: false,
            preloadPath: '/preload.js',
            getMasterWindow: () => null,
        });
    });
    afterEach(() => {
        for (const w of state.windows) if (!w.destroyed) w.close();
        vi.clearAllMocks();
    });

    it('registers the drawer channel at all', () => {
        expect(typeof state.handlers['ask:drawer']).toBe('function');
    });

    it('widens the window for the drawer and gives the width back', async () => {
        const { w, done } = openModal();
        expect(w.bounds.width).toBe(ASK_MODAL_WIDTH);

        setDrawer(w.id, true);
        expect(w.bounds.width).toBe(ASK_MODAL_WIDTH + ASK_DRAWER_WIDTH);

        setDrawer(w.id, false);
        expect(w.bounds.width).toBe(ASK_MODAL_WIDTH);

        w.close();
        await done;
    });

    it('leaves the question where it is, vertically', async () => {
        const { w, done } = openModal();
        const { y, height } = w.bounds;
        setDrawer(w.id, true);
        expect(w.bounds.y).toBe(y);
        expect(w.bounds.height).toBe(height);
        w.close();
        await done;
    });

    it('lifts the resize lock for the call and puts it straight back', async () => {
        const { w, done } = openModal();
        setDrawer(w.id, true);
        // A non-resizable window can refuse a programmatic resize, so the lock is
        // lifted — and restored, because nothing about a question wants a drag
        // handle. Leaving it lifted would be a user-visible change nobody asked for.
        expect(w.resizableLog).toEqual([true, false]);
        expect(w.resizable).toBe(false);
        w.close();
        await done;
    });

    it('ignores a drawer call from a window that is not the modal', async () => {
        const { w, done } = openModal();
        const width = w.bounds.width;
        setDrawer(w.id + 999, true);
        expect(w.bounds.width).toBe(width);
        w.close();
        await done;
    });

    it('carries the workspace root to the modal, so a named file can be opened', async () => {
        const { w, done } = openModal();
        // Without this the chips render nothing to click: the renderer refuses to
        // resolve a path when it does not know which workspace to resolve it in.
        const { listPendingQuestions } = await import('../force-question');
        expect(listPendingQuestions()[0]?.workspacePath).toBe('/work/space');
        w.close();
        await done;
    });
});
