import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { AttentionStore } from '../src/main/attention-store.js';

/**
 * THE ATTENTION PROTOCOL — the durable half (§6.3): imDone with a handoff, ForceTheQuestion
 * that survives a restart and delivers its answer through the inbox, the two lists.
 *
 * The store is what the Genie MCP tool handlers will call. It knows nothing about transport.
 */

let dir: string;
let workspace: string;
let inbox: InboxStore;
let store: AttentionStore;
const agent = mintAgentId();
const other = mintAgentId();
let clock = 1_000;
const now = () => new Date(clock++).toISOString();

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-attention-'));
    workspace = join(dir, 'ws');
    inbox = await InboxStore.open(dir, now);
    store = await AttentionStore.open(dir, inbox, now);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('imDone', () => {
    it('files the handoff under the agent’s name in the workspace, REPLACING the previous note', async () => {
        const first = await store.imDone({ agentId: agent, agentName: 'atlas', workspacePath: workspace, handoff: 'first run: did A, B is half done' });
        expect(first).toMatchObject({ ok: true, handoff: { saved: true, path: join(workspace, '.ai', 'handoff', 'atlas.md') } });

        await store.imDone({ agentId: agent, agentName: 'atlas', workspacePath: workspace, handoff: 'second run: B done, C next' });
        const text = (await readFile(join(workspace, '.ai', 'handoff', 'atlas.md'))).toString();
        expect(text).toContain('second run');
        // COUNTED: zero traces of the first note — replaced, not appended.
        expect(text.split('first run')).toHaveLength(1);
    });

    it('reports a handoff that could NOT be saved, with the reason, rather than claiming it landed', async () => {
        const r = await store.imDone({ agentId: agent, agentName: null, workspacePath: workspace, handoff: 'orphan note' });
        expect(r.ok).toBe(true);
        expect(r.handoff).toMatchObject({ saved: false });
        expect((r.handoff as { reason: string }).reason).toMatch(/agent name/);

        const noWorkspace = await store.imDone({ agentId: agent, agentName: 'atlas', workspacePath: null, handoff: 'note' });
        expect((noWorkspace.handoff as { reason: string }).reason).toMatch(/workspace/);
    });

    it('with no handoff passed, says so — an empty handoff is worse than none', async () => {
        const r = await store.imDone({ agentId: agent, agentName: 'atlas', workspacePath: workspace });
        expect(r.handoff).toEqual({ saved: false, reason: 'no handoff was passed' });
        await expect(stat(join(workspace, '.ai', 'handoff', 'atlas.md'))).rejects.toThrow();
    });

    it('the agent’s own checklist rides every imDone', async () => {
        await store.lists.add({ list: 'agent', workspaceId: 'tynn', agentId: agent, text: 'write the VM probe' });
        const r = await store.imDone({ agentId: agent, agentName: 'atlas', workspacePath: workspace, workspaceId: 'tynn', handoff: 'x' });
        expect(r.checklist.map((i) => i.text)).toEqual(['write the VM probe']);
    });

    it('records the finish so the Deck’s finished-with-handoff source can show it', async () => {
        await store.imDone({ agentId: agent, agentName: 'atlas', workspacePath: workspace, handoff: 'all done' });
        const finished = store.finished();
        expect(finished).toHaveLength(1);
        expect(finished[0]).toMatchObject({ agentId: agent, handoff: 'all done', seen: false });
        store.markSeen(finished[0]!.id);
        expect(store.finished().filter((f) => !f.seen)).toHaveLength(0);
    });
});

