import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '../src/core/attention.js';
import { DAY_MS, type DeckItem } from '../src/core/deck.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { mintAgentId } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { QuestionWindow, type QuestionView } from '../src/main/question-window.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * NOTHING WAITS FOREVER (the owner, 2026-10-15: "the Deck pending questions is not in sync with FTQ. I see a bunch of
 * questions there I never got an FTQ for, some look really old" — eight single questions from the day before; nothing
 * ever dismissed or expired one). The person can now DISMISS a question without answering it — one, or every one older
 * than a day — from the Deck or the question window. It leaves both, and the asking agent is mailed
 * "<header>: dismissed by the person, without an answer" so it stops waiting.
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

const q = (header: string): Question[] => [{ header, question: `About ${header}?`, options: [{ label: 'a' }, { label: 'b' }] }];

describe('the attention store dismisses', () => {
    let dir: string;
    let inbox: InboxStore;
    let store: AttentionStore;
    let clock: number;
    const now = () => new Date(clock).toISOString();
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-dismiss-'));
        clock = Date.parse('2026-10-14T09:00:00.000Z');
        inbox = await InboxStore.open(dir, now);
        store = await AttentionStore.open(dir, inbox, now);
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('one question: removed, and its agent mailed EXACTLY once, from the person, saying it was dismissed without an answer', async () => {
        const agent = mintAgentId();
        const asked = await store.ask({ agentId: agent, agentName: 'kai', workspaceId: 'tynn', questions: q('Engine') }, { userActive: true });
        await store.dismiss(asked.questionId);
        expect(store.pending()).toEqual([]);
        const mail = inbox.unread(agent);
        expect(mail).toHaveLength(1);
        expect(mail[0]!.from).toBe(HUMAN);
        expect(mail[0]!.text.startsWith('Engine: dismissed by the person, without an answer')).toBe(true);
        expect(mail[0]!.text).toContain(asked.questionId);
        // A second dismiss of the same id finds nothing, throws, and mails nobody: still one.
        await expect(store.dismiss(asked.questionId)).rejects.toThrow(asked.questionId);
        expect(inbox.unread(agent)).toHaveLength(1);
    });

    it('several questions in one ask: the mail names the first header and how many rode with it', async () => {
        const agent = mintAgentId();
        const asked = await store.ask({ agentId: agent, agentName: 'kai', workspaceId: 'tynn', questions: [...q('Engine'), ...q('Where')] }, { userActive: true });
        await store.dismiss(asked.questionId);
        expect(inbox.unread(agent)[0]!.text.startsWith('Engine + 1 more: dismissed by the person, without an answer')).toBe(true);
    });

    it('older than a day: only the old ones go, each asker mailed once; a fresh one stays and its agent hears nothing (control)', async () => {
        const oldAgent = mintAgentId();
        const freshAgent = mintAgentId();
        const old = await store.ask({ agentId: oldAgent, agentName: 'kai', workspaceId: 'tynn', questions: q('Old') }, { userActive: true });
        clock += DAY_MS + 60_000;
        const fresh = await store.ask({ agentId: freshAgent, agentName: 'wren', workspaceId: 'tynn', questions: q('Fresh') }, { userActive: true });
        clock += 60_000;
        expect(await store.dismissOlderThan(DAY_MS)).toBe(1);
        expect(store.pending().map((p) => p.id)).toEqual([fresh.questionId]);
        expect(store.pending().map((p) => p.id)).not.toContain(old.questionId);
        expect(inbox.unread(oldAgent)).toHaveLength(1);
        expect(inbox.unread(freshAgent)).toHaveLength(0);
        // Nothing old left: nothing removed, nobody mailed.
        expect(await store.dismissOlderThan(DAY_MS)).toBe(0);
        expect(inbox.unread(oldAgent)).toHaveLength(1);
    });

    it('the question window shows the next one when the shown one is dismissed', async () => {
        const a = await store.ask({ agentId: mintAgentId(), agentName: 'kai', workspaceId: 'tynn', questions: q('First') }, { userActive: true });
        clock += 1_000;
        const b = await store.ask({ agentId: mintAgentId(), agentName: 'wren', workspaceId: 'tynn', questions: q('Second') }, { userActive: true });
        const log: string[] = [];
        const items = (): DeckItem[] => deckItemsFrom({ questions: store.pending(), userList: [], unreadDms: [], finished: [], agents: {} });
        const ctl = new QuestionWindow({
            items,
            open: () => ({ show: (v: QuestionView) => log.push(`show ${v.item.id}`), close: () => log.push('close') }),
            answer: async () => { throw new Error('not in this test'); },
            dismiss: async (item) => { await store.dismiss(item.id); },
        });
        store.onChange(() => ctl.changed());
        ctl.changed();
        expect(log.at(-1)).toBe(`show ${a.questionId}`);
        expect(await ctl.dismiss()).toEqual({ ok: true });
        expect(log.at(-1)).toBe(`show ${b.questionId}`);
        expect(store.pending().map((p) => p.id)).toEqual([b.questionId]);
    });
});

