import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute } from '../src/core/route.js';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { turnCards } from '../src/core/turn-cards.js';

/**
 * THE `turns` LAYOUT (the board: `&layout=turns`): the Stream folded into one card per turn — `Turn 12`, `14:03 ·
 * 9 tools · 2 edits · 14k tok`, outcome chips (`ChallengeStore.php +16 −4`, `wren → sable`), the latest turn open
 * with its rows, the others collapsed. Everything counted from the rows, like the index column; the ledger is the
 * default and writes no `layout=`.
 */
let n = 0;
const row = (event: StreamEvent, id = `a1:${n++}`, at = 1_000 + n * 60_000): TimedEvent => ({ id, event, at });
const tool = (name: string, extra: Partial<Extract<StreamEvent, { kind: 'tool' }>> = {}): StreamEvent => ({
    kind: 'tool', toolCallId: `c${n}`, name, title: null, status: 'completed', toolKind: name === 'Edit' ? 'edit' : 'execute', rawInput: null, ...extra,
});
const ROOT = '/w/tynn';
const rows: TimedEvent[] = [
    row({ kind: 'turn', n: 12, by: 'you' }, 't12', 1_000),
    row(tool('Bash'), 'b1'),
    row(tool('Edit', { rawInput: { file_path: `${ROOT}/src/ChallengeStore.php`, old_string: 'a', new_string: 'a\nb\nc' } }), 'e1'),
    row({ kind: 'message', speaker: 'peer', peerName: 'wren', text: 'ping' }, 'm1'),
    row({ kind: 'usage', used: 14_000, size: 200_000, cost: null }, 'u1'),
    row({ kind: 'turn', n: 13, by: 'you' }, 't13', 121_000),
    row(tool('Bash'), 'b2'),
    row({ kind: 'message', speaker: 'agent', peerName: null, text: 'done' }, 'm2'),
];
const session = (over: Partial<LiveSession> = {}): LiveSession =>
    ({ running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, ...over }) as LiveSession;

describe('the route', () => {
    it('`layout=turns` parses; the ledger is the default and writes nothing', () => {
        expect(parseRoute('genie://agent/kai?tab=stream&layout=turns')).toMatchObject({ surface: 'agent', layout: 'turns' });
        expect(parseRoute('genie://agent/kai?tab=stream')).toMatchObject({ surface: 'agent', layout: 'ledger' });
        expect(parseRoute('genie://agent/kai?tab=stream&layout=bogus')).toMatchObject({ layout: 'ledger' });
        expect(formatRoute({ surface: 'agent', agentId: 'kai', tab: 'stream', lane: null, at: null, range: null, layout: 'turns', chat: null, pin: null })).toBe('genie://agent/kai?tab=stream&layout=turns');
        expect(formatRoute({ surface: 'agent', agentId: 'kai', tab: 'stream', lane: null, at: null, range: null, layout: 'ledger', chat: null, pin: null })).toBe('genie://agent/kai?tab=stream');
    });
});

describe('turnCards', () => {
    it('one card per turn in ledger order; the latest says `now` and is open; counts, the context delta, the outcome chips, the rows inside', () => {
        const cards = turnCards(rows, session(), ROOT)!;
        expect(cards.map((c) => c.title)).toEqual(['Turn 12', 'Turn 13 · now']);
        expect(cards[0]).toMatchObject({ n: 12, at: 1_000, open: false, meta: '1 tool · 1 edit · 14k tok', rowIds: ['b1', 'e1', 'm1', 'u1'] });
        expect(cards[0]!.chips).toEqual([
            { icon: 'file-code', tone: 'ok', label: 'src/ChallengeStore.php +2' },
            { icon: 'arrow-right-left', tone: 'violet', label: 'wren → you' },
        ]);
        expect(cards[1]).toMatchObject({ n: 13, at: 121_000, open: true, meta: '1 tool · 0 edits', rowIds: ['b2', 'm2'], chips: [] });
    });

    it('two files in one turn fold into one chip with the sums; a path outside the root is not a chip', () => {
        const two = [
            row({ kind: 'turn', n: 1, by: 'you' }, 'tA', 1_000),
            row(tool('Edit', { rawInput: { file_path: `${ROOT}/a.ts`, old_string: 'x', new_string: 'x\ny' } }), 'eA'),
            row(tool('Edit', { rawInput: { file_path: `${ROOT}/b.ts`, old_string: 'p\nq', new_string: 'p' } }), 'eB'),
            row(tool('Edit', { rawInput: { file_path: '/etc/passwd', old_string: 'r', new_string: 'r\ns' } }), 'eC'),
        ];
        expect(turnCards(two, session(), ROOT)![0]!.chips).toEqual([{ icon: 'file-code', tone: 'ok', label: '2 files +1 −1' }]);
    });

    it('the latest turn’s suffix follows the session: parked, ended; none without a session', () => {
        expect(turnCards(rows, session({ pendingApproval: { id: 'ap', question: 'q', options: [] } as unknown as LiveSession['pendingApproval'] }), ROOT)![1]!.title).toBe('Turn 13 · parked');
        expect(turnCards(rows, session({ turnState: 'failed', failure: { reason: 'exit 137', fixes: [] } }), ROOT)![1]!.title).toBe('Turn 13 · ended');
        expect(turnCards(rows, null, ROOT)![1]!.title).toBe('Turn 13');
    });

    it('no turn markers → null: nothing is drawn as one long turn', () => {
        expect(turnCards(rows.filter((r) => r.event.kind !== 'turn'), session(), ROOT)).toBeNull();
        expect(turnCards([], session(), ROOT)).toBeNull();
    });
});