describe('ForceTheQuestion', () => {
    const questions = [{ header: 'Engine', question: 'Which browser engine?', options: [{ label: 'webContents' }, { label: 'BrowserWindow' }] }];

    it('returns immediately with an id and whether the user is active; nothing blocks', async () => {
        const r = await store.ask({ agentId: agent, agentName: 'atlas', workspaceId: 'tynn', questions }, { userActive: true });
        expect(r).toMatchObject({ ok: true, userActive: true, rejoined: false });
        expect(r.questionId).toMatch(/^q_/);
        expect(store.pending()).toHaveLength(1);
    });

    it('a repeat of the same question is REJOINED, not duplicated', async () => {
        const first = await store.ask({ agentId: agent, agentName: 'atlas', workspaceId: 'tynn', questions }, { userActive: false });
        const again = await store.ask({ agentId: agent, agentName: 'atlas', workspaceId: 'tynn', questions }, { userActive: false });
        expect(again.questionId).toBe(first.questionId);
        expect(again.rejoined).toBe(true);
        expect(store.pending()).toHaveLength(1);
        // POSITIVE CONTROL: a different asker with the same words is a second question.
        const theirs = await store.ask({ agentId: other, agentName: 'kai', workspaceId: 'tynn', questions }, { userActive: false });
        expect(theirs.questionId).not.toBe(first.questionId);
        expect(store.pending()).toHaveLength(2);
    });

    it('survives a restart', async () => {
        const r = await store.ask({ agentId: agent, agentName: 'atlas', workspaceId: 'tynn', questions }, { userActive: false });
        const reopened = await AttentionStore.open(dir, inbox, now);
        expect(reopened.pending().map((q) => q.id)).toEqual([r.questionId]);
    });

    it('refuses a malformed ask with the reason, and files nothing', async () => {
        await expect(store.ask({ agentId: agent, agentName: 'atlas', workspaceId: 'tynn', questions: [] }, { userActive: false })).rejects.toThrow(/1.*4 questions/);
        expect(store.pending()).toHaveLength(0);
    });

    it('the answer — selections AND the free-text note — reaches the asker through the INBOX, from the human', async () => {
        const r = await store.ask({ agentId: agent, agentName: 'atlas', workspaceId: 'tynn', questions }, { userActive: true });
        await store.answer(r.questionId, { selections: [['webContents']], note: 'start there; we can swap later' });

        expect(store.pending()).toHaveLength(0);
        const mail = await inbox.receive({ participant: agent });
        expect(mail.messages).toHaveLength(1);
        expect(mail.messages[0]!.from).toBe(HUMAN);
        expect(mail.messages[0]!.text).toContain('webContents');
        expect(mail.messages[0]!.text).toContain('start there; we can swap later');
        expect(mail.messages[0]!.text).toContain(r.questionId);
    });

    it('each question’s OWN note reaches the asker right under that question; a note alone answered it; no overall Note line without one', async () => {
        // The owner, 2026-10-14: "I should have a note section for every question asked" — Genie 1's FTQ had one each.
        const three = [
            { header: 'Engine', question: 'Which browser engine?', options: [{ label: 'webContents' }, { label: 'BrowserWindow' }] },
            { header: 'Scope', question: 'Which suites?', options: [{ label: 'unit' }, { label: 'e2e' }], multiSelect: true },
            { header: 'When', question: 'Ship when?', options: [{ label: 'today' }, { label: 'tomorrow' }] },
        ];
        const r = await store.ask({ agentId: agent, agentName: 'atlas', workspaceId: 'tynn', questions: three }, { userActive: true });
        await store.answer(r.questionId, { selections: [['webContents'], [], ['today']], notes: ['start there', 'neither — run perf', ''], note: '' });

        const [mail] = (await inbox.receive({ participant: agent })).messages;
        const text = mail!.text;
        // Under its own question, in order.
        expect(text).toContain('- **Engine** — Which browser engine?\n  → webContents\n  Note: start there\n- **Scope**');
        expect(text).toContain('- **Scope** — Which suites?\n  → (no option chosen)\n  Note: neither — run perf\n- **When**');
        // COUNTED: exactly the two notes that were given — the third question had none.
        expect(text.match(/^ {2}Note: /gm) ?? []).toHaveLength(2);
        expect(text).toMatch(/- \*\*When\*\* — Ship when\?\n {2}→ today$/);
        // No overall note was given, so there is no overall Note line (and no "(none)").
        expect(text).not.toMatch(/^Note: /m);
        expect(text).not.toContain('(none)');
    });

    it('an overall note from a caller other than the form still reaches the asker on its own line', async () => {
        const r = await store.ask({ agentId: agent, agentName: 'atlas', workspaceId: 'tynn', questions }, { userActive: true });
        await store.answer(r.questionId, { selections: [['webContents']], note: 'overall word' });
        const [mail] = (await inbox.receive({ participant: agent })).messages;
        expect(mail!.text).toMatch(/^Note: overall word$/m);
        expect(mail!.text.match(/^ {2}Note: /gm) ?? []).toHaveLength(0);
    });

    it('answering an unknown or already-answered question throws rather than mailing anyone', async () => {
        await expect(store.answer('q_nope', { selections: [[]], note: '' })).rejects.toThrow(/q_nope/);
        expect((await inbox.receive({ participant: agent })).messages).toEqual([]);
    });
});

