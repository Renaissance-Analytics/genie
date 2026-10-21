import { describe, expect, it } from 'vitest';
import { activityFeed, FEED_ITEMS, HEARTBEAT_MINUTES, heartbeat } from '../src/core/activity-feed.js';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * AN AGENT'S ACTIVITY FEED — what its lane on the workspace Dashboard draws (beta.33 item 10). The owner, 2026-10-20:
 * "this workspace dashboard is useless. Each agent should have a full lane that shows me a heartbeat of activity. Not
 * some stupid card that contains my msg … THINK BETTER."
 *
 * Read from the agent's REAL session rows — the ledger the Stream shows, with the times they arrived — never from a
 * handoff it may or may not have filed ("Last finished" read the last `imDone` handoff, so it never updated).
 */

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 20, 14, 0);
let n = 0;
const at = (minutesAgo: number, event: StreamEvent, id = `r${n++}`): TimedEvent => ({ id, event, at: NOW - minutesAgo * MIN });
const tool = (over: Partial<Extract<StreamEvent, { kind: 'tool' }>>): StreamEvent => ({
    kind: 'tool', toolCallId: 't', name: 'Bash', title: null, status: 'completed', toolKind: 'execute', rawInput: null, ...over,
});
const say = (text: string, speaker: 'agent' | 'you' | 'peer' = 'agent', peerName: string | null = null): StreamEvent => ({ kind: 'message', speaker, peerName, text });
const idle: LiveSession = {
    running: true, turnState: 'idle', startedAt: NOW - 90 * MIN, pendingApproval: null, parkedAt: null, failure: null,
    contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null,
};
const feed = (rows: readonly TimedEvent[], session: LiveSession | null = idle) => activityFeed({ agentId: 'a', rows, session, now: NOW });

describe('the live feed — its real session events, newest first', () => {
    it('edits with their ± lines, commands, tool calls, replies, your prompts and turn ends, NEWEST FIRST (COUNTED)', () => {
        const items = feed([
            at(9, say('Fix the board', 'you')),
            at(8, { kind: 'turn', n: 4, by: 'you' }),
            at(7, tool({ toolCallId: 'c1', name: 'Bash', rawInput: { command: 'npm test' } })),
            at(6, tool({ toolCallId: 'e1', name: 'Edit', toolKind: 'edit', rawInput: { file_path: 'src/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' } })),
            at(5, tool({ toolCallId: 'g1', name: 'Grep', toolKind: 'search', rawInput: { pattern: 'lanes' } })),
            at(4, { kind: 'think', text: 'hmm', tokens: null }),
            at(3, { kind: 'usage', used: 1, size: 2, cost: null }),
            at(2, say('Done — the board is fixed.\nDetails below.')),
            at(1, { kind: 'finished', n: 4 }),
        ]).items;
        expect(items.map((i) => i.kind)).toEqual(['finished', 'reply', 'tool', 'edit', 'command', 'prompt']);
        expect(items[0]).toMatchObject({ text: 'Turn 4 finished' });
        expect(items[1]).toMatchObject({ text: 'Done — the board is fixed.' });
        expect(items[2]!.text).toContain('lanes');
        expect(items[3]).toMatchObject({ text: 'src/a.ts', plus: 2, minus: 1 });
        expect(items[4]).toMatchObject({ text: 'npm test', plus: null, minus: null });
        expect(items[5]).toMatchObject({ text: 'Fix the board', by: 'you' });
        // Each with the time it ARRIVED — the ledger's own time, not the time it was read.
        expect(items[0]!.at).toBe(NOW - 1 * MIN);
    });

    it('a call and its updates are ONE item with the latest status: running while it runs, failed when it failed', () => {
        const running = feed([
            at(2, tool({ toolCallId: 'c1', status: 'pending', rawInput: { command: 'npm ci' } })),
            at(1, tool({ toolCallId: 'c1', name: null, status: 'in_progress', toolKind: null, rawInput: null })),
        ]).items;
        expect(running).toHaveLength(1);
        expect(running[0]).toMatchObject({ kind: 'command', text: 'npm ci', status: 'running' });
        const failed = feed([
            at(2, tool({ toolCallId: 'c1', status: 'pending', rawInput: { command: 'npm ci' } })),
            at(1, tool({ toolCallId: 'c1', name: null, status: 'failed', toolKind: null, rawInput: null })),
        ]).items;
        expect(failed[0]).toMatchObject({ status: 'failed' });
    });

    it('a stopped turn is a turn end too, and says who stopped it', () => {
        expect(feed([at(1, { kind: 'stopped', n: 3, by: 'you' })]).items[0]).toMatchObject({ kind: 'stopped', text: 'Stopped by you' });
    });

    it('a peer’s message is a prompt BY that peer; an empty reply is not an item', () => {
        const items = feed([at(2, say('Take the drawer', 'peer', 'wren')), at(1, say('   '))]).items;
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ kind: 'prompt', by: 'wren', text: 'Take the drawer' });
    });

    it(`is BOUNDED: the newest ${FEED_ITEMS} items, never the whole history`, () => {
        const rows = Array.from({ length: FEED_ITEMS + 25 }, (_, i) => at(FEED_ITEMS + 25 - i, tool({ toolCallId: `c${i}`, rawInput: { command: `step ${i}` } })));
        const items = feed(rows).items;
        expect(items).toHaveLength(FEED_ITEMS);
        expect(items[0]!.text).toBe(`step ${FEED_ITEMS + 24}`);
    });
});

