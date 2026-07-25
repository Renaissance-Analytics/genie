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
    /** Captured `ask:queue` pushes (PendingQuestions v2 — the full queue view). */
    queues: Array<{
        pending: Array<{
            id: string;
            priority?: string;
            index: number;
            workspaceLabel?: string;
            questions: ForceQuestion[];
        }>;
    }>;
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
    /** When set, the NEXT BrowserWindow construction throws (simulates a display
     *  failure) — for the "modal can't be shown → inbox, not false-dismiss" test.
     *  Auto-clears after firing. */
    throwOnCreate?: boolean;
} = { windows: [], nextWcId: 1, ipc: new Map() };

vi.mock('electron', () => {
    class BrowserWindow {
        static getAllWindows(): unknown[] {
            return [];
        }
        constructor() {
            if (state.throwOnCreate) {
                state.throwOnCreate = false;
                throw new Error('no display available');
            }
            const wcId = state.nextWcId++;
            const self = this as unknown as FakeWin;
            self.id = wcId;
            self.shown = [];
            self.queues = [];
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
                    } else if (channel === 'ask:queue') {
                        self.queues.push(payload as FakeWin['queues'][number]);
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
    listPendingQuestions,
    answerPendingQuestion,
    setAvailabilityReader,
    setQuestionTransport,
    setDeferredAnswerSink,
} from '../force-question';
import type { ForceAnswer } from '../../mcp/protocol';

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

    it('pushes the FULL pending queue (priority-ordered, head first) to the window (v2)', async () => {
        const pA = forceQuestion(Q('A'), 'ws-a'); // head (normal)
        const pB = forceQuestion(Q('B'), 'ws-b'); // normal
        const pC = forceQuestion(Q('C'), 'ws-c', 'urgent'); // urgent → jumps ahead of B, behind head

        const pending = win().queues[win().queues.length - 1].pending;
        // Head A is protected; urgent C is answered before normal B.
        expect(pending.map((q) => q.questions[0].header)).toEqual(['A', 'C', 'B']);
        expect(pending[0].workspaceLabel).toBe('ws-a');
        expect(pending[1].priority).toBe('urgent');
        win().close();
        await Promise.all([pA, pB, pC]);
    });

    it('refreshes the queue when a non-head item is answered out of order (user-controlled flow)', async () => {
        const pA = forceQuestion(Q('A'));
        const pB = forceQuestion(Q('B'));
        const pC = forceQuestion(Q('C'));

        // The user picks the queued B (not the head) and answers it.
        const bId = win()
            .queues[win().queues.length - 1].pending.find((q) => q.questions[0].header === 'B')!.id;
        await invokeIpc('ask:answer', win().id, bId, [
            { header: 'B', question: 'B?', selected: ['Yes'], note: '' },
        ]);

        const pending = win().queues[win().queues.length - 1].pending;
        expect(pending.map((q) => q.questions[0].header)).toEqual(['A', 'C']); // B gone, head A unchanged
        win().close();
        await Promise.all([pA, pB, pC]);
    });

    it('a forwarded host question carries its priority + remote-host attribution (v2 §8)', async () => {
        const p = raiseForwardedQuestion({
            connKey: 'c1',
            hostId: 'h1',
            questions: Q('Deploy'),
            workspaceLabel: 'the-good-flood',
            priority: 'urgent',
            remoteHost: 'fcee07.geniecloud.link',
        });
        const item = listPendingQuestions().find((q) => q.questions[0].header === 'Deploy')!;
        expect(item.priority).toBe('urgent');
        expect(item.remoteHost).toBe('fcee07.geniecloud.link'); // labeled as a REMOTE host
        // A LOCAL question has no remoteHost, so the UI never mislabels it.
        const pLocal = forceQuestion(Q('Local'));
        const local = listPendingQuestions().find((q) => q.questions[0].header === 'Local')!;
        expect(local.remoteHost).toBeUndefined();
        win().close();
        await Promise.all([p, pLocal]);
    });

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
            undefined, // priority defaults to normal (PendingQuestions v2)
            undefined, // scope (PendingQuestions UX) — none passed here
            undefined, // askerTerminalId — none passed here (internal gate)
        );
        // The headless transport raised NO modal (the GUI path is fully bypassed).
        expect(state.windows).toHaveLength(0);
    });

    it('threads the request priority through to the transport (PendingQuestions v2)', async () => {
        const ask = vi.fn().mockResolvedValue({ cancelled: true, answers: [] });
        setQuestionTransport({ ask });
        await forceQuestion(Q('Deploy?'), 'ws', 'urgent');
        expect(ask).toHaveBeenCalledWith(expect.any(Array), 'ws', 'urgent', undefined, undefined);
    });

    it('defaults to the desktop modal when no transport is installed', () => {
        setQuestionTransport(null);
        void forceQuestion(Q('A'));
        expect(state.windows).toHaveLength(1); // the BrowserWindow modal
        win().close();
    });
});

