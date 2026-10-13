import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { dashboardAction } from '../src/core/keys.js';
import { lanesFor, revealOf } from '../src/core/reveal.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * THE COLLABORATOR REVEAL (§4.1) — in the table, never a popover. Hovering an agent's comms cell (or `C` on the row
 * cursor): its peers stay in place, the rest dims to .32, lanes in the left gutter join the row to each peer — solid
 * violet for traffic in the last 30 s, dashed `--fg-4` when quiet — a 2px violet left border marks the row and each
 * peer, and each peer's comms cell reads `↔ 14 · 8s` (messages · age). Peers come from the row's measured links
 * (AgentInbox); a row with no links reveals nothing. The global graph is never drawn.
 */
function row(over: Partial<AgentRow>): AgentRow {
    return {
        id: 'x', name: 'x', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: '3m',
        ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
        collaborators: 0, commsAgeSeconds: null, contextUsed: null, contextSize: null, links: [],
        ...over,
    };
}
const rows: AgentRow[] = [
    row({ id: 'kai', name: 'kai', collaborators: 2, commsAgeSeconds: 8, links: [{ peer: 'wren', count: 14, ageSeconds: 8 }, { peer: 'moth', count: 3, ageSeconds: 120 }] }),
    row({ id: 'atlas', name: 'atlas' }),
    row({ id: 'wren', name: 'wren', collaborators: 1, commsAgeSeconds: 8, links: [{ peer: 'kai', count: 14, ageSeconds: 8 }] }),
    row({ id: 'moth', name: 'moth', workspaceId: 'fancy', collaborators: 1, commsAgeSeconds: 120, links: [{ peer: 'kai', count: 3, ageSeconds: 120 }] }),
];

describe('revealOf and lanesFor', () => {
    it('the focus and its peers on the board, each with its link; live within 30 s', () => {
        expect(revealOf(rows, 'kai')).toEqual({ focus: 'kai', peers: { wren: { count: 14, ageSeconds: 8, live: true }, moth: { count: 3, ageSeconds: 120, live: false } } });
        expect(revealOf(rows, 'atlas')).toBeNull();
        expect(revealOf(rows, null)).toBeNull();
    });

    it('one lane per peer across every line between them — group headers included — ends marked', () => {
        const order = ['head:tynn', 'kai', 'atlas', 'wren', 'head:fancy', 'moth'];
        const lanes = lanesFor(order, revealOf(rows, 'kai')!);
        expect(lanes['head:tynn']).toEqual([]);
        expect(lanes.kai).toEqual([{ lane: 0, part: 'start', live: true }, { lane: 1, part: 'start', live: false }]);
        expect(lanes.atlas).toEqual([{ lane: 0, part: 'mid', live: true }, { lane: 1, part: 'mid', live: false }]);
        expect(lanes.wren).toEqual([{ lane: 0, part: 'end', live: true }, { lane: 1, part: 'mid', live: false }]);
        expect(lanes['head:fancy']).toEqual([{ lane: 1, part: 'mid', live: false }]);
        expect(lanes.moth).toEqual([{ lane: 1, part: 'end', live: false }]);
    });
});

describe('the board', () => {
    const render = (revealId: string | null) =>
        renderToStaticMarkup(<Dashboard rows={rows} workspaces={[{ id: 'tynn', path: '/w/tynn' }, { id: 'fancy', path: '/w/fancy' }]} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} revealId={revealId} />);

    it('marks the focus and its peers, dims the rest, shows each peer link, and draws live and quiet lanes', () => {
        const html = render('kai');
        expect(html).toMatch(/data-agent="kai"[^>]*data-reveal="focus"/);
        expect(html).toMatch(/data-agent="wren"[^>]*data-reveal="peer"/);
        expect(html).toMatch(/data-agent="atlas"[^>]*data-reveal="dim"[^>]*style="[^"]*opacity:0.32/);
        expect(html).toMatch(/data-peer-link="wren"[^>]*>↔ 14 · 8s</);
        expect(html).toMatch(/data-peer-link="moth"[^>]*>↔ 3 · 2m</);
        expect(html).toContain('data-lane="0" data-part="start" data-live="true"');
        expect(html).toContain('data-lane="1" data-part="end" data-live="false"');
        expect(html).not.toMatch(/role="(dialog|tooltip)"/);
    });

    it('without a reveal nothing is dimmed, marked or drawn (positive control above)', () => {
        const html = render(null);
        expect(html).not.toContain('data-reveal=');
        expect(html).not.toContain('data-lane=');
        expect(html).not.toContain('data-peer-link=');
    });

    it('C toggles the reveal on the row cursor; never while typing', () => {
        expect(dashboardAction({ key: 'c', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: false })).toBe('reveal');
        expect(dashboardAction({ key: 'C', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, typing: false })).toBe('reveal');
        expect(dashboardAction({ key: 'c', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: true })).toBeNull();
    });
});
