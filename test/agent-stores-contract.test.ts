import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentId } from '../src/core/identity.js';
import { AgentStoresService } from '../src/main/agent-stores-host.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';

/**
 * THE STORES AGENTS WRITE TO LIVE IN GENIE-HOST (the host split, P3.1: plan §11d). The window's replicas of them left with
 * the engine link's `engine.stores` (Tynn #955, 2g-4d E2a); what genie-host follows of them is AgentStoresService's own
 * events (its feature pushes, its phone registry, its registry watch). This pins what those events carry.
 */

const tick = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const A = 'agent_aaaa' as AgentId;

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

async function rig() {
    const dir = await mkdtemp(join(tmpdir(), 'stores-contract-'));
    dirs.push(dir);
    let clock = 0;
    const now = () => new Date(Date.UTC(2026, 10, 2, 12, 0, clock++)).toISOString();
    const inbox = await InboxStore.open(dir, now);
    const attention = await AttentionStore.open(dir, inbox, now);
    const knowledge = KnowledgeStore.open(dir, now);
    const approvals = new ApprovalQueue({ now: () => Date.UTC(2026, 10, 2) });
    const stores = new AgentStoresService({ inbox, attention, knowledge, approvals });
    return { stores, inbox, attention, knowledge, approvals, close: () => knowledge.close() };
}

/**
 * AN ATTENTION CHANGE SENDS ONLY WHAT CHANGED (Tynn #546). Every change to the questions sent the WHOLE attention data
 * to every link: on the owner's machine 8.6 MB of JSON per change (713 finished handoffs, up to 159 KB each, and 255
 * answered questions), serialized by the host and parsed by the window and the browser — the host's loop stalled 1–7 s
 * on beta.60. A question asked or updated touches the questions, nothing else; only what changed crosses.
 */
describe('an attention change sends only what changed (Tynn #546)', () => {
    it('after a long history, an ask, an update and an answer each send no finished handoff; each event has the part that changed', async () => {
        const r = await rig();
        const long = 'x'.repeat(200_000);
        for (let i = 0; i < 3; i += 1) await r.attention.imDone({ agentId: A, agentName: 'atlas', workspacePath: null, workspaceId: 'ws', handoff: `${long}${i}` });
        await tick();
        const sent: string[] = [];
        r.stores.onEvent((event) => { if (event.store === 'attention') sent.push(JSON.stringify(event)); });

        const questions = [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }] as never;
        const asked = await r.attention.ask({ agentId: A, agentName: 'atlas', workspaceId: 'ws', questions }, { userActive: true });
        await r.attention.update({ agentId: A, workspaceId: 'ws', questionId: asked.questionId, questions: [{ question: 'Ship it now?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }] as never });
        await tick();
        await r.stores.call('attention', 'answer', [asked.questionId, { selections: [['Yes']], notes: [''], note: '' }]);
        await tick();

        expect(sent.length).toBeGreaterThanOrEqual(3);
        for (const frame of sent) {
            expect(frame.length).toBeLessThan(20_000);
            expect(frame).not.toContain(long.slice(0, 1_000));
        }
        // What changed is in them: the question asked, then its new words; once answered it is no longer pending.
        const parts = sent.map((frame) => JSON.parse(frame) as { kind: string; parts?: { questions?: Array<{ id: string; questions: Array<{ question: string }> }> } });
        expect(parts.some((p) => p.parts?.questions?.some((q) => q.id === asked.questionId && q.questions[0]!.question === 'Ship it now?'))).toBe(true);
        expect(r.attention.pending()).toEqual([]);
        expect(r.attention.asked(asked.questionId)?.outcome).toBe('answered');
        r.close();
    });

    it('CONTROL: a finished handoff, when it IS the change, is in the event', async () => {
        const r = await rig();
        const sent: string[] = [];
        r.stores.onEvent((event) => { if (event.store === 'attention') sent.push(JSON.stringify(event)); });
        await r.attention.imDone({ agentId: A, agentName: 'atlas', workspacePath: null, workspaceId: 'ws', handoff: 'Shipped it.' });
        await tick();
        expect(sent.some((frame) => frame.includes('Shipped it.'))).toBe(true);
        r.close();
    });
});
