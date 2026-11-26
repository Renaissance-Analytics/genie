import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { QuestionWindow } from '../src/main/question-window.js';

/**
 * THE WINDOW'S QUEUE REACHES MAIN (ftq-queue.test.tsx holds the behaviour). The page answers ANY question in the queue,
 * so an answer and a Dismiss carry the id of the question they were written in; picking a question and the draft being
 * written travel too — and every channel the preload invokes is one main handles (a mismatch is a button that silently
 * does nothing). A call that names no question is sent exactly as before.
 */
const ipc = vi.hoisted(() => ({
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    exposed: new Map<string, Record<string, ((...args: unknown[]) => unknown) | undefined>>(),
    invoked: [] as unknown[][],
}));
vi.mock('electron', () => ({
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { ipc.handlers.set(channel, fn); } },
    ipcRenderer: { invoke: (...args: unknown[]) => { ipc.invoked.push(args); return Promise.resolve({ ok: true }); }, on: () => {}, removeListener: () => {} },
    contextBridge: { exposeInMainWorld: (name: string, api: Record<string, (...args: unknown[]) => unknown>) => { ipc.exposed.set(name, api); } },
    BrowserWindow: class {},
    screen: {},
    shell: {},
}));

describe('the queue’s calls, page → preload → main → controller', () => {
    /*
     * Since 2f-1 (Tynn #912) this machine's answer and Dismiss go to genie-host over the window's own frame port
     * (renderer/question-bridge.ts; split-2f-question-window.test.ts). What still crosses to main is the window's own: the
     * pick, the draft, Later — and another machine's question, answered through the window driving it (question:remote).
     */
    it('another machine’s answer and Dismiss name their question; select and draft reach the controller; every channel is handled (counted)', async () => {
        const { electronQuestionWindow } = await import('../src/main/question-window-electron.js');
        await import('../src/main/question-preload.js');
        const calls: unknown[][] = [];
        const ctl = {
            answer: async (...args: unknown[]) => { calls.push(['answer', ...args]); return { ok: true }; },
            dismiss: async (...args: unknown[]) => { calls.push(['dismiss', ...args]); return { ok: true }; },
            select: (...args: unknown[]) => { calls.push(['select', ...args]); },
            draft: (...args: unknown[]) => { calls.push(['draft', ...args]); },
        } as unknown as QuestionWindow;
        electronQuestionWindow({ here: '/genie/main', preload: '/genie/main/question-preload.cjs', controller: () => ctl, owns: (id) => id.startsWith('remote:') });
        const api = ipc.exposed.get('genieQuestion')!;

        await api.remote?.({ kind: 'answer', id: 'remote:7:q_wren', selections: [['A']], notes: ['ship it'] });
        await api.remote?.({ kind: 'dismiss', id: 'remote:7:q_kai', notes: ['not now'] });
        await api.select?.('q_wren');
        await api.draft?.('q_kai', { selections: [['B']], notes: ['use the staging one'], revision: 0 });
        expect(ipc.invoked).toEqual([
            ['question:remote', { kind: 'answer', id: 'remote:7:q_wren', selections: [['A']], notes: ['ship it'] }],
            ['question:remote', { kind: 'dismiss', id: 'remote:7:q_kai', notes: ['not now'] }],
            ['question:select', 'q_wren'],
            ['question:draft', 'q_kai', { selections: [['B']], notes: ['use the staging one'], revision: 0 }],
        ]);
        for (const [channel] of ipc.invoked) expect(ipc.handlers.has(channel as string)).toBe(true);

        // Main's handlers, given what the preload sent: the id reaches the controller with the answer, exactly once each.
        for (const [channel, ...args] of ipc.invoked) await ipc.handlers.get(channel as string)!({}, ...args);
        expect(calls).toEqual([
            ['answer', [['A']], ['ship it'], 'remote:7:q_wren'],
            ['dismiss', ['not now'], 'remote:7:q_kai'],
            ['select', 'q_wren'],
            ['draft', 'q_kai', { selections: [['B']], notes: ['use the staging one'], revision: 0 }],
        ]);

        // Control: this machine's question is never answered through main.
        calls.length = 0;
        expect(await ipc.handlers.get('question:remote')!({}, { kind: 'answer', id: 'q_wren', selections: [['A']], notes: [''] })).toMatchObject({ ok: false });
        expect(calls).toEqual([]);
    });
});

describe('the window never takes focus — not when it opens, not when a question arrives while it is up', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('question-window-electron.ts: shown with showInactive, once; no focus(), no show(), no moveTop()', () => {
        const src = strip('../src/main/question-window-electron.ts');
        expect(src.match(/\.showInactive\(\)/g) ?? []).toHaveLength(1);
        expect(src.match(/\bwin\.(focus|show|moveTop)\(\)/g) ?? []).toEqual([]);
    });
});
