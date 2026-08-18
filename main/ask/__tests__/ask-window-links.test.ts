import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForceQuestion } from '../../mcp/protocol';

/**
 * The ForceTheQuestion modal window is actually GUARDED against link navigation
 * (genie#196).
 *
 * `link-route.test.ts` proves the routing decision and the wiring in isolation,
 * against a fake webContents. Nothing proved the two were connected: delete the
 * `wireAskLinkRouting(...)` call from `createAskWindow` and every one of those
 * cases still passes while the bug is fully back — a link in the question markdown
 * navigates the frameless, always-on-top modal, turning it into a browser tab and
 * stranding the question.
 *
 * So this drives the REAL path: raise a question, take the handlers the modal
 * installed on its own webContents, and click a link through them.
 */

interface FakeWin {
    id: number;
    destroyed: boolean;
    closedHandlers: Array<() => void>;
    close: () => void;
    /** The `will-navigate` listener the modal installed, if it installed one. */
    onWillNavigate?: (e: { preventDefault: () => void }, url: string) => void;
    /** The window-open handler the modal installed, if it installed one. */
    onWindowOpen?: (d: { url: string }) => { action: string };
    webContents: Record<string, unknown>;
}

const state: { windows: FakeWin[]; nextId: number } = { windows: [], nextId: 1 };
const shellMock = vi.hoisted(() => ({ openExternal: vi.fn(() => Promise.resolve()) }));

vi.mock('electron', () => {
    class BrowserWindow {
        static getAllWindows(): unknown[] {
            return [];
        }
        constructor() {
            const self = this as unknown as FakeWin;
            self.id = state.nextId++;
            self.destroyed = false;
            self.closedHandlers = [];
            self.webContents = {
                id: self.id,
                isLoading: () => false,
                once: () => {},
                send: () => {},
                getURL: () => 'http://localhost:8888/ask',
                on: (ev: string, fn: (e: { preventDefault: () => void }, url: string) => void) => {
                    if (ev === 'will-navigate') self.onWillNavigate = fn;
                },
                setWindowOpenHandler: (fn: (d: { url: string }) => { action: string }) => {
                    self.onWindowOpen = fn;
                },
            };
            state.windows.push(self);
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
        ipcMain: { handle: () => {} },
        shell: shellMock,
    };
});

const mockDb = vi.hoisted(() => ({
    settings: { notify_sound: 'off' } as Record<string, string>,
}));
vi.mock('../../db', () => ({ getAllSettings: () => mockDb.settings }));
vi.mock('../../notify-sound', () => ({
    resolveAlertSound: () => null,
    deliverAlertSound: () => {},
}));
const browserMock = vi.hoisted(() => ({
    open: vi.fn((..._a: unknown[]) => Promise.resolve()),
}));
vi.mock('../../testing-browser', () => ({
    LOCAL_CONN_KEY: 'local',
    openTestingBrowser: (...a: unknown[]) => browserMock.open(...a),
}));

import { forceQuestion, registerForceQuestionIpc, setQuestionTransport } from '../force-question';

const Q = (header: string): ForceQuestion[] => [
    { header, question: `${header}?`, options: [{ label: 'Yes' }] },
];

/** Raise a question and hand back the modal window it opened. */
function openModal(): { w: FakeWin; done: Promise<unknown> } {
    const done = forceQuestion(Q('Pick'));
    const w = state.windows[state.windows.length - 1];
    return { w, done };
}

/** Click a link in the question markdown; reports whether the modal navigated. */
function clickLink(w: FakeWin, url: string): { navigated: boolean } {
    if (!w.onWillNavigate) {
        // No guard installed at all — the modal navigates, which IS the bug.
        return { navigated: true };
    }
    let prevented = false;
    w.onWillNavigate({ preventDefault: () => (prevented = true) }, url);
    return { navigated: !prevented };
}

describe('the ForceTheQuestion modal window guards its links (genie#196)', () => {
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

    it('never navigates the modal to a web link — it opens the machine browser', async () => {
        const { w, done } = openModal();
        const { navigated } = clickLink(w, 'https://github.com/Renaissance-Analytics/genie');
        expect(navigated).toBe(false); // the question is still on screen
        expect(shellMock.openExternal).toHaveBeenCalledWith(
            'https://github.com/Renaissance-Analytics/genie',
        );
        w.close();
        await done;
    });

    it('sends a .gen link to the Genie Browser instead of navigating', async () => {
        const { w, done } = openModal();
        const { navigated } = clickLink(w, 'https://civi.gen/status');
        expect(navigated).toBe(false);
        expect(browserMock.open).toHaveBeenCalledWith(
            'local',
            expect.any(String),
            'https://civi.gen/status',
        );
        expect(shellMock.openExternal).not.toHaveBeenCalled();
        w.close();
        await done;
    });

    it('falls back to the machine browser for .gen when the Genie Browser is off', async () => {
        mockDb.settings = { notify_sound: 'off', genie_browser_enabled: 'off' };
        const { w, done } = openModal();
        clickLink(w, 'https://tynn.gen/');
        expect(shellMock.openExternal).toHaveBeenCalledWith('https://tynn.gen/');
        expect(browserMock.open).not.toHaveBeenCalled();
        w.close();
        await done;
    });

    it('drops a non-http(s) link rather than navigating or shelling it out', async () => {
        const { w, done } = openModal();
        const { navigated } = clickLink(w, 'file:///etc/passwd');
        expect(navigated).toBe(false);
        expect(shellMock.openExternal).not.toHaveBeenCalled();
        expect(browserMock.open).not.toHaveBeenCalled();
        w.close();
        await done;
    });

    it('denies target=_blank / window.open and routes the URL instead', async () => {
        const { w, done } = openModal();
        expect(w.onWindowOpen).toBeTypeOf('function');
        expect(w.onWindowOpen!({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
        expect(shellMock.openExternal).toHaveBeenCalledWith('https://example.com/');
        w.close();
        await done;
    });
});