describe('the heartbeat — activity per minute over the last 30 minutes', () => {
    it(`counts the rows that ARRIVED in each minute; older than ${HEARTBEAT_MINUTES} minutes is not counted (COUNTED)`, () => {
        const f = feed([
            at(45, say('old')),
            at(10.5, tool({ toolCallId: 'a' })), at(10.2, tool({ toolCallId: 'b' })), at(10.1, tool({ toolCallId: 'c' })),
            at(0, say('now')),
        ]);
        const bars = heartbeat(f.beats, NOW);
        expect(bars).toHaveLength(HEARTBEAT_MINUTES);
        expect(bars.reduce((s, x) => s + x, 0)).toBe(4);
        // Oldest first: the last bar is THIS minute, so the three calls 10–11 minutes ago are 11 bars to its left.
        expect(bars[HEARTBEAT_MINUTES - 1 - 11]).toBe(3);
        expect(bars[HEARTBEAT_MINUTES - 1]).toBe(1);
    });

    it('slides with the clock: the same beats read later have moved left, and fall off the end', () => {
        const f = feed([at(1, say('x'))]);
        expect(heartbeat(f.beats, NOW).at(-2)).toBe(1);
        expect(heartbeat(f.beats, NOW + 5 * MIN).at(-7)).toBe(1);
        expect(heartbeat(f.beats, NOW + 40 * MIN).reduce((s, x) => s + x, 0)).toBe(0);
    });

    it('a row Genie holds no time for is not a beat (`at: null` — a thread that stored none)', () => {
        const f = feed([{ id: 'x', event: say('untimed'), at: null }]);
        expect(heartbeat(f.beats, NOW).reduce((s, x) => s + x, 0)).toBe(0);
        expect(f.items).toHaveLength(1);
    });
});

describe('plan, last activity, and how long it has been in its state', () => {
    it("PLAN is the session's latest plan event: step of, and the step in progress", () => {
        const plan = (statuses: string[]): StreamEvent => ({ kind: 'plan', entries: statuses.map((status, i) => ({ content: `step ${i + 1}`, status })) });
        expect(feed([at(5, plan(['completed', 'pending'])), at(2, plan(['completed', 'completed', 'in_progress', 'pending']))]).plan).toEqual({ step: 2, of: 4, doing: 'step 3' });
        expect(feed([at(2, say('no plan'))]).plan).toBeNull();
    });

    it('a working agent has been working since its turn began', () => {
        const f = feed([at(30, { kind: 'turn', n: 1, by: 'you' }), at(12, { kind: 'turn', n: 2, by: 'you' }), at(1, say('…'))], { ...idle, turnState: 'working' });
        expect(f.since).toBe(NOW - 12 * MIN);
        expect(f.running).toBe(true);
    });

    it('an idle one since its last turn ended; one waiting on you since the question was parked', () => {
        expect(feed([at(20, { kind: 'turn', n: 1, by: 'you' }), at(7, { kind: 'finished', n: 1 }), at(6, { kind: 'notice', level: 'debug', message: 'x' })]).since).toBe(NOW - 7 * MIN);
        expect(feed([at(20, { kind: 'turn', n: 1, by: 'you' })], { ...idle, turnState: 'working', pendingApproval: { question: 'Run rm?' } as never, parkedAt: NOW - 3 * MIN }).since).toBe(NOW - 3 * MIN);
    });

    it('a STOPPED agent (no session) is not running; its last activity is its newest timed row', () => {
        const f = feed([at(130, say('hi', 'you')), at(125, say('done')), { id: 'u', event: say('untimed'), at: null }], null);
        expect(f.running).toBe(false);
        expect(f.lastAt).toBe(NOW - 125 * MIN);
        expect(f.since).toBe(NOW - 125 * MIN);
    });
});
