import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForceQuestion } from '../../mcp/protocol';

/**
 * The three server-facing exports added to force-question.ts for the mobile
 * channel — listPendingQuestions / answerPendingQuestion / onQuestionsChanged —
 * without disturbing the modal path. The phone answers through the SAME private
 * finish() the desktop's ask:answer uses, so a phone answer unblocks the agent
 * AND advances the modal. The phone-after-desktop race (id already gone) returns
 * false, not an error.
 *
 * Same electron mock as force-question.test.ts so the FIFO queue is real.
 */

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
            self.closedHandlers = [];
            self.destroyed = false;
            self.webContents = {
                id: wcId,
                isLoading: () => false,
                once: () => {},
                send: () => {},
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

vi.mock('../../db', () => ({ getAllSettings: () => ({ notify_sound: 'off' }) }));

import {
    forceQuestion,
    registerForceQuestionIpc,
    listPendingQuestions,
    answerPendingQuestion,
    onQuestionsChanged,
} from '../force-question';

const Q = (header: string): ForceQuestion[] => [
    { header, question: `${header}?`, options: [{ label: 'Yes' }, { label: 'No' }] },
];

function lastWin(): FakeWin {
    return state.windows[state.windows.length - 1];
}

describe('force-question server exports', () => {
    beforeEach(() => {
        state.windows = [];
        state.nextWcId = 1;
        registerForceQuestionIpc({
            isDev: false,
            preloadPath: '/preload.js',
            getMasterWindow: () => null,
        });
    });

    it('listPendingQuestions reflects the live FIFO queue', async () => {
        const pA = forceQuestion(Q('A'), 'Project A');
        const pB = forceQuestion(Q('B'));
        const pending = listPendingQuestions();
        expect(pending).toHaveLength(2);
        expect(pending[0].questions[0].header).toBe('A');
        expect(pending[0].workspaceLabel).toBe('Project A');
        expect(pending[0].index).toBe(0);
        expect(pending[1].index).toBe(1);
        lastWin().close();
        await Promise.all([pA, pB]);
    });

    it('answerPendingQuestion unblocks the matching call via the SAME finish path', async () => {
        const pA = forceQuestion(Q('A'));
        const id = listPendingQuestions()[0].id;
        const ok = answerPendingQuestion(id, [
            { header: 'A', question: 'A?', selected: ['Yes'], note: 'from phone' },
        ]);
        expect(ok).toBe(true);
        const rA = await pA; // the blocked "agent" unblocks
        expect(rA.cancelled).toBe(false);
        expect(rA.answers[0].selected).toEqual(['Yes']);
        expect(rA.answers[0].note).toBe('from phone');
        // The queue drained → the shared modal closed (modal path advanced).
        expect(lastWin().destroyed).toBe(true);
    });

    it('returns false for an unknown id (phone-after-desktop race)', async () => {
        const pA = forceQuestion(Q('A'));
        const id = listPendingQuestions()[0].id;
        // Desktop answers first (drains the queue)…
        answerPendingQuestion(id, []);
        await pA;
        // …then the phone tries the same id — benign "already answered".
        expect(answerPendingQuestion(id, [])).toBe(false);
    });

    it('onQuestionsChanged fires on enqueue AND on resolve', async () => {
        const events: number[] = [];
        const off = onQuestionsChanged(() => events.push(listPendingQuestions().length));
        const pA = forceQuestion(Q('A')); // enqueue → 1
        const pB = forceQuestion(Q('B')); // enqueue → 2
        const id = listPendingQuestions()[0].id;
        answerPendingQuestion(id, []); // resolve → 1
        lastWin().close(); // drain B → 0
        await Promise.all([pA, pB]);
        off();
        // Saw the rising then falling counts (exact sequence: 1,2,1,0).
        expect(events).toEqual([1, 2, 1, 0]);
    });
});
