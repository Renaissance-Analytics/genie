import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';

/**
 * THE DOCK'S NOTICE (§4.4): a second pin replaces the first VISIBLY — the shell says what moved, under the title bar;
 * a file panel with unsaved edits refuses to be replaced, says so, and offers pop-out. Both are one line with a door,
 * never a silent change and never a modal.
 */
const snapshot: GenieSnapshot = { ...EMPTY_SNAPSHOT, workspaces: [{ id: 'tynn', path: 'C:/_Projects/tynn.ai', agentsKnown: true }], workstation: { name: 'alphar', healthy: true } };
const render = (props: Partial<Parameters<typeof Shell>[0]> = {}) =>
    renderToStaticMarkup(
        <Shell route="genie://dashboard?group=workspace" snapshot={snapshot} servable={['dashboard', 'deck', 'agent', 'workspace']} agentDetail={null} agentResolved={false} selectedRowId={null} chatThread={null} pinned={null}
            onNavigate={() => {}} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}} onSend={() => {}} onTogglePin={() => {}} onCloseChat={() => {}} answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}} {...props} />,
    );

describe('the dock notice', () => {
    it('a replaced pin is said: which panel moved out, and the lamp that went out is named', () => {
        const html = render({ dockNotice: { kind: 'replaced', replaced: 'chat', pinned: 'files' } });
        expect(html).toMatch(/data-dock-notice="replaced"[^>]*>[\s\S]*?The chat is no longer pinned; the file panel took the dock/);
        expect(html).toContain('data-action="dismiss-dock-notice"');
    });

    it('a refusal is said with its reason and offers to pop the file panel out', () => {
        // The door exists only where popping out is possible (a files bridge with windows); the shell is told so by the app.
        const html = render({ dockNotice: { kind: 'refused', reason: 'The file panel has unsaved edits. Save them, or pop the panel out to keep both.', workspaceId: 'tynn' }, onPopOutFiles: () => {} });
        expect(html).toMatch(/data-dock-notice="refused"[^>]*>[\s\S]*?unsaved edits/);
        expect(html).toMatch(/data-action="pop-out-files"[^>]*data-workspace="tynn"/);
    });

    it('no notice → nothing drawn', () => {
        expect(render()).not.toContain('data-dock-notice');
    });
});
