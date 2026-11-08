import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import { SETTINGS } from '../src/core/settings.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { runtimeDir } from '../src/main/paths.js';

/*
 * genie-host REWROTE THE WHOLE attention.json ON EVERY QUESTION CHANGE (Tynn #549). Measured on the owner's machine on
 * 2026-11-08: 8.6 MB — 713 finished handoffs (the largest 159 KB, 8.1 MB in all), 255 answered questions (478 KB), lists
 * 21 KB, questions 12 KB — and "PRIVATE_FILE_SLOW_WRITE 13688 ms". The owner's choice: keep the last 20 finished
 * handoffs per agent; drop seen ones older than 14 days (an unseen one is always kept); store at most 8 KB of a handoff
 * (the whole text is the agent's handoff file); and split the file, so a question asked writes kilobytes. The three
 * numbers are settings. Acceptance: a question asked on the owner's history writes under 100 KB and takes under 50 ms.
 */

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
let dir: string;
let clock = T0;
const now = () => new Date(clock).toISOString();
const agents: AgentId[] = Array.from({ length: 12 }, () => mintAgentId());

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'attention-bounded-')); clock = T0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const question = (i: number) => ({ header: 'Next', question: `Question ${i}: ${'q'.repeat(300)}`, options: [{ label: 'Agent: do it' }, { label: 'You: hold' }] });

/** The owner's history, in the old single-file form: 713 finished (8.1 MB), 255 answered (≈480 KB), 21 KB of lists, 7 pending. */
async function ownersHistory(): Promise<void> {
    const finished = Array.from({ length: 713 }, (_, i) => {
        const size = i % 50 === 0 ? 159_000 : 9_800;
        return {
            id: `fin_${i}`, agentId: agents[i % agents.length]!, agentName: `agent${i % agents.length}`,
            handoff: `Handoff ${i}\n${'h'.repeat(size)}`,
            at: new Date(T0 - (713 - i) * 0.05 * DAY).toISOString(),
            // The newest 40 are unseen (the Deck's "Since you looked").
            seen: i < 673,
        };
    });
    const asked = Array.from({ length: 255 }, (_, i) => ({
        id: `q_old_${i}`, agentId: agents[i % agents.length]!, agentName: 'a', askedAt: new Date(T0 - DAY).toISOString(), at: new Date(T0 - DAY).toISOString(),
        outcome: 'answered', questions: [question(i), question(i + 1)], selections: [['Agent: do it'], []], notes: ['n'.repeat(200), ''], note: '',
    }));
    const lists = Array.from({ length: 120 }, (_, i) => ({ list: 'user', workspaceId: 'ws', item: { id: `li_${i}`, text: 't'.repeat(140), askedBy: agents[0], createdAt: now(), done: false } }));
    const questions = Array.from({ length: 7 }, (_, i) => ({ id: `q_p${i}`, key: `k${i}`, agentId: agents[i]!, agentName: 'a', workspaceId: 'ws', questions: [question(i)], priority: 'normal', askedAt: new Date(T0 - 3 * DAY).toISOString() }));
    await mkdir(runtimeDir(dir), { recursive: true });
    await writeFile(join(runtimeDir(dir), 'attention.json'), JSON.stringify({ lists, questions, finished, asked }));
}

async function sizes(): Promise<Map<string, { size: number; mtimeMs: number }>> {
    const out = new Map<string, { size: number; mtimeMs: number }>();
    for (const f of await readdir(runtimeDir(dir))) {
        if (!f.startsWith('attention')) continue;
        const s = await stat(join(runtimeDir(dir), f));
        out.set(f, { size: s.size, mtimeMs: s.mtimeMs });
    }
    return out;
}

describe('a question asked on the owner\'s history (Tynn #549 acceptance)', () => {
    it('writes under 100 KB and takes under 50 ms (the median of 5 asks)', async () => {
        await ownersHistory();
        const inbox = await InboxStore.open(dir, now);
        const store = await AttentionStore.open(dir, inbox, now);
        const took: number[] = [];
        for (let i = 0; i < 5; i += 1) {
            const before = await sizes();
            // Some file systems keep mtimes coarse: a beat, so a write is seen as one.
            await new Promise((r) => setTimeout(r, 30));
            const t = performance.now();
            await store.ask({ agentId: agents[i]!, agentName: 'atlas', workspaceId: 'ws', questions: [question(1000 + i)] }, { userActive: true });
            took.push(performance.now() - t);
            const after = await sizes();
            const written = [...after].filter(([f, s]) => before.get(f)?.mtimeMs !== s.mtimeMs || before.get(f)?.size !== s.size).reduce((n, [, s]) => n + s.size, 0);
            expect(written, `ask ${i + 1} wrote ${written} bytes`).toBeLessThan(100_000);
            // CONTROL: the ask did write (the question is on disk, not only in memory).
            expect(written).toBeGreaterThan(0);
        }
        took.sort((a, b) => a - b);
        expect(took[2]!, `asks took ${took.map((t) => t.toFixed(1)).join(', ')} ms`).toBeLessThan(50);
        expect(store.pending()).toHaveLength(12);
    }, 60_000);
});

