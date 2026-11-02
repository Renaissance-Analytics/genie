import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { HUMAN } from '../src/core/inbox.js';
import type { AgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentStoresService } from '../src/main/agent-stores-host.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { KnowledgeStore } from '../src/main/knowledge-store.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';

/**
 * A SLOW DISK, ON DEMAND. The attention store applies a change in memory at once and ANNOUNCES it (the event a replica
 * hears) only once its file write lands (attention-store.ts #flush: writeJsonAtomic, then onChange). A CI runner's disk once
 * took longer than a fixed wait (PR #1451's run, then #1452's): the store read `seen: true`, the replica still `false`.
 * Here the write is held `slowWrites.ms` (0 — no change — unless a test sets it), so that race happens every run.
 */
const slowWrites = vi.hoisted(() => ({ ms: 0 }));
vi.mock('../src/main/store.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../src/main/store.js')>();
    return {
        ...real,
        writeJsonAtomic: async (...args: Parameters<typeof real.writeJsonAtomic>) => {
            if (slowWrites.ms > 0) await new Promise((r) => setTimeout(r, slowWrites.ms));
            return real.writeJsonAtomic(...args);
        },
    };
});
afterEach(() => { slowWrites.ms = 0; });

/**
 * THE STORES AGENTS WRITE TO LIVE IN GENIE-HOST; THE WINDOW HOLDS REPLICAS (the host split, P3.1: plan §11d).
 *
 * The contract: the real stores behind the engine link, and the window's replicas in front of it, answer the SAME after
 * every write — whoever made it (an agent's tool in the host, or the person in the window). Reads in the window stay
 * synchronous (the Deck and the snapshots read them many times a second); writes go to the host; the events the window
 * keys on (a message sent, mail read, a question changed or left) fire from the replica after its state has caught up.
 */

const TOKEN = 'stores-token';
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const tick = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const A = 'agent_aaaa' as AgentId;
const B = 'agent_bbbb' as AgentId;

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
    const server = new SessionEngineServer({ token: TOKEN, build: 't', stores });
    const host = new SessionHost({ userData: dir, driverFor: () => null, processTree: noProcessTree, ...server.hostOptions() });
    server.attach(host);
    const [hostSide, windowSide] = memoryPair();
    server.accept(hostSide);
    const client = new SessionEngineClient();
    expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
    const replica = client.stores();
    return { server, inbox, attention, knowledge, approvals, replica, client, windowSide, close: () => knowledge.close() };
}

describe('the inbox replica answers what the store answers', () => {
    it('after an agent sends (in the host) and the person sends (from the window): all, unread, involving, receipts, hasWritten', async () => {
        const r = await rig();
        await r.inbox.send({ from: A, to: HUMAN, text: 'done with the build' });
        await r.replica.inbox.send({ from: HUMAN, to: A, text: 'thanks' });
        await r.inbox.send({ from: A, to: B, text: 'your turn' });
        await tick();
        expect(r.replica.inbox.all()).toEqual(r.inbox.all());
        expect(r.replica.inbox.unread(HUMAN)).toEqual(r.inbox.unread(HUMAN));
        expect(r.replica.inbox.unread(B)).toEqual(r.inbox.unread(B));
        expect(r.replica.inbox.involving(A, 50)).toEqual(r.inbox.involving(A, 50));
        expect(r.replica.inbox.receipts(A)).toEqual(r.inbox.receipts(A));
        expect(r.replica.inbox.hasWritten(HUMAN, A)).toBe(true);
        expect(r.replica.inbox.hasWritten(B, A)).toBe(r.inbox.hasWritten(B, A));
        r.close();
    });

    it('after a receive (read marks and the cursor) and a deleted thread, it still answers the same', async () => {
        const r = await rig();
        await r.inbox.send({ from: A, to: HUMAN, text: 'one' });
        await r.inbox.send({ from: A, to: HUMAN, text: 'two' });
        await r.inbox.send({ from: B, to: A, text: 'hello' });
        await r.replica.inbox.receive({ participant: HUMAN, limit: 1 });
        await tick();
        expect(r.replica.inbox.unread(HUMAN)).toEqual(r.inbox.unread(HUMAN));
        expect(r.replica.inbox.unread(HUMAN).map((m) => m.text)).toEqual(['two']); // CONTROL: the receive did read one
        expect(r.replica.inbox.all()).toEqual(r.inbox.all());
        await r.replica.inbox.deleteThread(A, B);
        await tick();
        expect(r.replica.inbox.all()).toEqual(r.inbox.all());
        expect(r.replica.inbox.all().some((m) => m.text === 'hello')).toBe(false);
        r.close();
    });

    it('a message sent in the host fires the replica\'s onSend AFTER its state has it; a read fires onRead with the ids', async () => {
        const r = await rig();
        const seen: Array<[string, boolean]> = [];
        r.replica.inbox.onSend((to, message) => seen.push([`${to}:${message.text}`, r.replica.inbox.all().some((m) => m.id === message.id)]));
        const reads: Array<[string, number]> = [];
        r.replica.inbox.onRead((reader, ids) => reads.push([reader, ids?.length ?? 0]));
        await r.inbox.send({ from: A, to: HUMAN, text: 'ping' });
        await tick();
        await r.inbox.receive({ participant: HUMAN });
        await tick();
        expect(seen).toEqual([['human:ping', true]]);
        expect(reads).toEqual([['human', 1]]);
        r.close();
    });

    it('a window that connects later starts from the whole mail (the dump), not from nothing', async () => {
        const r = await rig();
        await r.inbox.send({ from: A, to: HUMAN, text: 'before you came' });
        await r.attention.imDone({ agentId: A, agentName: 'atlas', workspacePath: null, workspaceId: 'ws', handoff: 'Done.' });
        const late = new SessionEngineClient();
        const [h, w] = memoryPair();
        r.server.accept(h);
        expect(await late.connect(w, TOKEN)).toMatchObject({ ok: true });
        // Ready means the replica is whole: no read in the window ever sees an empty inbox that is not.
        expect(late.stores().inbox.all()).toEqual(r.inbox.all());
        expect(late.stores().attention.finished()).toEqual(r.attention.finished());
        r.close();
    });
});

