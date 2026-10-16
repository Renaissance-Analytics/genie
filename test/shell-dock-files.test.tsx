import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CHAT_STRIP_WIDTH, DOCK_WIDTH } from '../src/core/dock.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * THE FILE PANEL IN THE DOCK (§4.3, §4.4). Pinned, the one workspace file panel moves into the single
 * dock slot: a column of DOCK_WIDTH on the right, the content row giving up exactly that reserve, on
 * every surface — not only the Workspace. Unpinned, it is inline on the Workspace surface and the dock
 * is empty. Chat and files never share the dock.
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

describe('the file panel in the dock', () => {
    it('pinned: a dock column of DOCK_WIDTH holds the panel of the pinned workspace on ANY surface, the content row reserves the same width, the pin lamp is on', () => {
        const html = render({ pinned: 'files', filesWorkspaceId: 'tynn' });
        expect(html).toContain('data-dock="files"');
        expect(html).toMatch(new RegExp(`data-dock="files"[^>]*width:${DOCK_WIDTH}px`));
        expect(html).toContain('data-files-panel="tynn"');
        expect(html).toContain(`data-dock-reserve="${DOCK_WIDTH}"`);
        expect(html).toContain('data-pin="on"');
    });

    it('unpinned: no dock, only the chat strip’s reserve; on the Workspace surface the panel is inline with the lamp off', () => {
        const dashboard = render({ pinned: null });
        expect(dashboard).not.toContain('data-dock="files"');
        expect(dashboard).toContain(`data-dock-reserve="${CHAT_STRIP_WIDTH}"`);
        const workspace = render({ pinned: null, route: 'genie://workspace/tynn?panel=files' });
        expect(workspace).toContain('data-files-panel="tynn"');
        expect(workspace).toContain('data-pin="off"');
        expect(workspace).not.toContain('data-dock="files"');
    });

    it('pinned files on the Workspace surface: the panel is in the dock, not inline too — one panel per workspace', () => {
        const html = render({ pinned: 'files', filesWorkspaceId: 'tynn', route: 'genie://workspace/tynn?panel=files' });
        expect((html.match(/data-files-panel="tynn"/g) ?? []).length).toBe(1);
        expect(html).toContain('data-dock="files"');
    });

    it('chat pinned: no files dock', () => {
        expect(render({ pinned: 'chat', filesWorkspaceId: 'tynn' })).not.toContain('data-dock="files"');
    });
});
