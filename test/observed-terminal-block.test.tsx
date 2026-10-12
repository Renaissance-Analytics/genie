import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TakeOverProbe } from '../src/core/observed.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE TERMINAL BLOCK (the board's right column, blind state): an agent in a Take Over window has no plan, context or
 * cost to show, so its column carries one block — `Terminal`, `live, read-only here · Take over ⌘⇧T`, when it last
 * printed, and the Take over door. Absent for a declared agent, which reports and has a column of its own.
 */
const NOW = 1_760_000_100_000;
const probe: TakeOverProbe = { terminalId: 't-9', startedAt: NOW - 600_000, lastOutputAt: NOW - 40_000, bursts: [] };
const observed = { id: 'a1', name: 'moth', provider: 'aider', fidelity: 'observed' as const, cwd: '/w/tynn', instructions: null };
const declared = { ...observed, name: 'sable', provider: 'claude', fidelity: 'declared' as const };
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={observed} session={null} rows={[]} tab="activity" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => NOW} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} takeOver={probe} onTakeOver={() => {}} {...props} />);

describe('the observed Terminal block', () => {
    it('names the terminal as live and read-only here, says when it last printed, and offers Take over ⌘⇧T', () => {
        const html = render();
        expect(html).toContain('data-rail="terminal"');
        expect(html).toContain('live, read-only here');
        expect(html).toContain('last output 40s ago');
        expect(html).toMatch(/data-action="take-over-rail"[^>]*>[\s\S]*?Take over/);
        expect(html).toContain('⌘⇧T');
    });

    it('absent for a declared agent, and for an observed one with no Take Over window', () => {
        expect(render({ agent: declared, tab: 'stream', takeOver: null })).not.toContain('data-rail="terminal"');
        expect(render({ takeOver: null })).not.toContain('data-rail="terminal"');
    });
});
