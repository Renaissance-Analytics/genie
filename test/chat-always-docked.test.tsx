import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chatSubjectFor } from '../src/core/chat-scope.js';
import { parseRoute } from '../src/core/route.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { railSurfacesFor, railWorkspaces } from '../src/core/rail-view.js';
import { Shell } from '../src/renderer/Shell.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';

/**
 * THE CHAT IS ALWAYS OPEN, AND NEVER COVERS ANYTHING (the owner, 2026-10-19: "why do I need to click on the chat button
 * to open it. IT SHOULD ALWAYS BE OPEN IN THE WORKSPACE SCREENS. Also, the chat still covers up the UX. Chat cannot be
 * closed PERIOD").
 *
 * Measured cause of the cover-up: the chat floated over the page (`position: absolute`), and each page made room for it
 * with a margin on every child EXCEPT its view header. Since agents open inside their workspace (beta.30) a page has TWO
 * headers; the Shell measured the first (the workspace's tabs), so the agent's own header — exempt from the margin — ran
 * on under the chat. Now the chat is a COLUMN of the layout beside the page, so nothing can be under it, however a page
 * nests. And:
 *  - no close button, no "open chat" button: there is always a chat — the agent the view says (`followChat`);
 *  - the file panel cannot take the chat's place any more: in a workspace it shows inline, and pops out to its own window;
 *  - the sidebar: the hibernated and + tools go to the top row, and the "Workspaces" heading is a plain bar.
 */
function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'x', name: 'x', provider: 'claude', workspaceId: 'ws', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over };
}
const agents: AgentRow[] = [row({ id: 'a_atlas', name: 'atlas' }), row({ id: 'a_genie', name: 'genie', workspaceId: '__genie__' })];

describe('there is always a chat', () => {
    it('with no chat in the route: the agent the view says — Genie off a workspace, the agent on its page', () => {
        expect(chatSubjectFor(parseRoute('genie://dashboard'), agents, [])).toBe('a_genie');
        expect(chatSubjectFor(parseRoute('genie://agent/a_atlas?tab=stream'), agents, [])).toBe('a_atlas');
        expect(chatSubjectFor(parseRoute('genie://workspace/ws'), agents, [])).toBe('a_atlas');
    });

    it('CONTROL: a route that names its chat keeps it', () => {
        expect(chatSubjectFor(parseRoute('genie://dashboard?chat=a_atlas'), agents, [])).toBe('a_atlas');
    });
});

describe('the chat is a column beside the page, never over it', () => {
    const snapshot: GenieSnapshot = { ...EMPTY_SNAPSHOT, agents, workspaces: [{ id: 'ws', path: '/w/ws', agentsKnown: true }] };
    const thread = { agentId: 'a_genie', name: 'genie', fidelity: 'declared' as const, unread: null, messages: [] };
    const shell = (over: Partial<Parameters<typeof Shell>[0]> = {}) =>
        renderToStaticMarkup(
            <Shell
                route="genie://dashboard"
                snapshot={snapshot}
                servable={['dashboard', 'deck', 'agent', 'workspace']}
                agentDetail={null}
                agentResolved={false}
                selectedRowId={null}
                chatThread={thread}
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

    it('after the page in the same row, with its own width — not floated (position: absolute) over it', () => {
        const html = shell();
        expect(html).toMatch(/<\/main>[\s\S]*data-dock-frame="chat"/);
        const frame = html.match(/<[^>]*data-dock-frame="chat"[^>]*>/)?.[0] ?? '';
        expect(frame).not.toBe('');
        expect(frame).not.toMatch(/position:\s*absolute/);
        expect(frame).toMatch(/width:\s*\d+px/);
    });

    it('no close button and no "open chat" button: it cannot be closed (COUNTED: zero of each)', () => {
        const html = shell();
        expect(html.match(/aria-label="Close chat"/g) ?? []).toHaveLength(0);
        expect(html.match(/data-action="open-chat"/g) ?? []).toHaveLength(0);
        expect(html).not.toContain('data-chat-edge');
    });

    it('still there while its thread is being read', () => {
        expect(shell({ chatThread: null })).toContain('data-dock-frame="chat"');
    });

    it('nothing compensates for an overlay any more: no margin rule for a floating dock', () => {
        expect(readFileSync('src/renderer/styles.css', 'utf8')).not.toMatch(/margin-right:\s*var\(--dock-reserve/);
    });

    it('a workspace’s file panel shows inline, with no Pin (the chat holds the side for good); pop-out stays', () => {
        const html = shell({ route: 'genie://workspace/ws?panel=files', pinned: 'files', filesWorkspaceId: 'ws', onPopOutFiles: () => {} });
        expect(html).toContain('data-files-panel="ws"');
        expect(html).not.toContain('data-action="pin-files"');
        expect(html).toContain('data-action="pop-out-files"');
        expect(html).not.toContain('data-dock="files"');
    });
});

describe('the sidebar', () => {
    const asleep = railWorkspaces([{ id: 'w1', path: '/w/1', asleep: true }, { id: 'w2', path: '/w/2' }] as never, []);
    const html = renderToStaticMarkup(
        <Sidebar route="genie://dashboard" deckCount={0} workspaces={asleep} available={railSurfacesFor(['dashboard', 'deck', 'workspace', 'settings'])} onNavigate={() => {}} onAddWorkspace={() => {}} />,
    );

    it('the hibernated and + tools sit in the TOP row, beside collapse', () => {
        const tools = html.match(/<div[^>]*data-rail-tools=""[^>]*>[\s\S]*?<\/div>/)?.[0] ?? '';
        expect(tools).toContain('data-rail-tool="collapse"');
        expect(tools).toContain('data-rail-tool="hibernated"');
        expect(tools).toContain('data-rail-tool="add-workspace"');
    });

    it('no "Workspaces" heading — a plain bar above the filter (positive control: the filter is there)', () => {
        expect(html).not.toMatch(/>\s*Workspaces\s*</);
        expect(html).toMatch(/data-rail-divider=""[\s\S]*data-rail-filter=""/);
    });
});
