import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForceQuestion } from '../../mcp/protocol';
import type { PersistedQuestion, QuestionStorePort } from '../question-store';

/**
 * A pending ForceTheQuestion SURVIVES A RESTART, and an interrupted ask can
 * REJOIN instead of duplicating.
 *
 * Two failures, one file, because they are the same failure seen from either
 * end. The queue lived only in memory, so an upgrade, a crash or a killed
 * process erased every pending question: the agent waited forever on an answer
 * that could not arrive, and the human never learned a question had existed.
 * And because nothing keyed an ask, an agent that reconnected could only ask
 * again — a re-ask the user saw as a second, separate question.
 *
 * Same electron mock as force-question.test.ts, so the FIFO queue, the modal
 * window and the IPC handlers are the real ones.
 */

// --- mock state -------------------------------------------------------------
interface FakeWin {
    id: number;
    closedHandlers: Array<() => void>;
    destroyed: boolean;
    close: () => void;
    webContents: {
        id: number;
        isLoading: () => boolean;
        once: () => void;
        send: () => void;
        getURL: () => string;
        on: () => void;
        setWindowOpenHandler: () => void;
    };
}

const state: {
    windows: FakeWin[];
    nextWcId: number;
    ipc: Map<string, (...args: unknown[]) => unknown>;
    /** When set, the NEXT BrowserWindow construction throws (no display). */
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
            self.closedHandlers = [];
            self.destroyed = false;
            self.webContents = {
                id: wcId,
                isLoading: () => false,
                once: () => {},
                send: () => {},
                getURL: () => 'http://localhost:8888/ask',
                on: () => {},
                setWindowOpenHandler: () => {},
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
        powerMonitor: { getSystemIdleTime: () => 0 },
        screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
        shell: { openExternal: () => Promise.resolve() },
    };
});

vi.mock('../../db', () => ({ getAllSettings: () => ({ notify_sound: 'off' }) }));
vi.mock('../../notify-sound', () => ({
    resolveAlertSound: () => null,
    deliverAlertSound: () => {},
    // The chime goes through ONE gate now (genie#546); inert here, like the
    // two above, so these tests are about the modal and not about audio.
    playAlertSound: () => false,
}));

import * as fq from '../force-question';
import type { DeferredAnswerDelivery } from '../force-question';

/**
 * An in-memory stand-in for the genie.db store, enforcing the ONE constraint
 * the real table enforces: `ask_key` is unique, so a second id carrying a key
 * that is already pending is refused rather than stored.
 */
function fakeStore(): QuestionStorePort & { rows: Map<string, PersistedQuestion> } {
    const rows = new Map<string, PersistedQuestion>();
    return {
        rows,
        save(q) {
            const clash = [...rows.values()].some((r) => r.askKey === q.askKey && r.id !== q.id);
            if (clash) return;
            rows.set(q.id, { ...q });
        },
        remove(id) {
            rows.delete(id);
        },
        load() {
            return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt);
        },
    };
}

const Q = (header: string, question = `${header}?`): ForceQuestion[] => [
    { header, question, options: [{ label: 'Yes' }, { label: 'No' }] },
];

function win(): FakeWin {
    return state.windows[state.windows.length - 1];
}

/** Drain everything the module still holds so nothing leaks into the next test. */
function drain(api: typeof fq): void {
    for (const w of state.windows) if (!w.destroyed) w.close();
    for (const p of api.listPendingQuestions()) api.answerPendingQuestion(p.id, []);
}

