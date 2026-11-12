import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alertsBetween } from '../src/core/alert-diff.js';
import { deckBand, needsYouCount } from '../src/core/deck.js';
import { HUMAN } from '../src/core/inbox.js';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import { AttentionStore, type Finished, type PendingQuestion } from '../src/main/attention-store.js';
import { assembleDeckItems } from '../src/main/deck-assembly.js';
import { InboxStore, type InboxMessage } from '../src/main/inbox-store.js';
import { runtimeDir } from '../src/main/paths.js';

/*
 * HANDOFFS ARE FOR AGENTS, NOT THE PERSON (Tynn #658). The owner on the phone, 2026-11-12: "there are hundreds of
 * handoffs waiting for my attention", and then: "Handoffs are for agents, not humans. I should not have to mark them as
 * read." An imDone handoff is kept for the agent's next run (its handoff file, and Genie's record of finished turns),
 * and it is never an item waiting for the person: not on the phone's list, not on the Deck, not in the waiting count,
 * no read or clear action. The person sees the agent's state and its chat. Questions and approvals stay as they are.
 * The handoffs already stored (the hundreds waiting) stop showing the moment this ships, because nothing derives an
 * item from them any more.
 */

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
let dir: string;
let clock = T0;
const now = () => new Date(clock).toISOString();

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'handoffs-658-')); clock = T0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const agentA = 'agent_a' as AgentId;
const question: PendingQuestion = {
    id: 'q_1', key: 'k', agentId: agentA, agentName: 'atlas', workspaceId: 'tynn',
    questions: [{ header: 'Engine', question: 'Which engine?', options: [{ label: 'a' }, { label: 'b' }] }],
    priority: 'normal', askedAt: '2026-11-12T05:00:00.000Z',
};
const dm: InboxMessage = { seq: 1, id: 'msg_1', from: agentA as InboxMessage['from'], to: HUMAN, text: 'ping', attachments: [], sentAt: '2026-11-12T05:30:00.000Z', readAt: null };

/** The owner's list today: hundreds of stored handoffs, none of them ever marked read. */
const hundreds: Finished[] = Array.from({ length: 300 }, (_, i) => ({
    id: `fin_${i}`, agentId: `agent_${i % 9}` as AgentId, agentName: `agent${i % 9}`, handoff: `Handoff ${i}: PR up, next is the front door.`,
    at: new Date(T0 - (300 - i) * 60_000).toISOString(), seen: false,
}));

describe('the Deck and the phone (one assembly, deck-assembly.ts) never list a handoff', () => {
    it('hundreds of stored, unread handoffs make no item; the question and the mail are still there, the question first', () => {
        const attention = { pending: () => [question], allUserItems: () => [], finished: () => hundreds };
        const items = assembleDeckItems({
            workspaces: [{ id: 'tynn', path: '/w/tynn' }], approvals: [], trust: [], attention,
            inbox: { unread: () => [dm] }, agents: { agent_a: { name: 'atlas', workspaceId: 'tynn' } },
        });
        expect(items.map((i) => i.id)).toEqual(['q_1', 'msg_1']);
        expect(items.some((i) => i.id.startsWith('fin_'))).toBe(false);
        expect(deckBand(items).map((i) => i.id)).toEqual(['q_1', 'msg_1']);
        expect(needsYouCount(items)).toBe(2);
    });

    it('only handoffs waiting: nothing waits for the person', () => {
        const attention = { pending: () => [], allUserItems: () => [], finished: () => hundreds };
        const items = assembleDeckItems({ workspaces: [], approvals: [], trust: [], attention, inbox: { unread: () => [] }, agents: {} });
        expect(items).toEqual([]);
        expect(needsYouCount(items)).toBe(0);
    });
});

