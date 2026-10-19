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
    it('nothing pinned: no files dock, even with a workspace remembered', () => {
        expect(render({ pinned: null, filesWorkspaceId: 'tynn' })).not.toContain('data-dock="files"');
    });
});
