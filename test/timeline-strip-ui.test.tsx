import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE STRIP AND THE CHIPS IN THE AGENT VIEW (the board): a 46px session timeline above the Stream — `SESSION`,
 * turn segments, kind ticks, legend, head bar, the `Lanes` toggle — then the 44px chips row (All + the four lanes,
 * with counts). The Lanes drawer (tracks + drag) is closed until `L` or the button opens it.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const working: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null } as LiveSession;
const t = (id: string, event: StreamEvent, at: number | null): TimedEvent => ({ id, event, at });
const rows: TimedEvent[] = [
    t('a1:0', { kind: 'turn', n: 1, by: 'you' }, 1_000),
    t('a1:1', { kind: 'message', speaker: 'agent', peerName: null, text: 'hi' }, 1_500),
    t('a1:2', { kind: 'tool', toolCallId: 'c1', name: 'Edit', title: null, status: 'completed', toolKind: 'edit', rawInput: { file_path: '/w/tynn/src/A.php', old_string: 'a', new_string: 'a\nb' } }, 2_000),
    t('a1:3', { kind: 'turn', n: 2, by: 'you' }, 3_000),
];
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={working} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 4_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

describe('the session timeline strip', () => {
    it('46px: SESSION, the turn segments, kind ticks, the legend, the head bar in the session’s state, the Lanes toggle', () => {
        const html = render();
        expect(html).toMatch(/data-session-timeline[^>]*class="[^"]*h-\[46px\]/);
        expect(html).toContain('>Session<');
        expect(html).toContain('data-segment="T1"');
        expect(html).toContain('data-segment="T2"');
        expect((html.match(/data-tick-kind="edit"/g) ?? []).length).toBe(1);
        expect((html.match(/data-tick-kind="message"/g) ?? []).length).toBe(1);
        for (const k of ['edit', 'message', 'thought', 'tool']) expect(html).toContain(`data-legend="${k}"`);
        expect(html).toContain('data-head="ok"');
        expect(html).toMatch(/data-action="toggle-lanes"[^>]*aria-pressed="false"/);
    });

    it('is absent — a sentence lives in the drawer instead — when no row has a time; the chips keep their counts', () => {
        const html = render({ rows: rows.map((r) => ({ ...r, at: null })) });
        expect(html).not.toContain('data-session-timeline');
        expect(html).toMatch(/data-lane="edits"[\s\S]*?data-lane-count="1"/);
    });
});

describe('the chips row', () => {
    it('All on with the row count, the four lanes with theirs; no Clear button — All is the clear', () => {
        const html = render();
        expect(html).toContain('data-chips');
        expect(html).toMatch(/data-chip="all"[^>]*data-on="true"/);
        expect(html).toMatch(/data-lane="edits"[^>]*data-on="false"/);
        expect(html).toMatch(/data-lane="edits"[\s\S]*?data-lane-count="1"/);
        expect(html).not.toContain('data-lanes-clear');
    });

    it('a selection: its lanes on, All off', () => {
        const html = render({ lanes: ['edits'] });
        expect(html).toMatch(/data-chip="all"[^>]*data-on="false"/);
        expect(html).toMatch(/data-lane="edits"[^>]*data-on="true"/);
        expect(html).toMatch(/data-lane="messages"[^>]*data-on="false"/);
    });
});

describe('the Lanes drawer', () => {
    it('is closed by default and opens with the toggle: the tracks and the drag bar, the button pressed', () => {
        expect(render()).not.toContain('data-lanes');
        const open = render({ lanesOpen: true });
        expect(open).toContain('data-lanes');
        expect(open).toContain('data-lanes-timeline');
        expect(open).toMatch(/data-action="toggle-lanes"[^>]*aria-pressed="true"/);
    });
});
