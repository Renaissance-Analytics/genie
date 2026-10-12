import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parkedDivider } from '../src/core/agent-view.js';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE PARKED DIVIDER (the board, amber, at the stream's end): `turn parked · waiting on you 0:42` while a permission
 * request waits, the wait from Genie's own stamp. It is state, not a ledger row, so it is drawn under the rows and no
 * lane filter can hide it. And the board's EMPTY state: `No events yet` with no chips row and no strip — counts over
 * nothing are furniture.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const t = (id: string, event: StreamEvent, at: number | null): TimedEvent => ({ id, event, at });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 15, by: 'you' }, 1_000),
    t('a1:1', { kind: 'tool', toolCallId: 'c1', name: 'Bash', title: 'php artisan migrate --force', status: 'pending', toolKind: 'execute', rawInput: null }, 1_500),
];
const base: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const parkedAt = 4_000 - 42_000; // now − 42 s
const parked: LiveSession = { ...base, turnState: 'idle', pendingApproval: { question: 'Allow?', options: [] } as never, parkedAt } as LiveSession;
const now = () => 4_000;
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={parked} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={15} cost={null} onNavigate={() => {}} onSelect={() => {}} now={now} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

describe('parkedDivider', () => {
    it('the words with the wait from the stamp; without a stamp, the words alone; nothing when not parked', () => {
        expect(parkedDivider(parked, now)).toBe('turn parked · waiting on you 0:42');
        expect(parkedDivider({ ...parked, parkedAt: null } as LiveSession, now)).toBe('turn parked · waiting on you');
        expect(parkedDivider(base, now)).toBeNull();
        expect(parkedDivider(null, now)).toBeNull();
    });
});

describe('the divider in the Agent view', () => {
    it('draws it under the rows while parked — and still under an edits-only lane filter', () => {
        const html = render();
        expect(html).toMatch(/data-divider="parked"[^>]*>[\s\S]*?turn parked · waiting on you 0:42/);
        const filtered = render({ lanes: ['edits'] });
        expect(filtered).toContain('data-divider="parked"');
    });

    it('is absent while the turn runs (positive control: the same rows, a working session)', () => {
        expect(render({ session: base })).not.toContain('data-divider="parked"');
    });
});

describe('the empty state draws no chips and no strip', () => {
    it('No events yet, and neither data-chips nor the session timeline; with rows the chips are back', () => {
        const empty = render({ session: base, rows: [] });
        expect(empty).toContain('No events yet');
        expect(empty).not.toContain('data-chips');
        expect(empty).not.toContain('data-session-timeline');
        expect(render({ session: base })).toContain('data-chips');
    });
});
