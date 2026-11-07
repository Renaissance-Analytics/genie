import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { fixRoute, groupByStatus } from '../src/core/dashboard-view.js';
import { globalAction } from '../src/core/keys.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { control } from './helpers/control-markup.js';

/**
 * THE DASHBOARD IS A BOARD YOU READ — but what it draws must be real. The board audit of 2026-10-12 found the
 * rendered-but-inert: "Open workspace →" a static span, fix buttons with no handler, the group header naming the
 * workspace by its ID, no `By workspace | By status` control though the route parses `group=status`, no `Chat ⌘J`,
 * and no legend in the cannot-see state. Each of those is either a door or a label; this file holds the door open.
 */

const base: AgentRow = {
    id: 'a', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working',
    duration: '12m', ask: null, reason: null, fixes: [], step: null, target: 'Wire it', activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
};
const row = (over: Partial<AgentRow>): AgentRow => ({ ...base, ...over });
const workspaces = [{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }, { id: 'fancy', path: '/w/fancy' }];
const rows = [row({ id: 'a1', state: 'working' }), row({ id: 'a2', name: 'wren', state: 'waiting', ask: 'Merge?' }), row({ id: 'a3', name: 'tern', state: 'broken', reason: 'kimi signed out', fixes: ['Sign in to kimi', 'Restart', 'Terminal'] }), row({ id: 'b1', name: 'pica', workspaceId: 'fancy', state: 'idle' })];
const render = (props: Partial<Parameters<typeof Dashboard>[0]> = {}) =>
    renderToStaticMarkup(<Dashboard rows={rows} workspaces={workspaces} onOpenAgent={() => {}} onAddAgent={() => {}} {...props} />);

describe('the flat Dashboard workspace column', () => {
    it('uses the envelope name, falling back to the workspace folder name', () => {
        const html = render();
        expect(html).toContain('data-column="workspace"');
        expect(html).toContain('Tynn.ai'); expect(html).toContain('fancy');
        expect(html).not.toContain('data-workspace-head');
    });
    it('keeps workspace navigation as a real Fancy Button in each row', () => {
        const html = render({ onOpenWorkspace: () => {} });
        expect(control(html, 'data-open-workspace="tynn"')).toMatchObject({ tag: 'button', fancy: true, text: 'Tynn.ai' });
        expect(control(html, 'data-open-workspace="fancy"')).toMatchObject({ tag: 'button', fancy: true, text: 'fancy' });
    });
    it('draws each agent once in global alphabetical order with no grouping mode', () => {
        const html = render();
        expect([...html.matchAll(/data-agent="([^"]+)"/g)].map((match) => match[1])).toEqual(['a1', 'b1', 'a3', 'a2']);
        expect(html).not.toContain('data-group-toggle'); expect(html).not.toContain('data-status-group');
        expect((html.match(/role="row"/g) ?? []).length).toBe(4);
    });
    it('retains the pure status helper without exposing Dashboard grouping', () => {
        expect(groupByStatus(rows).map((group) => [group.state, group.rows.map((row) => row.id)])).toEqual([
            ['waiting', ['a2']], ['broken', ['a3']], ['working', ['a1']], ['idle', ['b1']],
        ]);
    });
});
describe('the doors on a row', () => {
    it("a broken row's fix buttons act: Restart restarts, Terminal takes over, anything else opens the agent", () => {
        expect(fixRoute('a3', 'Restart')).toEqual({ kind: 'restart', agentId: 'a3' });
        expect(fixRoute('a3', 'Terminal')).toEqual({ kind: 'takeover', agentId: 'a3' });
        expect(fixRoute('a3', 'Sign in to kimi')).toEqual({ kind: 'open', agentId: 'a3' });
        // The buttons name their agent, so the handler never guesses from the label alone.
        const html = render();
        expect((html.match(/data-fix-for="a3"/g) ?? []).length).toBe(3);
    });

    it('the header offers Chat ⌘J — the composer, one click away from the board — and the chord it names works everywhere', () => {
        expect(control(render(), 'data-action="chat-genie"')).toMatchObject({ tag: 'button', fancy: true, text: 'Chat ⌘J' });
        const j = { key: 'j', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, typing: false };
        expect(globalAction(j)).toBe('toggle-chat');
        expect(globalAction({ ...j, metaKey: false, ctrlKey: true })).toBe('toggle-chat');
        // A chord, so it works while typing; a bare `j` is the stream cursor's, never this.
        expect(globalAction({ ...j, typing: true })).toBe('toggle-chat');
        expect(globalAction({ ...j, metaKey: false })).toBeNull();
    });
});

describe('the legend', () => {
    it('appears only in the cannot-see state — when an observed or remote agent is on the board — and names the three shapes', () => {
        const declaredOnly = render();
        expect(declaredOnly).not.toContain('data-legend');
        const withObserved = render({ rows: [...rows, row({ id: 'o1', name: 'moth', fidelity: 'observed', provider: 'aider', state: 'working', activity: [1, 2, 3] })] });
        expect(withObserved).toContain('data-legend');
        expect(withObserved).toContain('Declared');
        expect(withObserved).toContain('Observed');
        expect(withObserved).toContain('Remote');
    });
});
