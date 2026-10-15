import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import type { QuestionWindow } from '../src/main/question-window.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * EVERY QUESTION'S NOTE SURVIVES EVERY HOP (the owner, 2026-10-14, on beta.26: "I should have a note section for every
 * question asked … Look at the old FTQ interface"; and "I click the answer button but nothing happens"). The form's notes
 * go: QuestionForm → question-main (`bridge.answer`) → the preload (`genieQuestion.answer`, channel `question:answer`) →
 * main's IPC handler → QuestionWindow.answer → main.ts's `deck.answerForm` action → resolveDeckForm → the attention store
 * → the agent's inbox. In the Deck: Deck → Shell → App.tsx's `deck.answerForm` → the same feature action. A hop that
 * drops `notes` turns a note-only answer into a refusal, which is the "nothing happens" the owner saw.
 */
const ipc = vi.hoisted(() => ({
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    exposed: new Map<string, Record<string, (...args: unknown[]) => unknown>>(),
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

describe('the question window’s IPC carries one note per question', () => {
    it('the preload sends the notes on the channel main handles, and main hands them to the window’s controller', async () => {
        const { electronQuestionWindow } = await import('../src/main/question-window-electron.js');
        await import('../src/main/question-preload.js');
        const answered: unknown[][] = [];
        const ctl = { answer: async (...args: unknown[]) => { answered.push(args); return { ok: true }; } } as unknown as QuestionWindow;
        electronQuestionWindow({ here: '/genie/main', preload: '/genie/main/question-preload.cjs', controller: () => ctl });

        // The page's call, through the preload.
        const api = ipc.exposed.get('genieQuestion')!;
        await api.answer!([['A'], []], ['', 'neither — use C']);
        expect(ipc.invoked).toEqual([['question:answer', [['A'], []], ['', 'neither — use C']]]);

        // Every channel the preload invokes is one main registered — a mismatch would make Answer silently do nothing.
        await api.current!();
        await api.later!();
        const channels = ipc.invoked.map((call) => call[0]);
        expect(channels).toEqual(['question:answer', 'question:current', 'question:later']);
        for (const channel of channels) expect(ipc.handlers.has(channel as string)).toBe(true);

        // Main's handler, given what the preload sent: the notes reach the controller, in order; a non-string is no note.
        await ipc.handlers.get('question:answer')!({}, [['A'], []], ['', 'neither — use C']);
        await ipc.handlers.get('question:answer')!({}, [['A']], [42]);
        expect(answered).toEqual([[[['A'], []], ['', 'neither — use C']], [[['A']], ['']]]);
    });
});

describe('main and the renderers pass notes, never drop them', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    it('main.ts: the window’s answer becomes deck.answerForm WITH the notes (and no overall note — the form has none)', () => {
        const main = strip('../src/main/main.ts');
        expect(main.match(/answer:\s*async\s*\(item,\s*selections,\s*notes\)\s*=>\s*\{\s*await handleFeatureAction\(composed,\s*\{\s*kind:\s*'deck\.answerForm',\s*item,\s*selections,\s*notes,\s*note:\s*''\s*\}/g) ?? []).toHaveLength(1);
    });
    it('App.tsx: the Deck’s form becomes deck.answerForm WITH the notes', () => {
        const app = strip('../src/renderer/App.tsx');
        expect(app.match(/act\(\{\s*kind:\s*'deck\.answerForm',\s*item,\s*selections,\s*notes,\s*note:\s*''\s*\}\)/g) ?? []).toHaveLength(1);
    });
    it('question-main.tsx: the window’s page sends the notes over the bridge', () => {
        const page = strip('../src/renderer/question-main.tsx');
        expect(page.match(/bridge\.answer\(selections,\s*notes\)/g) ?? []).toHaveLength(1);
    });
});

describe('the feature action, end to end into the agent’s inbox', () => {
    const pty: PtyPort = {
        open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    let dir: string;
    let services: ComposedServices;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-ftq-notes-'));
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    it('a note-only answer is ACCEPTED and the agent reads that note under its question', async () => {
        const agent = mintAgentId();
        const asked = await services.attention.ask({
            agentId: agent, agentName: 'kai', workspaceId: 'tynn',
            questions: [
                { header: 'Workers', question: 'How many workers?', options: [{ label: '4' }, { label: '8' }] },
                { header: 'Scope', question: 'Which suites?', options: [{ label: 'unit' }, { label: 'e2e' }], multiSelect: true },
            ],
        }, { userActive: true });
        const item = services.deckItems().find((i) => i.id === asked.questionId)!;
        expect(item.answer.kind).toBe('form');

        await handleFeatureAction(services, { kind: 'deck.answerForm', item, selections: [['4'], []], notes: ['', 'only if it is quick'], note: '' }, { toolStatuses: null, knowledgeQuery: '' });

        expect(services.attention.pending().map((q) => q.id)).not.toContain(asked.questionId);
        const [mail] = (await services.inbox.receive({ participant: agent })).messages;
        expect(mail!.text).toContain('- **Scope** — Which suites?\n  → (no option chosen)\n  Note: only if it is quick');
    });

    it('control: a question with neither an option nor a note is refused by name, and the question stays asked', async () => {
        const agent = mintAgentId();
        const asked = await services.attention.ask({
            agentId: agent, agentName: 'kai', workspaceId: 'tynn',
            questions: [
                { header: 'Workers', question: 'How many workers?', options: [{ label: '4' }, { label: '8' }] },
                { header: 'Scope', question: 'Which suites?', options: [{ label: 'unit' }, { label: 'e2e' }], multiSelect: true },
            ],
        }, { userActive: true });
        const item = services.deckItems().find((i) => i.id === asked.questionId)!;
        await expect(handleFeatureAction(services, { kind: 'deck.answerForm', item, selections: [['4'], []], notes: ['', '  '], note: '' }, { toolStatuses: null, knowledgeQuery: '' })).rejects.toThrow('Scope needs an option or a note');
        expect(services.attention.pending().map((q) => q.id)).toContain(asked.questionId);
    });
});
