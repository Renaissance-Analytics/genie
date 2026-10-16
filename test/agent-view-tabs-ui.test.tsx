import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_FILES } from '../src/renderer/bridge.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * EVERY TAB HAS A BODY. The board audit of 2026-10-12: the Agent view rendered a body only for Stream; Files and
 * Changes (declared), Files and Changes (remote) were tabs over an empty area. Files is the workspace's one file
 * panel (§4.3), mounted here for the agent's workspace; Changes is the files this agent changed this session, each
 * opening in the panel. A window with no files host says so in a sentence — never a blank.
 */
const agent = { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn' };
const workspace = { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' };
const render = (props: Partial<Parameters<typeof AgentView>[0]>) =>
    renderToStaticMarkup(<AgentView agent={agent} session={null} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} {...props} />);

describe('the Files tab', () => {
    it("mounts the workspace's file panel for the agent's workspace", () => {
        const html = render({ tab: 'files', files: NO_FILES, workspace });
        expect(html).toContain('data-files-panel="tynn"');
        expect(html).not.toContain('data-tab-unavailable');
    });

    it('says so when this window has no files host or the workspace is unknown — a sentence, not a blank', () => {
        const noHost = render({ tab: 'files', workspace });
        expect(noHost).toContain('data-tab-unavailable="files"');
        expect(noHost).not.toContain('data-files-panel');
        const noWorkspace = render({ tab: 'files', files: NO_FILES });
        expect(noWorkspace).toContain('data-tab-unavailable="files"');
    });
});

describe('the Changes tab', () => {
    it("lists the files THIS agent changed this session, one row each, each a way into the panel", () => {
        const html = render({ tab: 'changes', files: NO_FILES, workspace, initialChanges: ['src/a.ts', 'src/b.ts'] });
        expect(html).toContain('data-agent-changes="a1"');
        expect((html.match(/data-agent-change="/g) ?? []).length).toBe(2);
        expect(html).toContain('data-agent-change="src/a.ts"');
        // No `+n −m` — the host reports no diff; never faked (§4.3).
        expect(html).not.toMatch(/[+−]\d/);
    });

    it('with none: a sentence naming the agent, not an empty list and not a dash', () => {
        const html = render({ tab: 'changes', files: NO_FILES, workspace, initialChanges: null });
        expect(html).toContain('No changes from atlas this session.');
        expect(html).not.toContain('data-agent-change=');
        expect(html).not.toMatch(/[—–]/);
    });

    it('the Stream tab is untouched by this: no files panel, no changes list', () => {
        const html = render({ tab: 'stream', files: NO_FILES, workspace, initialChanges: ['src/a.ts'] });
        expect(html).not.toContain('data-files-panel');
        expect(html).not.toContain('data-agent-changes');
    });
});
