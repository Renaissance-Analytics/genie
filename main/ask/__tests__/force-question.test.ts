import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForceQuestion } from '../../mcp/protocol';

/**
 * ForceTheQuestion FIFO queue.
 *
 * Genie is multi-agent, so concurrent `forceQuestion(...)` calls must be
 * presented ONE AT A TIME through a single shared modal window: the first opens
 * it, later ones enqueue, and each answer/cancel/dismiss advances to the next.
 * Each call's promise must resolve with ITS OWN result. Closing the window
 * cancels every still-queued request.
 *
 * We mock electron's BrowserWindow (capturing `ask:show` payloads + the `closed`
 * handler) and ipcMain (capturing the answer/cancel/dismiss handlers) so we can
 * drive the manager exactly as the renderer would over IPC.
 */

// --- mock state -------------------------------------------------------------
interface FakeWin {
    id: number;
    shown: Array<{ id: string; questions: ForceQuestion[]; queued: number }>;
    closedHandlers: Array<() => void>;
    destroyed: boolean;
    close: () => void;
    webContents: {
        id: number;
        isLoading: () => boolean;
        once: (ev: string, fn: () => void) => void;
        send: (channel: string, payload: unknown) => void;
    };
}

const state: {
    windows: FakeWin[];
    nextWcId: number;
    ipc: Map<string, (...args: unknown[]) => unknown>;
} = { windows: [], nextWcId: 1, ipc: new Map() };