describe('the feature actions the Deck and the window send', () => {
    const pty: PtyPort = {
        open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    let dir: string;
    let services: ComposedServices;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-dismiss-ipc-'));
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    it('deck.dismiss removes the question from the Deck and mails its agent once', async () => {
        const agent = mintAgentId();
        const asked = await services.attention.ask({ agentId: agent, agentName: 'kai', workspaceId: 'tynn', questions: q('Engine') }, { userActive: true });
        const item = services.deckItems().find((i) => i.id === asked.questionId)!;
        await handleFeatureAction(services, { kind: 'deck.dismiss', item }, { toolStatuses: null, knowledgeQuery: '' });
        expect(services.deckItems().map((i) => i.id)).not.toContain(asked.questionId);
        expect(services.inbox.unread(agent)).toHaveLength(1);
    });

    it('control: a tool approval is not dismissed — refused, and nothing else changes', async () => {
        const agent = mintAgentId();
        const asked = await services.attention.ask({ agentId: agent, agentName: 'kai', workspaceId: 'tynn', questions: q('Engine') }, { userActive: true });
        const approval: DeckItem = { id: 'approval:kai', source: 'agent-question', agentId: 'kai', agentName: 'kai', workspaceId: 'tynn', title: 'Allow?', blocking: true, priority: 'normal', at: 0, answer: { kind: 'inline', options: [] }, forwardedFrom: null };
        await expect(handleFeatureAction(services, { kind: 'deck.dismiss', item: approval }, { toolStatuses: null, knowledgeQuery: '' })).rejects.toThrow(/only an agent’s question/);
        expect(services.attention.pending().map((p) => p.id)).toEqual([asked.questionId]);
        expect(services.inbox.unread(agent)).toHaveLength(0);
    });

    it('deck.dismissOlder leaves a question asked just now (control) and reports through the same store', async () => {
        const agent = mintAgentId();
        await services.attention.ask({ agentId: agent, agentName: 'kai', workspaceId: 'tynn', questions: q('Engine') }, { userActive: true });
        await handleFeatureAction(services, { kind: 'deck.dismissOlder', olderThanMs: DAY_MS }, { toolStatuses: null, knowledgeQuery: '' });
        expect(services.attention.pending()).toHaveLength(1);
        expect(services.inbox.unread(agent)).toHaveLength(0);
    });
});

describe('the window’s Dismiss reaches main', () => {
    it('the preload invokes question:dismiss WITH the form’s notes, main handles it, and the controller dismisses — once, with them', async () => {
        const { electronQuestionWindow } = await import('../src/main/question-window-electron.js');
        await import('../src/main/question-preload.js');
        const dismissed: unknown[] = [];
        const ctl = { dismiss: async (notes: unknown) => { dismissed.push(notes); return { ok: true }; } } as unknown as QuestionWindow;
        electronQuestionWindow({ here: '/genie/main', preload: '/genie/main/question-preload.cjs', controller: () => ctl });
        await ipc.exposed.get('genieQuestion')!.dismiss!(['not now']);
        expect(ipc.invoked).toEqual([['question:dismiss', ['not now']]]);
        expect(ipc.handlers.has('question:dismiss')).toBe(true);
        expect(await ipc.handlers.get('question:dismiss')!({}, ['not now'])).toEqual({ ok: true });
        // A note that is not a string is no note — never a crash, never "[object Object]" in the agent's mail.
        expect(await ipc.handlers.get('question:dismiss')!({}, ['ok', 7])).toEqual({ ok: true });
        // COUNTED: two dismisses reached the controller, each with exactly its notes.
        expect(dismissed).toEqual([['not now'], ['ok', '']]);
    });
});
