import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * THE ROW CURSOR ON SCREEN: the focused row is marked (`data-focused`), one at most, and the board's key hints sit in
 * the header's right — `J K ↵ G` — so the keys are discoverable rather than a secret.
 */
const base: AgentRow = {
    id: 'a', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working',
    duration: '12m', ask: null, reason: null, fixes: [], step: null, target: 'Wire it', activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
};
const row = (over: Partial<AgentRow>): AgentRow => ({ ...base, ...over });
const rows = [row({ id: 'a1' }), row({ id: 'a2', name: 'wren', state: 'idle' })];
const render = (props: Partial<Parameters<typeof Dashboard>[0]> = {}) =>
    renderToStaticMarkup(<Dashboard rows={rows} workspaces={[{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }]} onOpenAgent={() => {}} onAddAgent={() => {}} {...props} />);

describe('the row cursor', () => {
    it('marks the focused row, one at most; none when nothing is focused', () => {
        const html = render({ focusedId: 'a2' });
        expect((html.match(/data-focused="true"/g) ?? []).length).toBe(1);
        expect(html).toMatch(/data-agent="a2"[^>]*data-focused="true"/);
        expect(render()).not.toContain('data-focused="true"');
    });

    it('the header shows the key hints', () => {
        const html = render();
        expect(html).toContain('data-key-hints');
        const hints = html.slice(html.indexOf('data-key-hints'));
        for (const k of ['>J<', '>K<', '>↵<', '>G<']) expect(hints).toContain(k);
    });
});