describe('a pending question is written down as it is raised', () => {
    let store: ReturnType<typeof fakeStore>;

    beforeEach(() => {
        state.windows = [];
        state.nextWcId = 1;
        store = fakeStore();
        fq.setQuestionStore(store);
        fq.setAvailabilityReader(() => ({ availability: 'available', dndMessage: 'x' }));
        fq.registerForceQuestionIpc({
            isDev: false,
            preloadPath: '/preload.js',
            getMasterWindow: () => null,
        });
    });
    afterEach(() => {
        drain(fq);
        fq.setQuestionStore(null);
        fq.setAvailabilityReader(null);
        fq.setDeferredAnswerSink(null);
        fq.setUserPresenceReader(null);
        vi.clearAllMocks();
    });

    it('stores everything the question would have to be rebuilt from', async () => {
        fq.setQuestionClock(() => 1_700_000_000_000);
        await fq.forceQuestion(Q('Ship'), 'Wonder', 'high', { workspaceId: 'ws-1' }, 'T1');
        fq.setQuestionClock(null);

        expect(store.load()).toEqual([
            expect.objectContaining({
                terminalId: 'T1',
                workspaceLabel: 'Wonder',
                workspaceId: 'ws-1',
                priority: 'high',
                deferred: false,
                createdAt: 1_700_000_000_000,
                questions: [expect.objectContaining({ header: 'Ship' })],
            }),
        ]);
    });

    it('stores an MCP ask, and stores NOTHING for an internal approval gate', async () => {
        // The negative half alone would pass if persistence were simply broken,
        // so both halves run in the same test. A gate (a process-run approval,
        // a plugin consent) holds an in-process promise that dies with the
        // process: rehydrating it would ask the human to approve something
        // nobody is waiting on any more.
        //
        // Not awaited — a gate genuinely BLOCKS on the modal (that is the whole
        // difference from an agent ask, which returns at once and collects its
        // answer through AgentInbox). `drain` in afterEach resolves it.
        void fq.forceQuestion(Q('Gate'), 'ws');
        expect(store.load()).toEqual([]);

        await fq.forceQuestion(Q('Agent'), 'ws', 'normal', {}, 'T1');
        expect(store.load().map((q) => q.terminalId)).toEqual(['T1']);
    });

    it('stores nothing for a question FORWARDED from a remote host', async () => {
        // Its promise belongs to a live bridge connection. After a restart there
        // is nothing to POST an answer back through, and the host re-forwards
        // its own pending questions on reconnect — so a stored copy could only
        // ever become a duplicate the driver cannot resolve.
        void fq.raiseForwardedQuestion({
            connKey: 'c1',
            hostId: 'h1',
            questions: Q('Deploy'),
            remoteHost: 'host.example',
        });
        expect(store.load()).toEqual([]);

        // Positive control: a local agent question raised in the same state IS
        // stored, so the emptiness above is a decision, not a dead store.
        await fq.forceQuestion(Q('Local'), 'ws', 'normal', {}, 'T1');
        expect(store.load()).toHaveLength(1);
    });

    it('forgets a question the moment it is answered', async () => {
        await fq.forceQuestion(Q('A'), 'ws', 'normal', {}, 'T1');
        await fq.forceQuestion(Q('B'), 'ws', 'normal', {}, 'T2');
        const a = fq.listPendingQuestions().find((p) => p.questions[0].header === 'A')!;

        fq.answerPendingQuestion(a.id, [
            { header: 'A', question: 'A?', selected: ['Yes'], note: '' },
        ]);

        // An answered question must not come back from the dead on the next
        // boot; B, which is still pending, must.
        expect(store.load().map((q) => q.questions[0].header)).toEqual(['B']);
    });

    it('forgets every question when closing the modal cancels the queue', async () => {
        await fq.forceQuestion(Q('A'), 'ws', 'normal', {}, 'T1');
        await fq.forceQuestion(Q('B'), 'ws', 'normal', {}, 'T2');
        expect(store.load()).toHaveLength(2);

        win().close(); // the user closed the window: every queued ask is cancelled

        // They were resolved, not lost — resurrecting them would re-ask
        // questions the user has already refused.
        expect(store.load()).toEqual([]);
    });

    it('stores a DND-deferred question flagged as deferred', async () => {
        fq.setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'heads-down' }));
        await fq.forceQuestion(Q('Ship'), 'ws', 'normal', { workspaceId: 'ws-1' }, 'T1');
        expect(store.load()[0]).toMatchObject({ deferred: true, deferralReason: 'dnd' });
    });

    it('stores an unshowable question flagged as deferred, not as a live modal', async () => {
        state.throwOnCreate = true;
        await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        expect(store.load()[0]).toMatchObject({ deferred: true, deferralReason: 'unshowable' });
    });
});

