import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { QuestionWindow, type QuestionView } from '../src/main/question-window.js';
import { RemoteQuestions, type RemoteQuestionRequest } from '../src/main/remote-questions.js';
import { remoteQuestionFeed } from '../src/renderer/remote-questions-feed.js';

/**
 * THE CONNECTED MACHINE'S QUESTIONS, IN THE PILOT'S QUESTION WINDOW (Tynn #726 part 1; the owner's live trial, 2026-11-16:
 * connected to a client's machine, no ForceTheQuestion question reached his window). The question window is native, in
 * each machine's own main process, and read only that machine's Deck (`items: () => composed.deckItems()`): a drone's
 * agent asked, and the window opened on the DRONE's screen. Now the window that drives another machine reports that
 * machine's live questions to its main process; they join the same window and queue, and an answer goes back through
 * that window to the host's own `features.act` — the action the host's Deck takes. Names are fixtures.
 */

const question = (id: string, at: number, extra: Partial<DeckItem> = {}): DeckItem => ({
    id, source: 'agent-question', agentId: 'agent_kai', agentName: 'kai', workspaceId: 'ws_shop', workspaceName: 'shop.example',
    title: 'Which engine?', blocking: true, priority: 'normal', at, forwardedFrom: null,
    answer: { kind: 'form', fields: 1, questions: [{ question: 'Which engine?', header: 'Engine', options: [{ label: 'postgres' }, { label: 'sqlite' }], multiSelect: false }] },
    ...extra,
} as DeckItem);
const approval = (id: string): DeckItem => ({ ...question(id, 5), source: 'approval', answer: { kind: 'inline', choices: ['Allow', 'Deny'] } } as unknown as DeckItem);

const PILOT_WINDOW = 7;
const OTHER_WINDOW = 9;

/** A RemoteQuestions whose window replies are captured; `reply` settles one the way the window's answer comes back. */
function harness(sendOk = true) {
    const sent: Array<{ sender: number; request: RemoteQuestionRequest }> = [];
    const remote = new RemoteQuestions({ send: (sender, request) => { sent.push({ sender, request }); return sendOk; }, timeoutMs: 1_000 });
    return { remote, sent };
}

describe('the connected machine’s questions, as the question window reads them', () => {
    it('only its live questions, each with an id of its own and the machine named where the workspace is', () => {
        const { remote } = harness();
        expect(remote.report(PILOT_WINDOW, 'client-box', [question('q_1', 10), approval('approval:x'), question('q_old', 1, { stale: 'agent-gone' })])).toBe(true);
        const items = remote.items();
        expect(items).toHaveLength(1);
        expect(items[0]!.id).not.toBe('q_1');
        expect(remote.owns(items[0]!.id)).toBe(true);
        expect(remote.owns('q_1')).toBe(false);
        expect(items[0]!.workspaceName).toBe('shop.example · client-box');
        expect(items[0]!.answer).toEqual(question('q_1', 10).answer);
    });

    it('the same report again changes nothing; a window that stops driving takes its questions with it', () => {
        const { remote } = harness();
        remote.report(PILOT_WINDOW, 'client-box', [question('q_1', 10)]);
        expect(remote.report(PILOT_WINDOW, 'client-box', [question('q_1', 10)])).toBe(false);
        expect(remote.report(PILOT_WINDOW, 'client-box', [])).toBe(true);
        expect(remote.items()).toEqual([]);
        remote.report(PILOT_WINDOW, 'client-box', [question('q_1', 10)]);
        expect(remote.drop(PILOT_WINDOW)).toBe(true);
        expect(remote.items()).toEqual([]);
    });
});