describe('the finished history is bounded (Tynn #549)', () => {
    it('keeps at most 20 per agent, never drops an unseen one, drops seen ones older than 14 days, and keeps each handoff\'s first 8 KB', async () => {
        await ownersHistory();
        const store = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
        const finished = store.finished();
        // Every unseen one is kept.
        expect(finished.filter((f) => !f.seen).map((f) => f.id)).toEqual(Array.from({ length: 40 }, (_, i) => `fin_${673 + i}`));
        // No seen one older than 14 days.
        for (const f of finished.filter((x) => x.seen)) expect(T0 - Date.parse(f.at)).toBeLessThanOrEqual(14 * DAY);
        // At most 20 per agent, unseen ones aside.
        for (const a of agents) expect(finished.filter((f) => f.agentId === a && f.seen).length).toBeLessThanOrEqual(20);
        // At most 8 KB of a handoff; a cut one says it was cut.
        for (const f of finished) expect(Buffer.byteLength(f.handoff ?? '')).toBeLessThanOrEqual(8 * 1024 + 200);
        const cut = finished.find((f) => f.id === 'fin_700')!;
        expect(cut.handoff).toMatch(/^Handoff 700\nh+/);
        expect(cut.handoff).toMatch(/cut at 8 KB; the whole handoff is in the agent's handoff file/);
        // Oldest first, as before.
        expect(finished.map((f) => Date.parse(f.at))).toEqual([...finished.map((f) => Date.parse(f.at))].sort((a, b) => a - b));
    });

    it('a new handoff over 8 KB is stored cut; an imDone on a full agent drops its oldest seen one', async () => {
        const store = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
        const a = agents[0]!;
        for (let i = 0; i < 25; i += 1) {
            await store.imDone({ agentId: a, agentName: 'atlas', workspacePath: null, workspaceId: 'ws', handoff: `run ${i} ${'z'.repeat(i === 24 ? 20_000 : 10)}` });
            store.markSeen(store.finished().at(-1)!.id);
            clock += 1_000;
        }
        await store.imDone({ agentId: a, agentName: 'atlas', workspacePath: null, workspaceId: 'ws', handoff: 'the last' });
        const mine = store.finished().filter((f) => f.agentId === a);
        expect(mine.filter((f) => f.seen).length).toBeLessThanOrEqual(20);
        expect(mine.at(-1)!.handoff).toBe('the last');
        expect(Buffer.byteLength(mine.find((f) => f.handoff?.startsWith('run 24'))!.handoff!)).toBeLessThanOrEqual(8 * 1024 + 200);
    });

    it('the three numbers are settings, and a changed setting is what the next prune keeps', async () => {
        const keys = SETTINGS.map((s) => s.key);
        expect(keys).toEqual(expect.arrayContaining(['finished_kept_per_agent', 'finished_seen_days', 'handoff_kept_kb']));
        const def = (k: string) => SETTINGS.find((s) => s.key === k) as { default: string; scope: string };
        expect([def('finished_kept_per_agent').default, def('finished_seen_days').default, def('handoff_kept_kb').default]).toEqual(['20', '14', '8']);
        expect(def('finished_kept_per_agent').scope).toBe('host');

        await ownersHistory();
        const store = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
        (store as unknown as { useLimits(l: () => { keptPerAgent: number; seenDays: number; handoffKb: number }): void })
            .useLimits(() => ({ keptPerAgent: 5, seenDays: 14, handoffKb: 2 }));
        await store.imDone({ agentId: agents[0]!, agentName: 'a', workspacePath: null, workspaceId: 'ws', handoff: 'x'.repeat(5_000) });
        for (const a of agents) expect(store.finished().filter((f) => f.agentId === a && f.seen).length).toBeLessThanOrEqual(5);
        expect(Buffer.byteLength(store.finished().at(-1)!.handoff!)).toBeLessThanOrEqual(2 * 1024 + 200);
    });
});

describe('the file is split, and an older one is read', () => {
    it('questions and lists in attention.json, the history apart; reopened, everything is there', async () => {
        await ownersHistory();
        const store = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
        const kept = { finished: store.finished().length, pending: store.pending().length };
        await store.ask({ agentId: agents[0]!, agentName: 'atlas', workspaceId: 'ws', questions: [question(9_999)] }, { userActive: true });
        const main = JSON.parse(await readFile(join(runtimeDir(dir), 'attention.json'), 'utf8')) as Record<string, unknown>;
        expect(main.finished).toBeUndefined();
        expect(main.asked).toBeUndefined();
        const reopened = await AttentionStore.open(dir, await InboxStore.open(dir, now), now);
        expect(reopened.finished().length).toBe(kept.finished);
        expect(reopened.pending().length).toBe(kept.pending + 1);
        expect(reopened.asked('q_old_3')).not.toBeNull();
    });
});