describe('re-attaching to an ask that was interrupted', () => {
    let store: ReturnType<typeof fakeStore>;

    beforeEach(() => {
        state.windows = [];
        state.nextWcId = 1;
        store = fakeStore();
        fq.setQuestionStore(store);
        fq.setAvailabilityReader(() => ({ availability: 'available', dndMessage: 'x' }));
        fq.registerForceQuestionIpc({
            isDev: false,
            preloadPath: '/preload.js',
            getMasterWindow: () => null,
        });
    });
    afterEach(() => {
        drain(fq);
        fq.setQuestionStore(null);
        fq.setAvailabilityReader(null);
        fq.setDeferredAnswerSink(null);
        vi.clearAllMocks();
    });

    it('the same agent asking the same thing twice rejoins ONE question', async () => {
        const first = await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        const again = await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');

        expect(again.questionId).toBe(first.questionId);
        expect(again.deferred).toBe(true);
        // The human sees ONE question, not two — the whole point.
        expect(fq.listPendingQuestions()).toHaveLength(1);
        expect(store.load()).toHaveLength(1);
        // And no second modal was raised over the one they are already reading.
        expect(state.windows).toHaveLength(1);
    });

    it('says it rejoined rather than pretending the question is new', async () => {
        const first = await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        const again = await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        expect(again.dndMessage).toMatch(/already asked|re-?join/i);
        expect(again.questionId).toBe(first.questionId);
    });

    it('a DIFFERENT question from the same agent is a second question', async () => {
        await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        await fq.forceQuestion(Q('Deploy'), 'ws', 'normal', {}, 'T1');
        expect(fq.listPendingQuestions()).toHaveLength(2);
    });

    it('the same question from a DIFFERENT agent is a second question', async () => {
        // Two agents can genuinely need the same decision. The key carries the
        // terminal precisely so their asks never collapse into one — each has
        // its own answer to receive.
        await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T2');
        expect(fq.listPendingQuestions()).toHaveLength(2);
    });

    it('an internal gate never rejoins — it has no terminal to key on', async () => {
        // Two identical approval prompts are two separate decisions (run this
        // process, then run it again), and each has its own caller waiting.
        void fq.forceQuestion(Q('Run'), 'ws');
        void fq.forceQuestion(Q('Run'), 'ws');
        expect(fq.listPendingQuestions()).toHaveLength(2);
    });

    it('once answered, the same question can be asked again as a NEW question', async () => {
        const first = await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        fq.answerPendingQuestion(first.questionId!, []);
        const second = await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        // A key that collapsed asks forever would make a recurring question
        // unaskable after the first time.
        expect(second.questionId).not.toBe(first.questionId);
        expect(fq.listPendingQuestions()).toHaveLength(1);
    });
});

