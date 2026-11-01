import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { Headroom } from '../src/core/headroom.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { ImportedAgentsView } from '../src/renderer/components/ImportedAgents.js';
import { importedAgents } from '../src/core/agent-adoption.js';
import { buttonTags } from './helpers/control-markup.js';

/**
 * REAL BUTTONS on the Dashboard (the owner, 2026-11-01: "we need to make sure all buttons are real buttons … fancy has a
 * beautiful button component we need to use for all buttons and links"). Every `<button>` the Dashboard draws, in every
 * state that draws one, is react-fancy's Button, which marks itself `data-react-fancy-button`. COUNTED: each render must
 * contain the buttons its state offers, so "every" cannot be true of none.
 *
 * Markup claims only (docs/decisions.md D3): which element, not how it looks in a window.
 */

function row(over: Partial<AgentRow> = {}): AgentRow {
    return {
        id: 'kai', name: 'kai', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: '6m',
        ask: null, reason: null, fixes: [], step: '3/7', target: 'verify the install', activity: null, delivery: null,
        collaborators: null, commsAgeSeconds: null, contextUsed: 178_000, contextSize: 200_000,
        ...over,
    };
}
const h = (leftPct: number): Headroom => {
    const resetsAtMs = Date.UTC(2026, 9, 26, 14, 0, 0);
    return { plan: null, window: '5h', leftPct, resetsAtMs, over: false, windows: [{ window: '5h', usedPct: 100 - leftPct, leftPct, resetsAtMs, over: false }] };
};
const noop = () => {};
const notFancy = (html: string) => buttonTags(html).filter((t) => !/\sdata-react-fancy-button=""/.test(t));

describe('the Dashboard draws only react-fancy Buttons', () => {
    it('first run: Add a workspace, From a git URL, From Tynn', () => {
        const html = renderToStaticMarkup(<Dashboard rows={[]} workspaces={[]} onOpenAgent={noop} onAddAgent={noop} onAddWorkspace={noop} onAddWorkspaceFromGit={noop} onAddWorkspaceFromTynn={noop} />);
        expect(buttonTags(html).length).toBe(3);
        expect(notFancy(html)).toEqual([]);
    });

    it('the board: header (grouping, Chat, a rate-limit pill), group headers (Open workspace, Locate repo, Add agent), a broken row’s fix, a row’s tray doors', () => {
        const html = renderToStaticMarkup(
            <Dashboard
                rows={[row(), row({ id: 'bad', name: 'bad', state: 'broken', reason: 'Provider sign-in expired', fixes: ['Sign in to kimi'] })]}
                workspaces={[{ id: 'tynn', path: '/w/tynn' }, { id: 'moic', path: '/w/moic' }]}
                onOpenAgent={noop}
                onAddAgent={noop}
                onChat={noop}
                faults={{ tynn: { text: 'repo site not found in tynn.agi', repo: 'site' } }}
                onLocateRepo={noop}
                rateLimits={{ claude: h(62) }}
                trayId="kai"
            />,
        );
        // POSITIVE CONTROL: each kind of button this state offers is in the markup.
        for (const attr of ['data-group-toggle="workspace"', 'data-group-toggle="status"', 'data-action="chat-genie"', 'data-rate-limit="claude"', 'data-open-workspace="tynn"', 'data-action="locate-repo"', 'data-add-agent="moic"', 'data-fix="Sign in to kimi"', 'data-door="agent"']) {
            expect(html, attr).toContain(attr);
        }
        expect(buttonTags(html).length).toBeGreaterThanOrEqual(9);
        expect(notFancy(html)).toEqual([]);
    });

    it('the agent row is a grid row that says it is clickable (cursor), not a fake button', () => {
        const html = renderToStaticMarkup(<Dashboard rows={[row()]} workspaces={[{ id: 'tynn', path: '/w/tynn' }]} onOpenAgent={noop} onAddAgent={noop} />);
        const open = /<div[^>]*role="row"[^>]*data-agent="kai"[^>]*>/.exec(html)?.[0] ?? '';
        expect(open).not.toBe('');
        expect(open).toMatch(/class="[^"]*\bcursor-pointer\b/);
        expect(open).not.toMatch(/role="button"/);
    });
});

describe('Imported agents (the workspace’s agents to adopt) draws only react-fancy Buttons', () => {
    it('Adopt per agent and Open workspace', () => {
        const agents = importedAgents({ files: [{ folder: 'atlas', text: '' }, { folder: 'bolt', text: '' }], registered: [] });
        const html = renderToStaticMarkup(<ImportedAgentsView workspaceName="Acme" path="/w/acme.agi" agents={agents} busy={null} notice={null} error={null} onAdopt={noop} onOpen={noop} />);
        expect(buttonTags(html).length).toBe(3);
        expect(notFancy(html)).toEqual([]);
    });
});
