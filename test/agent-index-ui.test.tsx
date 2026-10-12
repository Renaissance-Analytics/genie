import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE INDEX COLUMN IN THE AGENT VIEW (the board): 216px at the left of the Stream body, `TURNS` and `FILES TOUCHED`
 * as uppercase 11px titles, each item a door (`?at=<row>`) with the live dot on the current turn. Absent — not
 * empty — when the rows carry no turn markers.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const working: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }),
    t('a1:1', { kind: 'tool', toolCallId: 'c1', name: 'Edit', title: null, status: 'completed', toolKind: 'edit', rawInput: { file_path: '/w/tynn/src/A.php', old_string: 'a', new_string: 'a\nb' } }),
    t('a1:2', { kind: 'turn', n: 2, by: 'you' }),
];
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={working} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

describe('the index column', () => {
    it('216px at the left of the Stream: Turns latest-first with the live dot on the current one, Files touched, each item a door to its row (static markup escapes the & in the route)', () => {
        const html = render();
        expect(html).toMatch(/data-index-column[^>]*class="[^"]*w-\[216px\]/);
        expect(html).toContain('>Turns<');
        expect(html).toContain('>Files touched<');
        expect(html).toMatch(/data-index-item="turn:2"[^>]*data-live="ok"[^>]*data-nav="genie:\/\/agent\/a1\?tab=stream&amp;at=a1:2"/);
        expect(html).toContain('Turn 2 · now');
        expect(html).toMatch(/data-index-item="turn:1"[^>]*data-nav="genie:\/\/agent\/a1\?tab=stream&amp;at=a1:0"/);
        expect(html).toContain('1 edit · +1');
        expect(html).toContain('src/A.php');
    });

    it('absent when the rows carry no turn markers — nothing is drawn as one long turn', () => {
        const html = render({ rows: rows.filter((r) => r.event.kind !== 'turn') });
        expect(html).not.toContain('data-index-column');
        expect(html).toContain('data-stream=');
    });

    it('absent on the Files and Changes tabs — the index belongs to the Stream', () => {
        expect(render({ tab: 'files' })).not.toContain('data-index-column');
    });
});