describe('rebuilding the queue after a restart', () => {
    let store: ReturnType<typeof fakeStore>;

    beforeEach(() => {
        state.windows = [];
        state.nextWcId = 1;
        store = fakeStore();
        fq.setQuestionStore(store);
        fq.setAvailabilityReader(() => ({ availability: 'available', dndMessage: 'x' }));
        fq.registerForceQuestionIpc({
            isDev: false,
            preloadPath: '/preload.js',
            getMasterWindow: () => null,
        });
    });
    afterEach(() => {
        drain(fq);
        fq.setQuestionStore(null);
        fq.setAvailabilityReader(null);
        fq.setDeferredAnswerSink(null);
        vi.clearAllMocks();
    });

    /** A stored question as the previous run would have left it. */
    const stored = (over: Partial<PersistedQuestion> = {}): PersistedQuestion => ({
        id: 'q-old',
        askKey: 'KEY-OLD',
        terminalId: 'T1',
        questions: Q('Ship'),
        workspaceLabel: 'Wonder',
        priority: 'high',
        deferred: false,
        createdAt: 1_700_000_000_000,
        ...over,
    });

    it('brings a stored question back into the inbox, intact and without a modal', () => {
        store.save(stored());
        const result = fq.rehydratePendingQuestions(() => true);

        expect(result).toEqual({ restored: 1, dropped: 0 });
        const [row] = fq.listPendingQuestions();
        expect(row).toMatchObject({
            id: 'q-old',
            workspaceLabel: 'Wonder',
            priority: 'high',
            createdAt: 1_700_000_000_000,
            deferred: true,
        });
        expect(row.questions[0].header).toBe('Ship');
        // Boot is the worst possible moment to throw always-on-top modals at
        // someone: they may not even be at the machine, and there could be
        // several. A rebuilt question waits in the inbox instead.
        expect(state.windows).toHaveLength(0);
    });

    it('DROPS a question whose terminal is gone, and keeps one whose terminal is not', () => {
        store.save(stored({ id: 'live', askKey: 'K-LIVE', terminalId: 'T-LIVE' }));
        store.save(stored({ id: 'dead', askKey: 'K-DEAD', terminalId: 'T-DEAD' }));

        const result = fq.rehydratePendingQuestions((t) => t === 'T-LIVE');

        expect(result).toEqual({ restored: 1, dropped: 1 });
        // The dead one is not in the inbox — asking the human for an answer that
        // has nowhere to go is exactly the failure ForceTheQuestion already
        // refuses at ask time (genie#321).
        expect(fq.listPendingQuestions().map((p) => p.id)).toEqual(['live']);
        // ...and it is gone from the store too, so it does not queue up again on
        // every subsequent boot forever.
        expect(store.load().map((q) => q.id)).toEqual(['live']);
    });

    it('keeps a row it cannot judge, instead of deleting it on a failed lookup', () => {
        store.save(stored({ id: 'unknowable', askKey: 'K-?', terminalId: 'T-?' }));
        store.save(stored({ id: 'live', askKey: 'K-LIVE', terminalId: 'T-LIVE' }));

        const result = fq.rehydratePendingQuestions((t) => {
            if (t === 'T-?') throw new Error('database is busy');
            return true;
        });

        // "Cannot tell" is not "cannot deliver". Dropping is permanent, and a
        // real pending question lost to a transient query failure is exactly the
        // harm this whole path exists to undo — so the row stays for next boot.
        expect(result).toEqual({ restored: 1, dropped: 0 });
        expect(store.load().map((q) => q.id).sort()).toEqual(['live', 'unknowable']);
        // Positive control: the row it COULD judge was restored, so the pass
        // above is a decision about one row and not a skipped loop.
        expect(fq.listPendingQuestions().map((p) => p.id)).toEqual(['live']);
    });

    it('is safe to run twice — a rebuilt question is not duplicated', () => {
        store.save(stored());
        fq.rehydratePendingQuestions(() => true);
        const second = fq.rehydratePendingQuestions(() => true);
        expect(second.restored).toBe(0);
        expect(fq.listPendingQuestions()).toHaveLength(1);
    });

    it('delivers a rebuilt question’s answer to the agent that asked it', async () => {
        const delivered: DeferredAnswerDelivery[] = [];
        fq.setDeferredAnswerSink((d) => {
            delivered.push(d);
        });
        store.save(stored({ terminalId: 'T-ALIVE' }));
        fq.rehydratePendingQuestions(() => true);

        const answers = [{ header: 'Ship', question: 'Ship?', selected: ['Yes'], note: 'go' }];
        expect(fq.answerPendingQuestion('q-old', answers)).toBe(true);

        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject({ terminalId: 'T-ALIVE', questionId: 'q-old', answers });
        // genie#315's rule: the late message must name the REAL reason it is
        // arriving late. This one was not parked for DND; Genie restarted.
        expect(delivered[0].deferralReason).toBe('restart');
        expect(fq.formatDeferredAnswer(delivered[0])).toMatch(/restart/i);
        expect(fq.formatDeferredAnswer(delivered[0])).not.toMatch(/DND/);
        // And the row is gone, so the next boot does not raise it again.
        expect(store.load()).toEqual([]);
    });

    it('an agent that re-asks after the restart rejoins its rebuilt question', async () => {
        // The headline case. Genie upgraded mid-ask; the agent reconnected and,
        // having had no answer, asked again. Before the key, that produced a
        // second question the user saw as a separate ask.
        vi.resetModules();
        const fresh = await import('../force-question');
        fresh.setQuestionStore(store);
        fresh.setAvailabilityReader(() => ({ availability: 'available', dndMessage: 'x' }));
        fresh.registerForceQuestionIpc({
            isDev: false,
            preloadPath: '/p.js',
            getMasterWindow: () => null,
        });

        // The previous run raised it and wrote it down...
        const before = await fresh.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        expect(store.load()).toHaveLength(1);

        // ...then Genie restarted: a brand-new module, empty in-memory queue,
        // the same database.
        vi.resetModules();
        const rebooted = await import('../force-question');
        rebooted.setQuestionStore(store);
        rebooted.setAvailabilityReader(() => ({ availability: 'available', dndMessage: 'x' }));
        rebooted.registerForceQuestionIpc({
            isDev: false,
            preloadPath: '/p.js',
            getMasterWindow: () => null,
        });
        expect(rebooted.listPendingQuestions()).toHaveLength(0); // really gone
        rebooted.rehydratePendingQuestions(() => true);

        const after = await rebooted.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        expect(after.questionId).toBe(before.questionId);
        expect(rebooted.listPendingQuestions()).toHaveLength(1);

        for (const p of rebooted.listPendingQuestions()) rebooted.answerPendingQuestion(p.id, []);
    });
});
