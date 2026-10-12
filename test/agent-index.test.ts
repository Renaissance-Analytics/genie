import { describe, expect, it } from 'vitest';
import { agentIndex } from '../src/core/agent-index.js';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE LEFT INDEX COLUMN (the board, 216px): **Turns** — `Turn 14 · now` with a live dot, `6 tools · 3 edits ·
 * 9.8k tok`, `— compacted —`, `Turn 9 · ended · no result` — and **Files touched** — `ChallengeStore.php · 3 edits ·
 * +58 −12`. Every figure from the rows themselves: tools and edits are counted, tokens are the context delta the
 * usage rows report inside the turn, line counts come from the edit's own before-and-after. No turn markers → no
 * column (`null`): a replayed transcript Genie has no boundaries for is not drawn as one long turn.
 */

let n = 0;
const row = (event: StreamEvent, id = `a1:${n++}`): TimedEvent => ({ id, event, at: 1_000 + n });
const tool = (name: string, extra: Partial<Extract<StreamEvent, { kind: 'tool' }>> = {}): StreamEvent => ({
    kind: 'tool', toolCallId: `c${n}`, name, title: null, status: 'completed', toolKind: name === 'Edit' || name === 'Write' ? 'edit' : 'execute', rawInput: null, ...extra,
});
const edit = (file_path: string, old_string: string, new_string: string) => tool('Edit', { rawInput: { file_path, old_string, new_string } });

const ROOT = '/w/tynn';
const rows: TimedEvent[] = [
    row({ kind: 'turn', n: 1, by: 'you' }, 't1'),
    row(tool('Bash'), 'b1'),
    row(edit(`${ROOT}/src/A.php`, 'a\nb', 'a\nb\nc'), 'e1'),
    row({ kind: 'usage', used: 6_200, size: 200_000, cost: null }, 'u1'),
    row({ kind: 'turn', n: 2, by: 'you' }, 't2'),
    row(tool('Bash'), 'b2'),
    row(tool('Bash'), 'b3'),
    row({ kind: 'divider', variant: 'compaction', before: 189_000, after: 46_000 }, 'c1'),
    row({ kind: 'turn', n: 3, by: null }, 't3'),
    row(edit(`${ROOT}/src/A.php`, 'a\nb\nc', 'a\nb\nc\nd\ne'), 'e2'),
    row(tool('Write', { rawInput: { file_path: `${ROOT}/src/B.php`, content: 'new' } }), 'e3'),
    row(edit('/etc/passwd', 'root', 'toor'), 'e4'),
];

const session = (over: Partial<LiveSession> = {}): LiveSession =>
    ({ running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, ...over }) as LiveSession;

describe('Turns', () => {
    it('latest first; the live turn says `now` with a green dot and is selected; counts and the context delta per turn; the compaction between them', () => {
        const index = agentIndex(rows, session(), ROOT, null);
        expect(index).not.toBeNull();
        const turns = index!.find((s) => s.title === 'Turns')!;
        expect(turns.items.map((i) => i.label)).toEqual(['Turn 3 · now', '— compacted —', 'Turn 2', 'Turn 1']);
        // Three edits: two inside the workspace and one outside it — the count is what the agent DID; the Files list is what it may claim.
        expect(turns.items[0]).toMatchObject({ id: 'turn:3', live: 'ok', selected: true, rowId: 't3', meta: '0 tools · 3 edits' });
        expect(turns.items[1]).toMatchObject({ id: 'compacted:c1', live: null, selected: false, rowId: 'c1', meta: '189k → 46k' });
        expect(turns.items[2]).toMatchObject({ live: null, selected: false, rowId: 't2', meta: '2 tools · 0 edits' });
        // 1 tool, 1 edit, and the usage row inside the turn: 6.2k of context since the session started.
        expect(turns.items[3]).toMatchObject({ rowId: 't1', meta: '1 tool · 1 edit · 6.2k tok' });
    });

    it('parked → amber `parked`; failed → red `ended` with `no result`; idle → no suffix and no dot; no session → no claim', () => {
        const parked = agentIndex(rows, session({ pendingApproval: { id: 'ap', question: 'Run it?', options: [] } as unknown as LiveSession['pendingApproval'] }), ROOT, null)!;
        expect(parked[0]!.items[0]).toMatchObject({ label: 'Turn 3 · parked', live: 'warn' });

        const failed = agentIndex(rows, session({ turnState: 'failed', failure: { reason: 'exit 137', fixes: [] } }), ROOT, null)!;
        expect(failed[0]!.items[0]).toMatchObject({ label: 'Turn 3 · ended', live: 'bad', meta: 'no result · 0 tools · 3 edits' });

        const idle = agentIndex(rows, session({ turnState: 'idle' }), ROOT, null)!;
        expect(idle[0]!.items[0]).toMatchObject({ label: 'Turn 3', live: null });

        const none = agentIndex(rows, null, ROOT, null)!;
        expect(none[0]!.items[0]).toMatchObject({ label: 'Turn 3', live: null });
    });

    it('the selected turn follows the selected row; without one, the latest', () => {
        const index = agentIndex(rows, session(), ROOT, 'e1')!;
        expect(index[0]!.items.map((i) => i.selected)).toEqual([false, false, false, true]);
    });

    it('no turn markers → null: Genie has no boundaries for these rows and does not draw one long turn', () => {
        expect(agentIndex([], session(), ROOT, null)).toBeNull();
        expect(agentIndex(rows.filter((r) => r.event.kind !== 'turn'), session(), ROOT, null)).toBeNull();
    });
});

describe('Files touched', () => {
    it('one item per file inside the workspace, most recently touched first, edits counted, line counts only from a real diff; a path outside the root is not listed', () => {
        const files = agentIndex(rows, session(), ROOT, null)!.find((s) => s.title === 'Files touched')!;
        expect(files.items.map((i) => i.label)).toEqual(['src/B.php', 'src/A.php']);
        // A Write carries no before-and-after: edits counted, no `+n`.
        expect(files.items[0]).toMatchObject({ id: 'file:src/B.php', meta: '1 edit', mono: true, rowId: 'e3' });
        // +1 then +2 across two edits — both pure appends, so any diff engine counts them the same way.
        expect(files.items[1]).toMatchObject({ id: 'file:src/A.php', meta: '2 edits · +3', mono: true, rowId: 'e2' });
        expect(files.items.some((i) => i.label.includes('passwd'))).toBe(false);
    });

    it('without a workspace root there is no Files touched section — paths cannot be confined, so nothing is claimed', () => {
        const index = agentIndex(rows, session(), null, null)!;
        expect(index.map((s) => s.title)).toEqual(['Turns']);
    });
});