describe('the attention replica answers what the store answers', () => {
    it('a question asked in the host is pending in the window; answered from the window it leaves both, and the asker is mailed', async () => {
        const r = await rig();
        const changes: number[] = [];
        r.replica.attention.onChange(() => changes.push(r.replica.attention.pending().length));
        const left: string[] = [];
        r.replica.attention.onLeave((id, outcome) => left.push(`${id}:${outcome.kind}`));
        const asked = await r.attention.ask({ agentId: A, agentName: 'atlas', workspaceId: 'ws', questions: [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }] as never }, { userActive: true });
        await tick();
        expect(r.replica.attention.pending()).toEqual(r.attention.pending());
        expect(changes.at(-1)).toBe(1);
        await r.replica.attention.answer(asked.questionId, { selections: [['Yes']], notes: [''], note: '' } as never);
        await tick();
        expect(r.replica.attention.pending()).toEqual([]);
        expect(r.attention.pending()).toEqual([]);
        expect(left).toEqual([`${asked.questionId}:${r.attention.leftOutcome(asked.questionId)?.kind}`]);
        expect(r.replica.attention.asked(asked.questionId)).toEqual(r.attention.asked(asked.questionId));
        expect(r.replica.inbox.unread(A).length).toBe(1); // the answer is mail to the asker, from you
        r.close();
    });

    it('imDone, the lists and markSeen: finished, lastHandoff, allUserItems and lists.show answer the same', async () => {
        const r = await rig();
        await r.attention.imDone({ agentId: A, agentName: 'atlas', workspacePath: null, workspaceId: 'ws', handoff: 'Shipped the fix.\nNext: tests.' });
        await r.attention.lists.add({ list: 'user', workspaceId: 'ws', agentId: A, text: 'review the PR' });
        await tick();
        expect(r.replica.attention.finished()).toEqual(r.attention.finished());
        expect(r.replica.attention.lastHandoff(A)).toEqual(r.attention.lastHandoff(A));
        expect(r.replica.attention.allUserItems()).toEqual(r.attention.allUserItems());
        expect(r.replica.attention.lists.show({ list: 'user', workspaceId: 'ws', agentId: A })).toEqual(r.attention.lists.show({ list: 'user', workspaceId: 'ws', agentId: A }));
        const finishedId = r.attention.finished()[0]!.id;
        // The write behind markSeen lands 100 ms late: the replica hears it only then.
        slowWrites.ms = 100;
        r.replica.attention.markSeen(finishedId);
        await tick(8);
        expect(r.attention.finished()[0]!.seen).toBe(true);
        expect(r.replica.attention.finished()).toEqual(r.attention.finished());
        r.close();
    });
});

describe('approvals and knowledge', () => {
    it('a gated action waits in the host\'s queue, shows on the window\'s Deck, and the window\'s verdict releases it', async () => {
        const r = await rig();
        const verdict = r.approvals.gate({ agentId: A, agentName: 'atlas', workspaceId: 'ws', workspacePath: '/w' }, 'terminal.create', 'npm test');
        await tick();
        expect(r.replica.approvals.deckItems()).toEqual(r.approvals.deckItems());
        expect(r.replica.approvals.deckItems()).toHaveLength(1);
        expect(await r.replica.approvals.resolve(r.approvals.deckItems()[0]!.id, 'allow')).toBe(true);
        expect(await verdict).toBe('allowed');
        await tick();
        expect(r.replica.approvals.deckItems()).toEqual([]);
        r.close();
    });

    it('knowledge is the host\'s: added from the window, found from the window, there in the host', async () => {
        const r = await rig();
        const added = await r.replica.knowledge.add({ title: 'Deploy steps', body: 'Run the release script.', scope: { kind: 'system' }, source: 'user' } as never);
        expect(r.knowledge.get(added.id)?.title).toBe('Deploy steps');
        const found = await r.replica.knowledge.search({ query: 'release script', scopes: 'all' } as never);
        expect(found.hits.map((h) => h.id)).toContain(added.id);
        expect((await r.replica.knowledge.list({ scopes: 'all', limit: 10 } as never)).nodes.map((n) => n.id)).toEqual(r.knowledge.list({ scopes: 'all', limit: 10 } as never).nodes.map((n) => n.id));
        r.close();
    });
});
