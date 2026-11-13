import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alertsBetween, finishAlerts } from '../src/core/alert-diff.js';
import { deckBand, needsYouCount } from '../src/core/deck.js';
import { HUMAN } from '../src/core/inbox.js';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import { AttentionStore, type Finished, type PendingQuestion } from '../src/main/attention-store.js';
import { assembleDeckItems } from '../src/main/deck-assembly.js';
import { InboxStore, type InboxMessage } from '../src/main/inbox-store.js';
import { runtimeDir } from '../src/main/paths.js';
import { REMOTE_METHODS } from '../src/core/remote-protocol.js';
import { PHONE_METHODS } from '../src/main/host-alone-api.js';
import { WINDOW_CALLS } from '../src/main/agent-stores-host.js';

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
    at: new Date(T0 - (300 - i) * 60_000).toISOString(),
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
            at: new Date(T0 - (400 - i) * 0.1 * DAY).toISOString(),
        }));
        // One agent that finished once, long ago: its handoff is what its next run reads, so it stays.
        const quiet = mintAgentId();
        finished.unshift({ id: 'fin_quiet', agentId: quiet, agentName: 'quiet', handoff: 'Left off at the migration.', at: new Date(T0 - 60 * DAY).toISOString() });
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

describe('the newest HANDOFF is kept, not the newest finish', () => {
    it('an agent whose newest finish carries no handoff keeps its last real handoff, however old', async () => {
        const a = mintAgentId();
        const finished = [
            { id: 'fin_real', agentId: a, agentName: 'atlas', handoff: 'Left off at the migration.', at: new Date(T0 - 60 * DAY).toISOString() },
            { id: 'fin_bare', agentId: a, agentName: 'atlas', handoff: null, at: new Date(T0 - 1 * DAY).toISOString() },
        ];
        await mkdir(runtimeDir(dir), { recursive: true });
        await writeFile(join(runtimeDir(dir), 'attention.json'), JSON.stringify({ lists: [], questions: [], finished, asked: [] }));
        const store = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
        expect(store.finished().map((f) => f.id)).toContain('fin_real');
        expect(store.lastHandoff(a)).toEqual({ text: 'Left off at the migration.', at: T0 - 60 * DAY });
        // CONTROL: a bare finish older than the limit, with a newer handoff beside it, goes.
        const b = mintAgentId();
        const more = [
            { id: 'fin_bare_old', agentId: b, agentName: 'wren', handoff: null, at: new Date(T0 - 30 * DAY).toISOString() },
            { id: 'fin_b', agentId: b, agentName: 'wren', handoff: 'Done.', at: new Date(T0 - 1 * DAY).toISOString() },
        ];
        await writeFile(join(runtimeDir(dir), 'attention-history.json'), JSON.stringify({ finished: [...finished, ...more], asked: [] }));
        const again = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
        expect(again.finished().map((f) => f.id)).toEqual(['fin_real', 'fin_bare', 'fin_b']);
    });
});

describe('an agent finishing still sounds its alert, once (the person hears it; nothing is left to read)', () => {
    /*
     * The alert's high-water mark is the LAST handoff time seen for each agent, kept by the caller (App.tsx's ref) — not
     * the previous row. A row can lose its handoff and get the same one back (the replica rehydrating, a remote
     * reconnecting); read from the previous row, that alerted the same finish twice.
     */
    const row = (handoff: { text: string; at: number } | null, id = 'agent_a') => ({ id, name: 'atlas', workspaceId: 'tynn', state: 'idle', reason: null, handoff });

    it('a newer handoff is one "finished" alert, naming the agent and the handoff\u2019s first line', () => {
        const seen = new Map<string, number | null>([['agent_a', 1]]);
        const r = finishAlerts(seen, [row({ text: 'PR #15 is up.', at: 2 })]);
        expect(r.alerts).toEqual([{ kind: 'finished', workspace: 'tynn', agent: 'atlas', detail: 'atlas finished: PR #15 is up.' }]);
        expect(r.seen.get('agent_a')).toBe(2);
    });

    it('null, then the same handoff again, alerts nobody; a newer one after that alerts once', () => {
        let seen: ReadonlyMap<string, number | null> = new Map([['agent_a', 2]]);
        const gone = finishAlerts(seen, [row(null)]);
        expect(gone.alerts).toEqual([]);
        seen = gone.seen;
        const back = finishAlerts(seen, [row({ text: 'PR #15 is up.', at: 2 })]);
        expect(back.alerts).toEqual([]);
        seen = back.seen;
        expect(finishAlerts(seen, [row({ text: 'PR #16 is up.', at: 3 })]).alerts.map((a) => a.detail)).toEqual(['atlas finished: PR #16 is up.']);
    });

    it('the first look, and an agent newly listed with a handoff, alert nobody; a known agent\u2019s first handoff does', () => {
        const first = finishAlerts(new Map(), [row({ text: 'old', at: 5 })]);
        expect(first.alerts).toEqual([]);
        expect(first.seen.get('agent_a')).toBe(5);
        const known = finishAlerts(new Map([['agent_b', null]]), [row({ text: 'PR #15 is up.', at: 2 }, 'agent_b')]);
        expect(known.alerts.map((a) => a.kind)).toEqual(['finished']);
    });

    it('alertsBetween says nothing of finishes: one source for the alert', () => {
        const prev = { deckItems: [], agents: [row({ text: 'PR #14 merged.', at: 1 })] };
        const next = { deckItems: [], agents: [row({ text: 'PR #15 is up.', at: 2 })] };
        expect(alertsBetween(prev, next)).toEqual([]);
    });
});

describe('the person-facing handoff paths are gone (Tynn #658), and an older history still loads', () => {
    it('no Restart with handoff on the wire, the phone or a window; no markSeen on attention', () => {
        expect(REMOTE_METHODS as readonly string[]).not.toContain('restartWithHandoff');
        expect([...PHONE_METHODS] as string[]).not.toContain('restartWithHandoff');
        expect(WINDOW_CALLS.attention).not.toContain('markSeen');
        expect((AttentionStore.prototype as unknown as Record<string, unknown>)['markSeen']).toBeUndefined();
        expect(existsSync(new URL('../src/main/restart-with-handoff.ts', import.meta.url))).toBe(false);
    });

    it('a finish is recorded without a seen flag; records written with one still load and read', async () => {
        await mkdir(runtimeDir(dir), { recursive: true });
        const old = [
            { id: 'fin_old1', agentId: agentA, agentName: 'atlas', handoff: 'Read once.', at: new Date(T0 - DAY).toISOString(), seen: true },
            { id: 'fin_old2', agentId: agentA, agentName: 'atlas', handoff: 'Never read.', at: new Date(T0 - 1000).toISOString(), seen: false },
        ];
        await writeFile(join(runtimeDir(dir), 'attention.json'), JSON.stringify({ lists: [], questions: [], finished: old, asked: [] }));
        const store = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
        expect(store.finished().map((f) => f.id)).toEqual(['fin_old1', 'fin_old2']);
        expect(store.lastHandoff(agentA)).toEqual({ text: 'Never read.', at: T0 - 1000 });
        await store.imDone({ agentId: agentA, agentName: 'atlas', workspacePath: null, workspaceId: 'tynn', handoff: 'New.' });
        expect(store.finished().at(-1)).not.toHaveProperty('seen');
    });
});
