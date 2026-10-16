import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { INDEX_COLLAPSED_KEY, readIndexCollapsed, turnNumbers, writeIndexCollapsed } from '../src/core/index-column.js';
import { agentIndex } from '../src/core/agent-index.js';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE TURNS COLUMN COLLAPSES TO ITS NUMBERS (the owner, 2026-10-14, pointing at the Agent view's index column:
 * "the Turns column should be collapseable to just the number"). Collapsed: a narrow strip, one number per turn, each
 * still a door to its turn, the live dot kept. The choice is remembered.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const working = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }),
    t('a1:1', { kind: 'tool', toolCallId: 'c1', name: 'Edit', title: null, status: 'completed', toolKind: 'edit', rawInput: { file_path: '/w/tynn/src/A.php', old_string: 'a', new_string: 'a\nb' } }),
    t('a1:2', { kind: 'turn', n: 2, by: 'you' }),
    t('a1:3', { kind: 'turn', n: 3, by: 'you' }),
];

function memory(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
}

const render = (indexStorage: ReturnType<typeof memory> | null) =>
    renderToStaticMarkup(<AgentView agent={agent} session={working} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={3} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} indexStorage={indexStorage} />);

describe('the remembered choice', () => {
    it('never set (or storage absent or throwing) = the full column; set = collapsed; written back as 1 / 0', () => {
        expect(readIndexCollapsed(null)).toBe(false);
        expect(readIndexCollapsed(memory())).toBe(false);
        expect(readIndexCollapsed({ getItem: () => { throw new Error('denied'); }, setItem: () => {} })).toBe(false);
        const s = memory();
        writeIndexCollapsed(s, true);
        expect(s.data.get(INDEX_COLLAPSED_KEY)).toBe('1');
        expect(readIndexCollapsed(s)).toBe(true);
        writeIndexCollapsed(s, false);
        expect(readIndexCollapsed(s)).toBe(false);
    });
});

describe('the numbers', () => {
    it('only the Turns, in the column’s order (latest first), with the live dot on the current one', () => {
        const index = agentIndex(rows, working, '/w/tynn', null)!;
        const numbers = turnNumbers(index);
        expect(numbers.map((n) => n.n)).toEqual([3, 2, 1]);
        expect(numbers.filter((n) => n.live !== null).map((n) => n.n)).toEqual([3]);
    });
});

describe('the column', () => {
    it('EXPANDED (the default): 216px, the full items, and a collapse control in the Turns header', () => {
        const html = render(memory());
        expect(html).toMatch(/data-index-column=""[^>]*w-\[216px\]/);
        expect(html.match(/data-index-toggle="collapse"/g) ?? []).toHaveLength(1);
        expect(html).toContain('Files touched');
        expect(html).not.toContain('data-index-number=');
    });

    it('COLLAPSED: a narrow strip of the numbers, each a door to its turn, the live dot kept, nothing else; an expand control', () => {
        const html = render(memory({ [INDEX_COLLAPSED_KEY]: '1' }));
        expect(html).toMatch(/data-index-column="collapsed"[^>]*w-\[52px\]/);
        // COUNTED: one number per turn, no item rows, no files.
        expect(html.match(/data-index-number="/g) ?? []).toHaveLength(3);
        expect(html).not.toContain('data-index-item=');
        expect(html).not.toContain('Files touched');
        expect(html).toMatch(/data-index-number="3"[^>]*data-live="ok"[^>]*data-nav="genie:\/\/agent\/a1\?tab=stream&amp;at=a1:3"/);
        expect(html).toMatch(/data-index-number="1"[^>]*data-nav="genie:\/\/agent\/a1\?tab=stream&amp;at=a1:0"/);
        expect(html.match(/data-index-toggle="expand"/g) ?? []).toHaveLength(1);
    });
});