vi.mock('electron', () => {
    class BrowserWindow {
        static getAllWindows(): unknown[] {
            return [];
        }
        constructor() {
            const wcId = state.nextWcId++;
            const self = this as unknown as FakeWin;
            self.id = wcId;
            self.shown = [];
            self.closedHandlers = [];
            self.destroyed = false;
            self.webContents = {
                id: wcId,
                isLoading: () => false,
                once: () => {},
                send: (channel: string, payload: unknown) => {
                    if (channel === 'ask:show') {
                        self.shown.push(
                            payload as {
                                id: string;
                                questions: ForceQuestion[];
                                queued: number;
                            },
                        );
                    }
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
        ipcMain: {
            handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
                state.ipc.set(channel, fn);
            },
        },
    };
});

// notify chime reads settings — keep it inert so it never throws/sends.
vi.mock('../../db', () => ({ getAllSettings: () => ({ notify_sound: 'off' }) }));

import {
    forceQuestion,
    registerForceQuestionIpc,
    raiseForwardedQuestion,
    dismissForwardedQuestion,
    setQuestionTransport,
} from '../force-question';

/** Simulate the renderer for the currently-shown window: answer / cancel / dismiss. */
function invokeIpc(channel: string, senderWcId: number, ...args: unknown[]) {
    const fn = state.ipc.get(channel);
    if (!fn) throw new Error(`no ipc handler for ${channel}`);
    return fn({ sender: { id: senderWcId } }, ...args);
}

const Q = (header: string): ForceQuestion[] => [
    { header, question: `${header}?`, options: [{ label: 'Yes' }, { label: 'No' }] },
];

/** The single shared window (last created). */
function win(): FakeWin {
    return state.windows[state.windows.length - 1];
}

describe('ForceTheQuestion FIFO queue', () => {
    beforeEach(() => {
        state.windows = [];
        state.nextWcId = 1;
        // Register once — the manager guards re-registration, and the ipc
        // handlers are stable across tests, so we keep them (don't clear).
        registerForceQuestionIpc({
            isDev: false,
            preloadPath: '/preload.js',
            getMasterWindow: () => null,
        });
    });
    afterEach(() => vi.clearAllMocks());

    it('shows the first request immediately with no items queued behind it', async () => {
        const p = forceQuestion(Q('A'));
        expect(state.windows).toHaveLength(1);
        expect(win().shown).toHaveLength(1);
        expect(win().shown[0].questions[0].header).toBe('A');
        expect(win().shown[0].queued).toBe(0);
        win().close(); // drain so module state doesn't leak into the next test
        await p;
    });

    it('queues a second concurrent request instead of opening a second window', async () => {
        const pA = forceQuestion(Q('A'));
        const pB = forceQuestion(Q('B'));
        // Still ONE window — the second request is queued, not a new modal.
        expect(state.windows).toHaveLength(1);
        // The badge on the shown request updates to reflect the new arrival.
        const last = win().shown[win().shown.length - 1];
        expect(last.questions[0].header).toBe('A');
        expect(last.queued).toBe(1);
        win().close();
        await Promise.all([pA, pB]);
    });

    it('resolves each request with its OWN result, in FIFO order', async () => {
        const pA = forceQuestion(Q('A'));
        const pB = forceQuestion(Q('B'));

        const aId = win().shown[0].id;
        await invokeIpc('ask:answer', win().id, aId, [
            { header: 'A', question: 'A?', selected: ['Yes'], note: '' },
        ]);
        const rA = await pA;
        expect(rA.cancelled).toBe(false);
        expect(rA.answers[0].selected).toEqual(['Yes']);

        // B is now the head, shown in the SAME window, with nothing queued behind.
        const shownB = win().shown[win().shown.length - 1];
        expect(shownB.questions[0].header).toBe('B');
        expect(shownB.queued).toBe(0);

        await invokeIpc('ask:answer', win().id, shownB.id, [
            { header: 'B', question: 'B?', selected: ['No'], note: 'later' },
        ]);
        const rB = await pB;
        expect(rB.cancelled).toBe(false);
        expect(rB.answers[0].selected).toEqual(['No']);
        expect(rB.answers[0].note).toBe('later');
    });

    it('dismiss cancels the shown request and advances to the next', async () => {
        const pA = forceQuestion(Q('A'));
        const pB = forceQuestion(Q('B'));

        await invokeIpc('ask:dismiss', win().id);
        const rA = await pA;
        expect(rA.cancelled).toBe(true);

        // B advances into the same window.
        const shownB = win().shown[win().shown.length - 1];
        expect(shownB.questions[0].header).toBe('B');

        await invokeIpc('ask:cancel', win().id, shownB.id);
        const rB = await pB;
        expect(rB.cancelled).toBe(true);
    });

    it('closing the window cancels EVERY still-queued request', async () => {
        const pA = forceQuestion(Q('A'));
        const pB = forceQuestion(Q('B'));
        const pC = forceQuestion(Q('C'));

        // OS/window-control close of the shared modal.
        win().close();

        const [rA, rB, rC] = await Promise.all([pA, pB, pC]);
        expect(rA.cancelled).toBe(true);
        expect(rB.cancelled).toBe(true);
        expect(rC.cancelled).toBe(true);
    });

    it('answering the last request closes the shared window', async () => {
        const pA = forceQuestion(Q('A'));
        const aId = win().shown[0].id;
        await invokeIpc('ask:answer', win().id, aId, []);
        await pA;
        expect(win().destroyed).toBe(true);

        // A fresh request after the queue drained opens a NEW window.
        void forceQuestion(Q('B'));
        expect(state.windows).toHaveLength(2);
        expect(state.windows[1].destroyed).toBe(false);
    });
});

describe('forwarded questions (remote-driver forwarding)', () => {
    beforeEach(() => {
        // Drain any modal/queue a prior describe's last test left open (closing
        // the window cancels every still-queued item) so the module starts clean.
        for (const w of state.windows) if (!w.destroyed) w.close();
        state.windows = [];
        state.nextWcId = 1;
        registerForceQuestionIpc({
            isDev: false,
            preloadPath: '/preload.js',
            getMasterWindow: () => null,
        });
    });
    afterEach(() => vi.clearAllMocks());

    it('raises a local modal for a forwarded host question and resolves the answer', async () => {
        const p = raiseForwardedQuestion({
            connKey: 'host-1',
            hostId: 'Q1',
            questions: Q('Proceed'),
            workspaceLabel: 'demo',
        });
        // The driver sees the modal locally.
        expect(state.windows).toHaveLength(1);
        expect(win().shown[0].questions[0].header).toBe('Proceed');
        // The driver answers → the promise resolves with the answer, which the
        // remote bridge POSTs back to the host.
        const localId = win().shown[0].id;
        await invokeIpc('ask:answer', win().id, localId, [
            { header: 'Proceed', question: 'Proceed?', selected: ['Yes'], note: '' },
        ]);
        const r = await p;
        expect(r.cancelled).toBe(false);
        expect(r.answers[0].selected).toEqual(['Yes']);
    });

    it('dismissForwardedQuestion (host answered first) resolves cancelled → no answer posted', async () => {
        const p = raiseForwardedQuestion({
            connKey: 'host-1',
            hostId: 'Q2',
            questions: Q('Proceed'),
        });
        expect(state.windows).toHaveLength(1);
        // Host resolved it out from under us → dismiss the local modal.
        dismissForwardedQuestion('host-1', 'Q2');
        const r = await p;
        // cancelled ⇒ the bridge posts NOTHING back (host already has the answer).
        expect(r.cancelled).toBe(true);
        expect(win().destroyed).toBe(true);
    });

    it('dismissForwardedQuestion is keyed by (connKey, hostId) — leaves others alone', async () => {
        const pA = raiseForwardedQuestion({ connKey: 'host-1', hostId: 'Q3', questions: Q('A') });
        const pB = raiseForwardedQuestion({ connKey: 'host-2', hostId: 'Q3', questions: Q('B') });
        // Same hostId on a DIFFERENT connection must not be dismissed.
        dismissForwardedQuestion('host-1', 'Q3');
        const rA = await pA;
        expect(rA.cancelled).toBe(true);
        // B (host-2) still pending — answer it to drain.
        const shownB = win().shown[win().shown.length - 1];
        expect(shownB.questions[0].header).toBe('B');
        await invokeIpc('ask:answer', win().id, shownB.id, [
            { header: 'B', question: 'B?', selected: ['No'], note: '' },
        ]);
        const rB = await pB;
        expect(rB.cancelled).toBe(false);
    });
});

describe('QuestionTransport routing (host-core decouple)', () => {
    beforeEach(() => {
        for (const w of state.windows) if (!w.destroyed) w.close();
        state.windows = [];
        state.nextWcId = 1;
        registerForceQuestionIpc({ isDev: false, preloadPath: '/p.js', getMasterWindow: () => null });
    });
    afterEach(() => {
        setQuestionTransport(null); // restore the desktop modal default
        vi.clearAllMocks();
    });

    it('routes forceQuestion through an installed transport — NO BrowserWindow', async () => {
        const ask = vi.fn().mockResolvedValue({ cancelled: true, answers: [] });
        setQuestionTransport({ ask });
        const r = await forceQuestion(Q('Proceed'), 'demo');
        expect(r).toEqual({ cancelled: true, answers: [] });
        expect(ask).toHaveBeenCalledWith(
            [expect.objectContaining({ header: 'Proceed' })],
            'demo',
        );
        // The headless transport raised NO modal (the GUI path is fully bypassed).
        expect(state.windows).toHaveLength(0);
    });

    it('defaults to the desktop modal when no transport is installed', () => {
        setQuestionTransport(null);
        void forceQuestion(Q('A'));
        expect(state.windows).toHaveLength(1); // the BrowserWindow modal
        win().close();
    });
});
