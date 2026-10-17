import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * THE PERSONA BLOCK ON SCREEN: the path (the fact Genie always has) and, when the file was read, its first lines in
 * mono under it, with a note when they are clipped. Reading is the view's own concern (`files.open`); the text is
 * controllable so the markup can be pinned without a DOM.
 */
const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: '.agents/sable/AGENT.md' };
const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
    renderToStaticMarkup(<AgentView agent={agent} session={null} rows={[]} tab="settings" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 1_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} {...props} />);

describe('the persona block', () => {
    it('shows the file’s first lines under the path, and says when they are clipped', () => {
        const text = ['# sable', '', 'Security reviewer for tynn.', ...Array.from({ length: 12 }, (_, i) => `rule ${i + 1}`)].join('\n');
        const html = render({ personaText: text });
        expect(html).toContain('.agents/sable/AGENT.md');
        expect(html).toMatch(/data-persona-text[^>]*>[^<]*# sable/);
        expect(html).toContain('Security reviewer for tynn.');
        expect(html).toContain('data-persona-clipped');
        expect(html).not.toContain('rule 12');
    });

    it('without the text, the path alone — no empty box, no note', () => {
        const html = render();
        expect(html).toContain('.agents/sable/AGENT.md');
        expect(html).not.toContain('data-persona-text');
        expect(html).not.toContain('data-persona-clipped');
    });

    it('a read that failed is said in one line, not hidden', () => {
        const html = render({ personaText: null, personaError: 'EACCES: permission denied' });
        expect(html).toMatch(/data-persona-error[^>]*>[^<]*EACCES: permission denied/);
        expect(html).not.toContain('data-persona-text');
    });
});