// --- PendingQuestions UX — DND availability ---------------------------------
describe('ForceTheQuestion DND availability', () => {
    beforeEach(() => {
        setQuestionTransport(null); // desktop modal transport (the DND path lives here)
        registerForceQuestionIpc({ isDev: false, preloadPath: '/p.js', getMasterWindow: () => null });
    });
    afterEach(() => {
        setAvailabilityReader(null); // restore the settings-backed reader
        setDeferredAnswerSink(null); // restore no deferred-answer delivery
        // Clear anything left in the inbox (deferred + queue) so tests don't leak.
        for (const p of listPendingQuestions()) answerPendingQuestion(p.id, []);
        vi.clearAllMocks();
    });

    it('DND: delivers the answer back to the asking agent on answer (ping/poll/pull), and marks the result deferred', async () => {
        setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'heads-down' }));
        const delivered: Array<{ terminalId: string; questionId: string; answers: ForceAnswer[] }> =
            [];
        setDeferredAnswerSink((d) => delivered.push(d));

        // An agent on terminal T1 asks under DND: it defers + resolves at once
        // (never blocks), carrying the questionId so the agent can correlate the
        // pulled answer.
        const result = await forceQuestion(Q('Ship?'), 'Wonder', 'normal', { workspaceId: 'ws1' }, 'T1');
        expect(result.cancelled).toBe(true);
        expect(result.deferred).toBe(true);
        expect(result.questionId).toBeTruthy();
        // Nothing delivered yet — the user hasn't answered.
        expect(delivered).toHaveLength(0);

        // The user answers it in the flyout → the answer is delivered to the ASKING
        // terminal (which pulls it from its AgentInbox). This is the bug: it used to
        // be dropped because the local deferral stored no delivery handle.
        const row = listPendingQuestions().find((p) => p.workspaceLabel === 'Wonder')!;
        const answers: ForceAnswer[] = [
            { header: 'Ship?', question: 'Ship?', selected: ['Yes'], note: 'go' },
        ];
        expect(answerPendingQuestion(row.id, answers)).toBe(true);

        expect(delivered).toHaveLength(1);
        expect(delivered[0].terminalId).toBe('T1');
        expect(delivered[0].questionId).toBe(result.questionId);
        expect(delivered[0].answers[0].selected).toEqual(['Yes']);
        expect(delivered[0].answers[0].note).toBe('go');
    });

    it('DND with NO asking terminal (a local approval gate) never invokes the sink', async () => {
        setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        let calls = 0;
        setDeferredAnswerSink(() => {
            calls += 1;
        });
        // No terminalId: an internal gate, not an MCP ForceTheQuestion — the DND
        // result stays a plain cancelled, and there's no agent to deliver back to.
        await forceQuestion(Q('Gate'), 'GateWs', 'normal', { workspaceId: 'ws1' });
        const row = listPendingQuestions().find((p) => p.workspaceLabel === 'GateWs')!;
        answerPendingQuestion(row.id, [{ header: 'Gate', question: 'Gate', selected: [], note: '' }]);
        expect(calls).toBe(0);
    });

    it('DND: resolves immediately with the notice, NEVER opens a modal, and drops into the inbox as deferred', async () => {
        setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'heads-down; hold off' }));
        const before = state.windows.length;

        const result = await forceQuestion(Q('A'), 'Wonder', 'normal', { workspaceId: 'ws1' });

        // The agent gets the DND notice back at once — not blocked on a modal.
        expect(result.cancelled).toBe(true);
        expect(result.dndMessage).toBe('heads-down; hold off');
        expect(state.windows.length).toBe(before); // no window created
        // ...and the question is in the inbox, flagged deferred, with its workspace.
        const row = listPendingQuestions().find((p) => p.workspaceLabel === 'Wonder');
        expect(row?.deferred).toBe(true);
        expect(row?.questions[0].header).toBe('A');
    });

    it('answering a DND-deferred question from the inbox clears it', async () => {
        setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        await forceQuestion(Q('B'), 'Box', 'normal', { workspaceId: 'ws1' });
        const row = listPendingQuestions().find((p) => p.workspaceLabel === 'Box');
        expect(row).toBeDefined();

        expect(answerPendingQuestion(row!.id, [])).toBe(true);
        expect(listPendingQuestions().some((p) => p.id === row!.id)).toBe(false);
    });

    it('Available still pops the modal — DND is strictly opt-in per scope', () => {
        setAvailabilityReader(() => ({ availability: 'available', dndMessage: 'x' }));
        const before = state.windows.length;
        void forceQuestion(Q('C'), 'ws', 'normal', { workspaceId: 'ws1' });
        expect(state.windows.length).toBe(before + 1); // the modal opened
        win().close();
    });

    it('a modal that CANNOT be shown routes to the inbox with a notice — never a false "dismissed"', async () => {
        setAvailabilityReader(() => ({ availability: 'available', dndMessage: 'x' }));
        state.throwOnCreate = true; // the next createAskWindow throws (no display)
        const before = state.windows.length;

        const result = await forceQuestion(Q('D'), 'Workspace', 'normal', { workspaceId: 'ws1' });

        // The agent gets a NOTICE, not a bogus "user dismissed" (the finding).
        expect(result.cancelled).toBe(true);
        expect(result.dndMessage).toMatch(/could not be shown/i);
        expect(state.windows.length).toBe(before); // no window ever opened
        // ...and it's answerable in the inbox rather than silently lost.
        const row = listPendingQuestions().find((p) => p.workspaceLabel === 'Workspace');
        expect(row?.deferred).toBe(true);
    });
});

