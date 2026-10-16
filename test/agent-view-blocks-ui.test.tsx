import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE RIGHT COLUMN'S BLOCKS PER THE BOARD: the persona block (`.agents/sable/AGENT.md`) shown in the empty state so
 * the one thing known before the first turn is on screen; the context note under the bar; the empty Stream's
 * `No events yet` heading with `Message <agent> ⌘J` as the primary action and `Edit <persona>` beside it.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: '.agents/sable/AGENT.md' };
const running: LiveSession = { running: true, turnState: 'working', startedAt: 1_000_000 - 10_000, pendingApproval: null, failure: null, contextUsed: 182_000, contextSize: 200_000, plan: { step: 4, of: 7, doing: 'x' } } as LiveSession;
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={null} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 1_000_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

describe('the empty state', () => {
    it('shows the persona block in the right column and the empty Stream’s heading with Message ⌘J and Edit persona', () => {
        const html = render();
        expect(html).toMatch(/data-rail="persona"[^>]*>[^<]*(<[^>]*>[^<]*)*\.agents\/sable\/AGENT\.md/);
        expect(html).toContain('No events yet');
        expect(html).toMatch(/data-action="chat"[^>]*>[^<]*(<[^>]*>[^<]*)*Message sable/);
        expect(html).toMatch(/data-action="edit-persona"[^>]*>Edit <span[^>]*>\.agents\/sable\/AGENT\.md<\/span>/);
    });

    it('an agent whose record names no persona gets no persona block — absent, not an empty row', () => {
        const html = render({ agent: { ...agent, instructions: null } });
        expect(html).not.toContain('data-rail="persona"');
        expect(html).not.toContain('edit-persona');
    });
});

describe('the context note', () => {
    it('sits under the context bar in its tone; absent when there is nothing to say', () => {
        const html = render({ session: running, turns: 4 });
        expect(html).toMatch(/data-context-note="warn"[^>]*>Compaction expected near 190k\. Consider a handoff before step 5\./);
        expect(render({ session: { ...running, contextUsed: 38_000 }, turns: 4 })).not.toContain('data-context-note');
    });
});
