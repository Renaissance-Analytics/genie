import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForceAnswer, ForceQuestion } from '../../mcp/protocol';
import type { PersistedQuestion, QuestionStorePort } from '../question-store';

/**
 * An answer that could not be delivered must not look like one that was
 * (genie#482).
 *
 * Every MCP ForceTheQuestion answer travels the same asynchronous road: the tool
 * call returns at once, the user answers later, and the answer is handed to the
 * asking agent through its AgentInbox. `deliverHumanMessageToTerminal` returns
 * FALSE when that terminal no longer has an agent identity — it closed, it
 * restarted, the agent never rejoined. Nothing read it.
 *
 * So the answer went nowhere, the durable row had ALREADY been forgotten,
 * `answerPendingQuestion` returned true, the card disappeared as a success, and
 * the agent that had been told "the user will get back to you" never heard
 * anything. Nobody was told, on either side.
 *
 * This is not only the DND path #482 was filed against. The ORDINARY modal
 * answer takes the same sink and had the same swallow, which makes the common
 * case "the user answered a normal always-on-top modal and the agent had died".
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
    /** Every OS notification raised — the user-visible half under test. */
    notices: Array<{ title: string; body: string }>;
} = { windows: [], nextWcId: 1, ipc: new Map(), notices: [] };

