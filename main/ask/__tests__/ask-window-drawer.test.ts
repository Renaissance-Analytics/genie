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
    resizeHandlers: Array<() => void>;
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
            self.resizeHandlers = [];
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
            const self = this as unknown as FakeWin;
            const resized = b.width !== self.bounds.width || b.height !== self.bounds.height;
            self.bounds = { ...b };
            // Electron emits `resize` for a PROGRAMMATIC `setBounds` exactly as it
            // does for a drag — which is the whole reason the drawer could poison
            // the remembered size. A fake that swallows the event cannot show it.
            if (resized) for (const fn of self.resizeHandlers) fn();
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
            const self = this as unknown as FakeWin;
            if (ev === 'closed') self.closedHandlers.push(fn);
            if (ev === 'resize') self.resizeHandlers.push(fn);
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
    // A REAL store. The remembered modal size is read back out of settings on the
    // very next drawer toggle, so a `setSettings` that throws the write away hides
    // every bug that round trip can have.
    setSettings: (patch: Record<string, string>) => Object.assign(mockDb.settings, patch),
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

import {
    cancelPendingQuestion,
    forceQuestion,
    listPendingQuestions,
    registerForceQuestionIpc,
    setQuestionTransport,
} from '../force-question';

/**
 * Resolve every raised question so a test's promise cannot dangle.
 *
 * These tests used to end with `w.close(); await done;`, which worked only
 * because closing the modal resolved the whole queue as cancelled. Closing
 * PARKS now — the question survives, on purpose — so closing is no longer a
 * way to settle anything. Nothing here is about close semantics; they are
 * about drawer geometry and link routing, so they say `cancel` and mean it.
 */
function drain(): void {
    for (const q of listPendingQuestions()) cancelPendingQuestion(q.id);
}
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

        drain();
        await done;
    });

    /**
     * The drawer's own width must never become "the size the user chose".
     *
     * `e2e/ask-modal.spec.ts` caught this on macOS and nowhere else, four times in
     * a day, as a 30s timeout waiting for the window to give the width back after
     * the drawer closed. It is not a flake and it is not macOS: genie#703 made the
     * modal resizable and remembers the size on `resize`, and Electron fires
     * `resize` for the drawer's OWN programmatic `setBounds`. So opening the
     * drawer saves the widened width, closing it reads that back as the width to
     * return to, and the window stays wide — after which every question on that
     * machine opens drawer-wide for ever, until someone finds the setting.
     *
     * The 400ms debounce is why it looked like a race: whether the write landed
     * before the close depended on how long the test in between took, and the long
     * drawer test is the one that takes longest.
     */
    it('does not remember the drawer width as the size the user chose', async () => {
        vi.useFakeTimers();
        try {
            const { w, done } = openModal();
            expect(w.bounds.width).toBe(ASK_MODAL_WIDTH);

            setDrawer(w.id, true);
            expect(w.bounds.width).toBe(ASK_MODAL_WIDTH + ASK_DRAWER_WIDTH);
            // Let the debounced save run while the drawer is open — the E2E spends
            // seconds here measuring the pane, so in the product it always does.
            vi.advanceTimersByTime(1000);
            expect(mockDb.settings.ask_modal_size).not.toContain(
                String(ASK_MODAL_WIDTH + ASK_DRAWER_WIDTH),
            );

            setDrawer(w.id, false);
            expect(w.bounds.width).toBe(ASK_MODAL_WIDTH);

            drain();
            await done;
        } finally {
            vi.useRealTimers();
        }
    });

    /**
     * The positive control for the test above, and the genie#703 behaviour it must
     * not undo: a size the user REALLY chose is still what the drawer widens from
     * and shrinks back to. Suppressing the drawer's own resize by suppressing the
     * remembering altogether would pass the test above and break this one.
     */
    it('still widens from — and returns to — a size the user chose', async () => {
        vi.useFakeTimers();
        try {
            const { w, done } = openModal();

            // The user drags the window wider. This is a resize the modal did not
            // ask for, so it is theirs to keep.
            w.bounds = { ...w.bounds, width: 900 };
            for (const fn of w.resizeHandlers) fn();
            vi.advanceTimersByTime(1000);
            expect(mockDb.settings.ask_modal_size).toContain('900');

            setDrawer(w.id, true);
            expect(w.bounds.width).toBe(900 + ASK_DRAWER_WIDTH);
            vi.advanceTimersByTime(1000);

            setDrawer(w.id, false);
            expect(w.bounds.width).toBe(900);

            drain();
            await done;
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves the question where it is, vertically', async () => {
        const { w, done } = openModal();
        const { y, height } = w.bounds;
        setDrawer(w.id, true);
        expect(w.bounds.y).toBe(y);
        expect(w.bounds.height).toBe(height);
        drain();
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
        drain();
        await done;
    });

    it('ignores a drawer call from a window that is not the modal', async () => {
        const { w, done } = openModal();
        const width = w.bounds.width;
        setDrawer(w.id + 999, true);
        expect(w.bounds.width).toBe(width);
        drain();
        await done;
    });

    it('carries the workspace root to the modal, so a named file can be opened', async () => {
        const { w, done } = openModal();
        // Without this the chips render nothing to click: the renderer refuses to
        // resolve a path when it does not know which workspace to resolve it in.
        const { listPendingQuestions } = await import('../force-question');
        expect(listPendingQuestions()[0]?.workspacePath).toBe('/work/space');
        drain();
        await done;
    });
});