// --- PendingQuestions UX — per-remote-host (workstation) DND -----------------
// A CLIENT-side, workstation-scoped setting: when the DRIVER has a connected host
// set to DND, that host's FORWARDED questions never pop the driver's modal — they
// wait in the inbox, still answerable (the answer routes back to the host).
describe('forwarded question DND (per-remote-host availability)', () => {
    beforeEach(() => {
        for (const w of state.windows) if (!w.destroyed) w.close();
        state.windows = [];
        state.nextWcId = 1;
        setQuestionTransport(null);
        registerForceQuestionIpc({ isDev: false, preloadPath: '/p.js', getMasterWindow: () => null });
    });
    afterEach(() => {
        setAvailabilityReader(null);
        for (const p of listPendingQuestions()) answerPendingQuestion(p.id, []);
        vi.clearAllMocks();
    });

    it("resolves availability with the HOST's workstationId (its connKey)", async () => {
        const seen: Array<{ workstationId?: string; workspaceId?: string }> = [];
        setAvailabilityReader((scope) => {
            seen.push(scope);
            return { availability: 'available', dndMessage: 'x' };
        });
        const p = raiseForwardedQuestion({
            connKey: 'host:abc',
            hostId: 'Q1',
            questions: Q('Go'),
            workstationId: 'host:abc',
        });
        expect(seen[0]?.workstationId).toBe('host:abc');
        win().close();
        await p;
    });

    it('host in DND: no modal — lands in the inbox as a deferred REMOTE question, and the answer routes back', async () => {
        setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        const before = state.windows.length;
        const p = raiseForwardedQuestion({
            connKey: 'host:abc',
            hostId: 'Q2',
            questions: Q('Deploy'),
            remoteHost: 'abc.geniecloud.link',
            workstationId: 'host:abc',
        });
        expect(state.windows.length).toBe(before); // never popped a modal on the driver
        const row = listPendingQuestions().find((r) => r.questions[0].header === 'Deploy');
        expect(row?.deferred).toBe(true);
        expect(row?.remoteHost).toBe('abc.geniecloud.link'); // attributed to the host, not local

        // Answering from the inbox resolves the bridged promise WITH the answer, so
        // the remote bridge POSTs it back to the host (result NOT cancelled).
        answerPendingQuestion(row!.id, [
            { header: 'Deploy', question: 'Deploy?', selected: ['Yes'], note: '' },
        ]);
        const r = await p;
        expect(r.cancelled).toBe(false);
        expect(r.answers[0].selected).toEqual(['Yes']);
    });

    it('host in DND, then the host answers first: dismiss resolves cancelled + clears the inbox', async () => {
        setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        const p = raiseForwardedQuestion({
            connKey: 'host:abc',
            hostId: 'Q3',
            questions: Q('X'),
            workstationId: 'host:abc',
        });
        expect(listPendingQuestions().some((r) => r.questions[0].header === 'X')).toBe(true);
        dismissForwardedQuestion('host:abc', 'Q3');
        const r = await p;
        expect(r.cancelled).toBe(true); // host already answered — nothing POSTed back
        expect(listPendingQuestions().some((r) => r.questions[0].header === 'X')).toBe(false);
    });

    it('Available host still pops the modal (DND is opt-in per workstation)', () => {
        setAvailabilityReader(() => ({ availability: 'available', dndMessage: 'x' }));
        const before = state.windows.length;
        void raiseForwardedQuestion({
            connKey: 'host:abc',
            hostId: 'Q4',
            questions: Q('Y'),
            workstationId: 'host:abc',
        });
        expect(state.windows.length).toBe(before + 1);
        win().close();
    });
});