vi.mock('electron', () => {
    class BrowserWindow {
        static getAllWindows(): unknown[] {
            return [];
        }
        constructor() {
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
    class Notification {
        private opts: { title: string; body: string };
        static isSupported(): boolean {
            return true;
        }
        constructor(opts: { title: string; body: string }) {
            this.opts = opts;
        }
        show(): void {
            state.notices.push({ title: this.opts.title, body: this.opts.body });
        }
    }
    return {
        BrowserWindow,
        Notification,
        ipcMain: {
            handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
                state.ipc.set(channel, fn);
            },
        },
        powerMonitor: { getSystemIdleTime: () => 0 },
        screen: {
            getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
        },
        shell: { openExternal: () => Promise.resolve() },
    };
});

vi.mock('../../db', () => ({ getAllSettings: () => ({ notify_sound: 'off' }) }));
vi.mock('../../notify-sound', () => ({
    resolveAlertSound: () => null,
    deliverAlertSound: () => {},
}));

import * as fq from '../force-question';

const Q = (header: string): ForceQuestion[] => [
    { header, question: `${header}?`, options: [{ label: 'Yes' }, { label: 'No' }] },
];
const ANSWER: ForceAnswer[] = [
    { header: 'Ship', question: 'Ship?', selected: ['Yes'], note: '' },
];

/** In-memory store, so "was the row still there?" is observable. */
function fakeStore(): QuestionStorePort & { rows: Map<string, PersistedQuestion> } {
    const rows = new Map<string, PersistedQuestion>();
    return {
        rows,
        save(q) {
            rows.set(q.id, { ...q });
        },
        remove(id) {
            rows.delete(id);
        },
        load() {
            return [...rows.values()];
        },
    };
}

describe('an undelivered answer is reported, not swallowed', () => {
    let store: ReturnType<typeof fakeStore>;

    beforeEach(() => {
        state.windows = [];
        state.nextWcId = 1;
        state.notices = [];
        store = fakeStore();
        fq.setQuestionStore(store);
        fq.registerForceQuestionIpc({
            isDev: false,
            preloadPath: '/p.js',
            getMasterWindow: () => null,
        });
    });
    afterEach(() => {
        for (const w of state.windows) if (!w.destroyed) w.close();
        fq.setDeferredAnswerSink(null);
        for (const p of fq.listPendingQuestions()) fq.answerPendingQuestion(p.id, []);
        fq.setQuestionStore(null);
        fq.setAvailabilityReader(null);
        vi.clearAllMocks();
    });

    it('tells the user when a DND-deferred answer had nowhere to land', async () => {
        fq.setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        fq.setDeferredAnswerSink(() => ({ delivered: false, reason: 'no-agent' }));

        const asked = await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        const result = fq.answerPendingQuestion(asked.questionId!, ANSWER);

        expect(result).toBe(true); // the question WAS answered — that part is true
        expect(state.notices).toHaveLength(1);
        expect(state.notices[0]!.body).toMatch(/no longer running|not told|could not be delivered/i);
    });

    it('says NOTHING when the answer actually reached the agent', () => {
        // The positive control. Without it the assertion above would pass against
        // a build that notified on every answer, which would be its own bug.
        fq.setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        fq.setDeferredAnswerSink(() => ({ delivered: true }));

        void fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        const row = fq.listPendingQuestions()[0]!;
        expect(fq.answerPendingQuestion(row.id, ANSWER)).toBe(true);
        expect(state.notices).toEqual([]);
    });

    it('tells the user when an ORDINARY MODAL answer had nowhere to land', async () => {
        // The half #482 did not name, and the bigger one: this is every agent
        // question the user answers in the always-on-top window.
        fq.setAvailabilityReader(() => ({ availability: 'available', dndMessage: 'x' }));
        fq.setDeferredAnswerSink(() => ({ delivered: false, reason: 'no-agent' }));

        await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        expect(state.windows).toHaveLength(1); // the modal really did open
        const row = fq.listPendingQuestions()[0]!;
        fq.answerPendingQuestion(row.id, ANSWER);

        expect(state.notices).toHaveLength(1);
        expect(state.notices[0]!.body).toMatch(/no longer running|not told|could not be delivered/i);
    });

    it('a modal answer that lands stays silent', () => {
        fq.setAvailabilityReader(() => ({ availability: 'available', dndMessage: 'x' }));
        fq.setDeferredAnswerSink(() => ({ delivered: true }));
        void fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        fq.answerPendingQuestion(fq.listPendingQuestions()[0]!.id, ANSWER);
        expect(state.notices).toEqual([]);
    });

    it('attempts DELIVERY BEFORE it forgets the durable row', async () => {
        // Doing the irreversible thing first and the reportable thing second is
        // how the outcome became unobservable. The row must still exist while
        // delivery is being attempted, so a crash between the two loses nothing.
        fq.setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        let rowsAtDelivery = -1;
        fq.setDeferredAnswerSink(() => {
            rowsAtDelivery = store.rows.size;
            return { delivered: true };
        });

        const asked = await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        expect(store.rows.size).toBe(1); // premise: it really was stored
        fq.answerPendingQuestion(asked.questionId!, ANSWER);

        expect(rowsAtDelivery).toBe(1);
        // ...and it IS forgotten afterwards, so an answered question cannot come
        // back from the dead on the next boot.
        expect(store.rows.size).toBe(0);
    });

    it('forgets the row even when delivery failed', async () => {
        // Retention would preserve the PROMPT and discard the REPLY: the row is
        // gone from the flyout either way, the next boot's canDeliverTo drops it
        // for the very condition that failed delivery, and if the agent did come
        // back the user would be re-asked something they already answered. The
        // missing thing is the report, not the retention (genie#484).
        fq.setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        fq.setDeferredAnswerSink(() => ({ delivered: false, reason: 'no-agent' }));

        const asked = await fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        fq.answerPendingQuestion(asked.questionId!, ANSWER);

        expect(store.rows.size).toBe(0);
        expect(fq.listPendingQuestions()).toEqual([]);
    });

    it('says nothing when there was no agent to deliver to in the first place', () => {
        // An internal approval gate has no asking terminal, so nothing was
        // attempted and nothing failed. Notifying here would cry wolf on every
        // process-run approval.
        fq.setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        fq.setDeferredAnswerSink(() => ({ delivered: false, reason: 'no-agent' }));
        void fq.forceQuestion(Q('Gate'), 'ws');
        fq.answerPendingQuestion(fq.listPendingQuestions()[0]!.id, ANSWER);
        expect(state.notices).toEqual([]);
    });

    it('treats a sink that reports nothing as delivered', () => {
        // A sink installed by an older composition root returns undefined. That
        // is not evidence of failure, and raising a false alarm on every answer
        // would be worse than the silence being fixed.
        fq.setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        fq.setDeferredAnswerSink(() => undefined);
        void fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        fq.answerPendingQuestion(fq.listPendingQuestions()[0]!.id, ANSWER);
        expect(state.notices).toEqual([]);
    });

    it('a sink that THROWS still answers the question, and still reports', () => {
        fq.setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        fq.setDeferredAnswerSink(() => {
            throw new Error('broker exploded');
        });
        void fq.forceQuestion(Q('Ship'), 'ws', 'normal', {}, 'T1');
        expect(fq.answerPendingQuestion(fq.listPendingQuestions()[0]!.id, ANSWER)).toBe(true);
        expect(state.notices).toHaveLength(1);
    });

    it('names the question in the notice, so it is actionable', async () => {
        fq.setAvailabilityReader(() => ({ availability: 'dnd', dndMessage: 'x' }));
        fq.setDeferredAnswerSink(() => ({ delivered: false, reason: 'no-agent' }));
        await fq.forceQuestion(Q('Ship'), 'Wonder', 'normal', {}, 'T1');
        fq.answerPendingQuestion(fq.listPendingQuestions()[0]!.id, ANSWER);
        expect(state.notices[0]!.body).toMatch(/Ship/);
    });
});
