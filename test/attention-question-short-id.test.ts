import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { AttentionStore } from '../src/main/attention-store.js';

/**
 * AN AGENT NAMES ITS QUESTION BY THE SHORT ID IT WAS SHOWN (Tynn #600). Measured on the owner's machine: prism withdrew
 * `q_dd6bedde` and `q_c213584c` and was refused "no pending question", so both stayed on the Deck. A unique prefix of the
 * agent's OWN pending question in its own workspace is that question; anything else is refused as before.
 */
let dir: string;
let store: AttentionStore;
const prism = mintAgentId();
const other = mintAgentId();
let clock = 1_000;
const now = () => new Date(clock++).toISOString();
const ask = (agentId: typeof prism, header: string, workspaceId = 'ws') => store.ask({
    agentId, agentName: 'prism', workspaceId,
    questions: [{ header, question: `${header}?`, options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }],
} as never, { userActive: true }) as Promise<{ ok: true; questionId: string }>;
const short = (id: string) => id.slice(0, 10);

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-short-id-'));
    store = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('withdraw by a short id', () => {
    it('the agent’s own question, by the 8 characters after q_: withdrawn, and the full id answered', async () => {
        const asked = await ask(prism, 'Harness rel');
        expect(await store.withdraw({ agentId: prism, workspaceId: 'ws' }, short(asked.questionId))).toEqual({ ok: true, questionId: asked.questionId, withdrawn: true });
        expect(store.pending().map((q) => q.id)).toEqual([]);
    });

    it('update by a short id reaches the same question', async () => {
        const asked = await ask(prism, 'Harness work');
        const updated = await store.update({ agentId: prism, workspaceId: 'ws', questionId: short(asked.questionId), questions: [{ header: 'Harness work', question: 'Still?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }] } as never);
        expect(updated).toMatchObject({ ok: true, questionId: asked.questionId, revision: 1 });
    });

    it('another agent’s question, or one in another workspace, by its short id: refused as missing', async () => {
        const theirs = await ask(other, 'Theirs');
        const elsewhere = await ask(prism, 'Elsewhere', 'ws2');
        await expect(store.withdraw({ agentId: prism, workspaceId: 'ws' }, short(theirs.questionId))).rejects.toThrow(/no pending question/);
        await expect(store.withdraw({ agentId: prism, workspaceId: 'ws' }, short(elsewhere.questionId))).rejects.toThrow(/no pending question/);
        expect(store.pending()).toHaveLength(2);
    });

    it('too short to name one (fewer than 8 characters after q_), or not a q_ id: refused', async () => {
        const asked = await ask(prism, 'Harness rel');
        await expect(store.withdraw({ agentId: prism, workspaceId: 'ws' }, asked.questionId.slice(0, 7))).rejects.toThrow(/no pending question/);
        await expect(store.withdraw({ agentId: prism, workspaceId: 'ws' }, asked.questionId.slice(2, 12))).rejects.toThrow(/no pending question/);
        expect(store.pending()).toHaveLength(1);
    });

    it('CONTROL: the full id still works', async () => {
        const asked = await ask(prism, 'Harness rel');
        expect(await store.withdraw({ agentId: prism, workspaceId: 'ws' }, asked.questionId)).toMatchObject({ withdrawn: true });
    });
});
