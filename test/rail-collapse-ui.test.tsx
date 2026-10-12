import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * ON SCREEN: below the threshold the right column is a 32px strip with the summary and a button that opens the
 * column as a popover; at or above it, the column as before. The width is measured by the view (a ResizeObserver on
 * its root) and controllable here, because static markup has no size.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
const session: LiveSession = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: 178_000, contextSize: 200_000, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: { step: 3, of: 6, doing: 'x' } } as LiveSession;
const render = (width: number | null) =>
    renderToStaticMarkup(<AgentView agent={agent} session={session} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={3} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} width={width} />);

describe('the right column below 1100px', () => {
    it('is a strip with the summary and a door to the full column', () => {
        const html = render(1000);
        expect(html).toMatch(/data-right-column="strip"[^>]*class="[^"]*h-8/);
        expect(html).toContain('3/6 · 89% ctx');
        expect(html).toContain('data-action="expand-rail"');
        expect(html).not.toContain('data-rail="plan"');
    });

    it('at 1100px and above, and when unmeasured, it is the column', () => {
        expect(render(1100)).toContain('data-rail="plan"');
        expect(render(null)).toContain('data-rail="plan"');
        expect(render(1440)).not.toContain('data-right-column="strip"');
    });
});