describe('the handoff is kept for agents', () => {
    it('imDone writes the agent\'s handoff file and Genie\'s record of it (the next run, and the agent\'s row, read it)', async () => {
        const store = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
        const r = await store.imDone({ agentId: agentA, agentName: 'atlas', workspacePath: dir, workspaceId: 'tynn', handoff: 'PR #15 is up.\nNext: the front door.' });
        expect(r.handoff.saved).toBe(true);
        expect(await readFile(join(dir, '.ai', 'handoff', 'atlas.md'), 'utf8')).toBe('PR #15 is up.\nNext: the front door.\n');
        expect(store.lastHandoff(agentA)).toEqual({ text: 'PR #15 is up.', at: T0 });
    });

    it('the record is bounded without anyone reading it: newest 20 per agent, nothing past 14 days but each agent\'s newest', async () => {
        const agents: AgentId[] = Array.from({ length: 4 }, () => mintAgentId());
        // 400 handoffs over 40 days, none ever seen (no one is asked to read them any more).
        const finished = Array.from({ length: 400 }, (_, i) => ({
            id: `fin_${i}`, agentId: agents[i % 4]!, agentName: `agent${i % 4}`, handoff: `Handoff ${i}`,
            at: new Date(T0 - (400 - i) * 0.1 * DAY).toISOString(), seen: false,
        }));
        // One agent that finished once, long ago: its handoff is what its next run reads, so it stays.
        const quiet = mintAgentId();
        finished.unshift({ id: 'fin_quiet', agentId: quiet, agentName: 'quiet', handoff: 'Left off at the migration.', at: new Date(T0 - 60 * DAY).toISOString(), seen: false });
        await mkdir(runtimeDir(dir), { recursive: true });
        await writeFile(join(runtimeDir(dir), 'attention.json'), JSON.stringify({ lists: [], questions: [], finished, asked: [] }));

        const store = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
        const kept = store.finished();
        for (const a of agents) {
            const mine = kept.filter((f) => f.agentId === a);
            expect(mine.length).toBeGreaterThan(0);
            expect(mine.length).toBeLessThanOrEqual(20);
            // Its newest is kept.
            expect(mine.at(-1)!.id).toBe(finished.filter((f) => f.agentId === a).at(-1)!.id);
        }
        for (const f of kept.filter((x) => x.agentId !== quiet)) expect(T0 - Date.parse(f.at)).toBeLessThanOrEqual(14 * DAY);
        expect(kept.filter((f) => f.agentId === quiet).map((f) => f.id)).toEqual(['fin_quiet']);
        expect(store.lastHandoff(quiet)).toEqual({ text: 'Left off at the migration.', at: T0 - 60 * DAY });
    });
});

describe('an agent finishing still sounds its alert (the person hears it; nothing is left to read)', () => {
    const row = (handoff: { text: string; at: number } | null) => ({ id: 'agent_a', name: 'atlas', workspaceId: 'tynn', state: 'idle', reason: null, handoff });

    it('a newer handoff on an agent\'s row is one "finished" alert, naming the agent and the handoff\'s first line', () => {
        const prev = { deckItems: [], agents: [row({ text: 'PR #14 merged.', at: 1 })] };
        const next = { deckItems: [], agents: [row({ text: 'PR #15 is up.', at: 2 })] };
        expect(alertsBetween(prev, next)).toEqual([{ kind: 'finished', workspace: 'tynn', agent: 'atlas', detail: 'atlas finished: PR #15 is up.' }]);
    });

    it('a first handoff on a known agent alerts; the same handoff again, or an agent newly listed with an old one, does not', () => {
        const first = { deckItems: [], agents: [row(null)] };
        const done = { deckItems: [], agents: [row({ text: 'PR #15 is up.', at: 2 })] };
        expect(alertsBetween(first, done).map((a) => a.kind)).toEqual(['finished']);
        expect(alertsBetween(done, done)).toEqual([]);
        expect(alertsBetween({ deckItems: [], agents: [] }, done)).toEqual([]);
    });
});
