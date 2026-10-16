import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';

/**
 * ONE FIRST-RUN INVITATION. With no workspaces the Dashboard route showed the two-step Onboarding (§6.9) AND the
 * Dashboard's own "Nothing is being worked on yet" under it — two invitations stacked (the board audit's Dashboard
 * cluster). The Onboarding is the first run; the Dashboard's invitation is for the component on its own.
 */
const snapshot = (over: Partial<GenieSnapshot>): GenieSnapshot => ({ ...EMPTY_SNAPSHOT, workstation: { name: 'alphar', healthy: true }, ...over });

const render = (snap: GenieSnapshot) =>
    renderToStaticMarkup(
        <Shell
            route="genie://dashboard?group=workspace"
            snapshot={snap}
            servable={['dashboard', 'deck', 'agent', 'workspace']}
            agentDetail={null}
            agentResolved={false}
            selectedRowId={null}
            chatThread={null}
            pinned={null}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onAddWorkspace={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={() => {}}
            onSend={() => {}}
            onTogglePin={() => {}}
            onCloseChat={() => {}}
            answeringApproval={null}
            onAnswerApproval={() => {}}
            onAnswerDeckItem={() => {}}
        />,
    );

const invitations = (html: string): number => (html.match(/data-onboarding/g) ?? []).length + (html.match(/data-dashboard="first-run"/g) ?? []).length;

describe('the first run', () => {
    it('no workspaces: the two-step Onboarding and nothing else — invitations COUNTED, exactly one', () => {
        const html = render(snapshot({ workspaces: [], agents: [] }));
        expect(html).toContain('data-onboarding');
        expect(html).not.toContain('data-dashboard="first-run"');
        expect(html).not.toContain('Nothing is being worked on yet');
        expect(invitations(html)).toBe(1);
    });

    it('POSITIVE CONTROL: before the bridge answers it is the skeleton and no invitation; with a workspace it is the board and no onboarding step one', () => {
        const loading = render(snapshot({ workspaces: null, agents: [] }));
        expect(loading).toContain('data-dashboard="loading"');
        expect(invitations(loading)).toBe(0);

        const live = render(snapshot({ workspaces: [{ id: 'tynn', path: 'C:/_Projects/tynn.ai', agentsKnown: true }], agents: [] }));
        expect(live).toContain('data-surface="dashboard"');
        expect(live).not.toContain('data-dashboard="first-run"');
    });
});
