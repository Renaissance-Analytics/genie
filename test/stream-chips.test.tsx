import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { toggleThoughts } from '../src/core/keys.js';
import { formatLanes, parseLanes } from '../src/core/lanes.js';
import type { LiveSession } from '../src/core/roster.js';
import { chipRow } from '../src/core/session-timeline.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { FACETS, FILTERS, LANES, facetsOf, visibleRows, type TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE CHIPS ROW'S FACETS (the board: `All 412 · … · Usage · Approvals · Errors`). Usage and Errors are filters over
 * the rows beside the four lanes: a usage report, a tool call the agent reported `failed`, a notice at level `error`.
 * A row can sit in a lane AND a facet. The selection rides the same `?lane=` parameter. Approvals is NOT a chip:
 * the ledger keeps no approval rows, and a chip over a thing the stream cannot see would read `0` for "not recorded".
 */
let seq = 0;
const t = (id: string, event: StreamEvent, at: number | null): TimedEvent => ({ id, event, at });
const tool = (status: 'completed' | 'failed', toolKind: 'edit' | 'execute' = 'execute'): StreamEvent =>
    ({ kind: 'tool', toolCallId: `c${seq++}`, name: 'Bash', title: 'php artisan test', status, toolKind, rawInput: null });
const rows: TimedEvent[] = [
    t('t1', { kind: 'turn', n: 1, by: 'you' }, 1_000),
    t('m1', { kind: 'message', speaker: 'agent', peerName: null, text: 'hi' }, 1_200),
    t('k1', { kind: 'think', text: 'hmm', tokens: null }, 1_400),
    t('b1', tool('completed'), 1_600),
    t('f1', tool('failed'), 1_700),
    t('e1', tool('completed', 'edit'), 1_800),
    t('u1', { kind: 'usage', used: 1_000, size: 200_000, cost: null }, 2_200),
    t('n1', { kind: 'notice', level: 'error', message: 'the provider closed the stream' }, 2_300),
    t('n2', { kind: 'notice', level: 'info', message: 'resumed' }, 2_400),
    t('cmp', { kind: 'divider', variant: 'compaction', before: 189_000, after: 46_000 }, 2_500),
    t('t2', { kind: 'turn', n: 2, by: 'you' }, 3_000),
];
const ids = (list: readonly TimedEvent[]): string[] => list.map((r) => r.id);

describe('facets — what Usage and Errors count', () => {
    it('files a usage report under usage, a failed call and an error notice under errors, and nothing else anywhere', () => {
        // The WHOLE map, so a kind quietly joining a facet shows up as a changed table, not a missed spot-check.
        expect(rows.map((r) => [r.id, facetsOf(r.event)])).toEqual([
            ['t1', []], ['m1', []], ['k1', []], ['b1', []], ['f1', ['errors']], ['e1', []],
            ['u1', ['usage']], ['n1', ['errors']], ['n2', []], ['cmp', []], ['t2', []],
        ]);
    });

    it('the filters are the four lanes then the three facets — Approvals counts the decisions the session mints', () => {
        expect(FACETS).toEqual(['usage', 'approvals', 'errors']);
        expect(FILTERS).toEqual([...LANES, ...FACETS]);
    });

    it('a failed call is shown under its lane AND under Errors; a usage report only under Usage; structure always stays', () => {
        expect(ids(visibleRows(rows, ['errors']))).toEqual(['t1', 'f1', 'n1', 'cmp', 't2']);
        expect(ids(visibleRows(rows, ['usage']))).toEqual(['t1', 'u1', 'cmp', 't2']);
        expect(ids(visibleRows(rows, ['tools']))).toEqual(['t1', 'b1', 'f1', 'cmp', 't2']);
        // POSITIVE CONTROL for the two above: a selection that names neither shows neither.
        expect(ids(visibleRows(rows, ['edits']))).toEqual(['t1', 'e1', 'cmp', 't2']);
    });
});

describe('the route carries a facet like a lane', () => {
    it('round-trips, and drops a name it does not know (the positive control is the facet kept beside it)', () => {
        expect(parseLanes('edits,usage')).toEqual(['edits', 'usage']);
        expect(formatLanes(['edits', 'usage', 'errors'])).toBe('edits,usage,errors');
        expect(parseLanes('wat,errors')).toEqual(['errors']);
    });
});

describe('chipRow', () => {
    it('appends Usage and Errors after the lanes with MEASURED counts; a zero is kept', () => {
        const chips = chipRow(rows, null);
        expect(chips.map((c) => c.id)).toEqual(['all', 'messages', 'thoughts', 'tools', 'edits', 'usage', 'approvals', 'errors']);
        expect(chips.find((c) => c.id === 'usage')).toEqual({ id: 'usage', label: 'Usage', n: 1, on: false });
        expect(chips.find((c) => c.id === 'errors')).toEqual({ id: 'errors', label: 'Errors', n: 2, on: false });
        const calm = chipRow(rows.filter((r) => r.id !== 'f1' && r.id !== 'n1'), null);
        expect(calm.find((c) => c.id === 'errors')).toMatchObject({ n: 0 });
    });

    it('a facet selection turns its chip on and All off', () => {
        const chips = chipRow(rows, ['errors']);
        expect(chips.find((c) => c.id === 'all')!.on).toBe(false);
        expect(chips.find((c) => c.id === 'errors')!.on).toBe(true);
        expect(chips.find((c) => c.id === 'tools')!.on).toBe(false);
    });
});

describe('t keeps the facets', () => {
    it('hiding thoughts from not-filtering keeps usage and error rows visible', () => {
        expect(toggleThoughts(null)).toEqual(['messages', 'tools', 'edits', 'usage', 'approvals', 'errors']);
        expect(toggleThoughts(['messages', 'tools', 'edits', 'usage', 'approvals', 'errors'])).toBeNull();
    });
});

describe('the chips row in the Agent view', () => {
    const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
    const working: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
    const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
        renderToStaticMarkup(<AgentView agent={agent} session={working} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={2} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 4_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

    it('draws Usage and Errors as chips after the lanes, with their counts', () => {
        const html = render();
        expect(html).toMatch(/data-facet="usage"[^>]*data-on="false"/);
        expect(html).toMatch(/data-facet="usage"[\s\S]*?data-facet-count="1"/);
        expect(html).toMatch(/data-facet="errors"[\s\S]*?data-facet-count="2"/);
        expect(html.indexOf('data-lane="edits"')).toBeLessThan(html.indexOf('data-facet="usage"'));
        expect(html).toMatch(/data-facet="approvals"[\s\S]*?data-facet-count="0"/);
    });

    it('a selected facet: its chip on, All off', () => {
        const html = render({ lanes: ['errors'] });
        expect(html).toMatch(/data-facet="errors"[^>]*data-on="true"/);
        expect(html).toMatch(/data-chip="all"[^>]*data-on="false"/);
        expect(html).toMatch(/data-lane="tools"[^>]*data-on="false"/);
    });
});