describe('composed: the real question window, fed this machine’s Deck and the connected machine’s questions', () => {
    function composed(local: DeckItem[] = []) {
        const h = harness();
        const views: QuestionView[] = [];
        const answered: string[] = [];
        const qw = new QuestionWindow({
            items: () => [...local, ...h.remote.items()],
            open: () => ({ show: (v) => { views.push(v); }, close: () => {} }),
            answer: async (item, selections, notes) => { if (h.remote.owns(item.id)) return h.remote.act(item, { kind: 'deck.answerForm', selections, notes }); answered.push(item.id); },
            dismiss: async (item, notes) => { if (h.remote.owns(item.id)) return h.remote.act(item, { kind: 'deck.dismiss', notes }); },
        });
        return { ...h, qw, views, answered };
    }

    it('positive control: this machine’s own question opens the window and is answered here, as before', async () => {
        const c = composed([question('q_local', 1)]);
        c.qw.changed();
        expect(c.views.at(-1)!.item.id).toBe('q_local');
        expect(await c.qw.answer([['sqlite']], [''])).toEqual({ ok: true });
        expect(c.answered).toEqual(['q_local']);
        expect(c.sent).toEqual([]);
    });

    it('the drone’s question opens the Pilot’s window, queued with this machine’s own', () => {
        const c = composed([question('q_local', 1)]);
        c.remote.report(PILOT_WINDOW, 'client-box', [question('q_1', 10)]);
        c.qw.changed();
        expect(c.views.at(-1)!.queue).toHaveLength(2);
        expect(c.views.at(-1)!.queue.map((i) => i.workspaceName)).toEqual(['shop.example', 'shop.example · client-box']);
    });

    it('answering it goes to the window that drives the drone, as the drone’s own Deck action, with the drone’s own item', async () => {
        const c = composed();
        c.remote.report(PILOT_WINDOW, 'client-box', [question('q_1', 10)]);
        c.qw.changed();
        const answering = c.qw.answer([['postgres']], ['fast']);
        await Promise.resolve();
        expect(c.sent).toHaveLength(1);
        expect(c.sent[0]!.sender).toBe(PILOT_WINDOW);
        expect(c.sent[0]!.request.action).toEqual({ kind: 'deck.answerForm', item: question('q_1', 10), selections: [['postgres']], notes: ['fast'], note: '' });
        // Another window cannot settle it; the one that drives the drone does.
        expect(c.remote.settle(OTHER_WINDOW, c.sent[0]!.request.id, { ok: true })).toBe(false);
        expect(c.remote.settle(PILOT_WINDOW, c.sent[0]!.request.id, { ok: true })).toBe(true);
        expect(await answering).toEqual({ ok: true });
        expect(c.answered).toEqual([]);
    });

    it('the drone’s refusal is the window’s answer, word for word, and the question stays', async () => {
        const c = composed();
        c.remote.report(PILOT_WINDOW, 'client-box', [question('q_1', 10)]);
        c.qw.changed();
        const answering = c.qw.answer([['postgres']], ['']);
        await Promise.resolve();
        c.remote.settle(PILOT_WINDOW, c.sent[0]!.request.id, { ok: false, reason: 'that question was already answered' });
        expect(await answering).toEqual({ ok: false, reason: 'that question was already answered' });
    });

    it('Dismiss goes the same way, as the drone’s deck.dismiss with the notes', async () => {
        const c = composed();
        c.remote.report(PILOT_WINDOW, 'client-box', [question('q_1', 10)]);
        c.qw.changed();
        const dismissing = c.qw.dismiss(['not now']);
        await Promise.resolve();
        expect(c.sent[0]!.request.action).toEqual({ kind: 'deck.dismiss', item: question('q_1', 10), notes: ['not now'] });
        c.remote.settle(PILOT_WINDOW, c.sent[0]!.request.id, { ok: true });
        expect(await dismissing).toEqual({ ok: true });
    });

    it('the window that drove it closed, or never answers: the answer is refused with a reason, never left hanging', async () => {
        const c = composed();
        c.remote.report(PILOT_WINDOW, 'client-box', [question('q_1', 10)]);
        c.qw.changed();
        const answering = c.qw.answer([['postgres']], ['']);
        await Promise.resolve();
        c.remote.drop(PILOT_WINDOW);
        expect(await answering).toEqual({ ok: false, reason: 'the window connected to client-box closed before the answer was sent' });
        const gone = harness(false);
        gone.remote.report(PILOT_WINDOW, 'client-box', [question('q_2', 10)]);
        await expect(gone.remote.act(gone.remote.items()[0]!, { kind: 'deck.answerForm', selections: [['sqlite']], notes: [''] })).rejects.toThrow('the window connected to client-box is not open');
    });
});

describe('the Pilot’s window reports what the connected machine asks', () => {
    it('connected: the host and its Deck; not connected (or no host yet): nothing', () => {
        const items = [question('q_1', 10)];
        expect(remoteQuestionFeed({ connected: true, host: 'client-box', items })).toEqual({ host: 'client-box', items });
        expect(remoteQuestionFeed({ connected: false, host: 'client-box', items })).toEqual({ host: 'client-box', items: [] });
        expect(remoteQuestionFeed({ connected: true, host: null, items })).toEqual({ host: '', items: [] });
        expect(remoteQuestionFeed({ connected: true, host: 'client-box', items: null })).toEqual({ host: 'client-box', items: [] });
    });

    it('wired: main reads both into the question window and routes the answer; preload and App carry it', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/new RemoteQuestions\(/);
        // genie-host's Deck (deck.watch, Tynn #941 2f-2) and the connected machine's questions.
        expect(main).toMatch(/items: \(\) => \[\.\.\.hostDeckNow, \.\.\.remoteQuestions\.items\(\)\]/);
        // Only another machine's question reaches main (question:remote, Tynn #912 2f-1): main answers it on that machine.
        expect(main).toMatch(/owns: \(id\) => remoteQuestions\.owns\(id\)/);
        expect(main).toMatch(/answer: \(item, selections, notes\) => remoteQuestions\.act\(item, \{ kind: 'deck\.answerForm'/);
        expect(main).toMatch(/dismiss: \(item, notes\) => remoteQuestions\.act\(item, \{ kind: 'deck\.dismiss'/);
        expect(main).toMatch(/ipcMain\.on\('genie:remote-questions'[\s\S]{0,300}remoteQuestions\.report\(/);
        expect(main).toMatch(/ipcMain\.on\('genie:remote-question-acted'[\s\S]{0,200}remoteQuestions\.settle\(/);
        const preload = readFileSync('src/main/preload.ts', 'utf8');
        expect(preload).toMatch(/'genie:remote-questions'/);
        expect(preload).toMatch(/'genie:remote-question-act'/);
        expect(preload).toMatch(/'genie:remote-question-acted'/);
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        expect(app).toMatch(/remoteQuestionFeed\(/);
        expect(app).toMatch(/remoteQuestions\?\.onAct\?\.\(/);
    });
});
