import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * THE POPPED-OUT PANEL RELEASES THE DOCK RESERVE; A BAR BRINGS IT BACK (§4.3). Pinned and popped,
 * the dock column is a bar naming the workspace with one control, the content row's reserve is 0,
 * and the Workspace surface does not draw the panel inline either — there is still only one. Nothing
 * popped is the positive control: the dock behaves exactly as before.
 */

const snapshot: GenieSnapshot = {
    ...EMPTY_SNAPSHOT,
    agents: [],
    workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }, { id: 'fancy', path: '/w/fancy', agentsKnown: true }],
    deckItems: [],
    signals: { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false },
    workstation: { name: 'alphar', healthy: true },
};

function render(over: Partial<Parameters<typeof Shell>[0]> = {}): string {
    return renderToStaticMarkup(
        <Shell
            route="genie://dashboard?group=workspace"
            snapshot={snapshot}
            servable={['dashboard', 'deck', 'agent', 'workspace']}
            agentDetail={null}
            agentResolved={false}
            selectedRowId={null}
            chatThread={null}
            pinned={null}
            files={NO_FILES}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onAddWorkspace={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={() => {}}
            onSend={() => {}}
            onTogglePin={() => {}}
            onToggleFilesPin={() => {}}
            onCloseChat={() => {}}
            answeringApproval={null}
            onAnswerApproval={() => {}}
            onAnswerDeckItem={() => {}}
            {...over}
        />,
    );
}

describe('the file panel popped out', () => {
    it('pinned + popped: no dock panel, reserve 0, a bar naming the workspace with Bring it back; the pin lamp stays on', () => {
        const html = render({ pinned: 'files', filesWorkspaceId: 'tynn', filesPopped: ['tynn'], onBringBackFiles: () => {} });
        expect(html).not.toContain('data-dock="files"');
        expect(html).toContain('data-dock-reserve="0"');
        expect(html).toContain('data-files-popped="tynn"');
        expect(html).toContain('data-action="bring-back-files"');
        expect(html).not.toContain('data-files-panel="tynn"');
    });

    it('nothing popped is the positive control: the dock holds the panel and the reserve is the dock width', () => {
        const html = render({ pinned: 'files', filesWorkspaceId: 'tynn', filesPopped: [] });
        expect(html).toContain('data-dock="files"');
        expect(html).toContain('data-files-panel="tynn"');
        expect(html).not.toContain('data-files-popped');
        expect(html).not.toContain('data-dock-reserve="0"');
    });

    it('unpinned, on the Workspace surface with the panel popped: not inline either — the bar instead', () => {
        const html = render({ pinned: null, route: 'genie://workspace/tynn?panel=files', filesPopped: ['tynn'], onBringBackFiles: () => {} });
        expect(html).not.toContain('data-files-panel="tynn"');
        expect(html).toContain('data-files-popped="tynn"');
    });

    it('another workspace popped out does not touch this one', () => {
        const html = render({ pinned: 'files', filesWorkspaceId: 'tynn', filesPopped: ['fancy'] });
        expect(html).toContain('data-dock="files"');
        expect(html).not.toContain('data-files-popped="tynn"');
    });
});
