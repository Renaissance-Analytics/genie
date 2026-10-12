import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE `turns` LAYOUT IN THE AGENT VIEW (the board): cards in place of the ledger, the chips row gone, the index
 * column and the strip kept, a `Turns` / `Ledger` toggle in the strip that writes `layout=` into the route.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const working: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const t = (id: string, event: StreamEvent, at: number): TimedEvent => ({ id, event, at });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }, 1_000),
    t('a1:1', { kind: 'message', speaker: 'you', peerName: null, text: 'Run the artisan tests' }, 2_000),
    t('a1:2', { kind: 'turn', n: 2, by: 'you' }, 3_000),
    t('a1:3', { kind: 'tool', toolCallId: 'c1', name: 'Bash', title: 'php artisan test', status: 'completed', toolKind: 'execute', rawInput: null }, 4_000),
];
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={working} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={2} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 5_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

describe('the turns layout', () => {
    it('cards in place of the ledger: the latest open with its rows, the earlier one collapsed; no chips row; the index column stays', () => {
        const html = render({ layout: 'turns' });
        expect(html).toContain('data-turn-cards');
        expect(html).toMatch(/data-turn-card="1"[^>]*data-open="false"/);
        expect(html).toMatch(/data-turn-card="2"[^>]*data-open="true"/);
        expect(html).toContain('data-stream-row="a1:3"');
        expect(html).not.toContain('data-stream-row="a1:1"');
        expect(html).not.toContain('data-chips');
        expect(html).not.toContain('data-stream="rows"');
        expect(html).toContain('data-index-column');
    });

    it('the strip offers the other layout as a door that writes `layout=` into the route', () => {
        expect(render()).toMatch(/data-action="toggle-layout"[^>]*data-nav="genie:\/\/agent\/a1\?tab=stream&amp;layout=turns"/);
        expect(render({ layout: 'turns' })).toMatch(/data-action="toggle-layout"[^>]*data-nav="genie:\/\/agent\/a1\?tab=stream"/);
    });

    it('the ledger is the default: no cards', () => {
        const html = render();
        expect(html).not.toContain('data-turn-cards');
        expect(html).toContain('data-stream="rows"');
    });
});