describe('the two lists', () => {
    it('an agent checklist is filed under its agent; the user list is shared per workspace and shows who asked', async () => {
        await store.lists.add({ list: 'agent', workspaceId: 'tynn', agentId: agent, text: 'mine' });
        await store.lists.add({ list: 'agent', workspaceId: 'tynn', agentId: other, text: 'theirs' });
        await store.lists.add({ list: 'user', workspaceId: 'tynn', agentId: agent, text: 'rotate the token' });
        await store.lists.add({ list: 'user', workspaceId: 'tynn', agentId: other, text: 'approve the share' });

        expect(store.lists.show({ list: 'agent', workspaceId: 'tynn', agentId: agent }).map((i) => i.text)).toEqual(['mine']);
        const user = store.lists.show({ list: 'user', workspaceId: 'tynn', agentId: agent });
        expect(user.map((i) => [i.text, i.askedBy])).toEqual([['rotate the token', agent], ['approve the share', other]]);
        // Another workspace sees neither.
        expect(store.lists.show({ list: 'user', workspaceId: 'fancy', agentId: agent })).toEqual([]);
    });

    it('allUserItems lists every workspace’s user list with its workspace, for the Deck', async () => {
        await store.lists.add({ list: 'user', workspaceId: 'tynn', agentId: agent, text: 'rotate the token' });
        await store.lists.add({ list: 'user', workspaceId: 'fancy', agentId: other, text: 'approve the share' });
        await store.lists.add({ list: 'agent', workspaceId: 'tynn', agentId: agent, text: 'not a user item' });
        expect(store.allUserItems().map((x) => [x.workspaceId, x.item.text])).toEqual([['tynn', 'rotate the token'], ['fancy', 'approve the share']]);
    });

    it('refuses when full, with the limit, and refuses a question', async () => {
        for (let i = 0; i < 5; i++) await store.lists.add({ list: 'user', workspaceId: 'tynn', agentId: agent, text: `u${i}` });
        const full = await store.lists.add({ list: 'user', workspaceId: 'tynn', agentId: agent, text: 'u5' });
        expect(full).toEqual({ kind: 'full', limit: 5 });
        const q = await store.lists.add({ list: 'agent', workspaceId: 'tynn', agentId: agent, text: 'should I?' });
        expect(q.kind).toBe('question');
    });

    it('done and clear, and all of it survives a restart', async () => {
        const added = await store.lists.add({ list: 'agent', workspaceId: 'tynn', agentId: agent, text: 'a' });
        if (added.kind !== 'added') throw new Error('unreachable');
        await store.lists.add({ list: 'agent', workspaceId: 'tynn', agentId: agent, text: 'b' });
        await store.lists.done({ workspaceId: 'tynn', id: added.item.id });

        const reopened = await AttentionStore.open(dir, inbox, now);
        const items = reopened.lists.show({ list: 'agent', workspaceId: 'tynn', agentId: agent });
        expect(items.map((i) => [i.text, i.done])).toEqual([['a', true], ['b', false]]);

        await reopened.lists.clear({ list: 'agent', workspaceId: 'tynn', agentId: agent });
        expect(reopened.lists.show({ list: 'agent', workspaceId: 'tynn', agentId: agent })).toEqual([]);
    });
});
