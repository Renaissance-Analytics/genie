import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Floor from '../Master/Floor';
import CodePanel from '../Code/CodePanel';
import WorkspaceFilePanel from '../Code/WorkspaceFilePanel';
import { emptyAgentSession } from '../../../main/agentsession/model';
import type { TerminalSpec, WorkspaceRow } from '../../lib/genie';
import fs from 'node:fs';
import path from 'node:path';

const workspace = { id: 'w', path: '/w', project_name: 'Workspace' } as WorkspaceRow;
vi.mock('../Terminal/Terminal', () => ({ default: () => null }));
const spec = { id: 'files', type: 'code', cwd: '/w', workspace_id: 'w', label: 'Files', meta: {} } as TerminalSpec;
const agent = emptyAgentSession({ agentId: 'atlas', specId: 'agent', name: 'atlas', provider: 'claude', cwd: '/w', workspaceId: 'w' }, 100);
agent.tools = [{ id: 'edit', name: 'Edit', kind: 'edit', status: 'success', rawInput: { file_path: '/w/a.ts' }, result: null, at: 100 }];

describe('the existing CodePanel renders workspace changes', () => {
    it('receives sessions through the real Floor and both grid layers', () => {
        const html = renderToStaticMarkup(React.createElement(Floor, {
            sessions: [agent], specs: [spec], workspacesById: new Map([['w', workspace]]),
            focusId: null, maximizedId: null, attentionIds: new Set<string>(),
            onClose: () => {}, onFocus: () => {}, onToggleMaximize: () => {},
            onAddTerminal: () => {}, onMarkActive: () => {}, onMarkInactive: () => {},
            layoutMode: 'auto', projectCount: 1, activeCount: 0,
        }));
        // `Changed 1` — the owner's mockup replaced the `Tabs` strip with a segmented
        // control, so the count no longer wears parentheses. Asserted here as the NEW
        // contract rather than relaxed: the number still has to be the measured one.
        expect(html).toContain('Changed 1');
        expect(html).toContain('atlas');
    });
    it('renders the PANEL, not the stand-in, where nothing can hold a claim', () => {
        // `WorkspaceFilePanel` decides between the real panel and the stand-in from
        // `filePanelSlot`, whose `owned` starts null — the claim is in flight. With NO DOM
        // there is no window to claim with and the claim will never arrive, so sitting on
        // `opening` would hide the panel for good. The grid's inline branch had this as
        // `typeof window !== 'undefined' &&`; it lives in the component now.
        //
        // It is not a test convenience: the test above renders the whole Floor to prove the
        // session snapshot reaches the panel, and a stand-in in its place shows an empty
        // Changes list — which reads exactly like an agent that edited nothing.
        const html = renderToStaticMarkup(React.createElement(WorkspaceFilePanel, {
            spec, workspace, sessions: [agent], onClose: () => {},
        }));
        expect(html).toContain('data-react-fancy-multi-switch');
        expect(html).toContain('Changed 1');
        expect(html).not.toContain('code-popped');

        // POSITIVE CONTROL: ⌘B still produces the empty slot, so the three assertions above
        // are the no-DOM fall-through rather than a component that never draws a stand-in.
        const closed = renderToStaticMarkup(React.createElement(WorkspaceFilePanel, {
            spec, workspace, sessions: [agent], closed: true, onClose: () => {},
        }));
        expect(closed).toContain('code-popped');
        expect(closed).not.toContain('data-react-fancy-multi-switch');
    });
    it('gives the session list room without the tree pushing it below the viewport', () => {
        const css = fs.readFileSync(path.resolve(import.meta.dirname, '../../styles/master.css'), 'utf8');
        expect(css).toMatch(/\.code-host \.code-tree\s*\{[^}]*display: flex;[^}]*flex-direction: column;/);
        expect(css).toMatch(/\.code-tree \.filetree-root\s*\{[^}]*min-height: 0;/);
    });
    it('shows the real changed count and session attribution, without line-count guesses', () => {
        const html = renderToStaticMarkup(React.createElement(CodePanel, {
            spec, workspace, sessions: [agent], onClose: () => {},
        }));
        expect(html).toContain('Changed 1');
        // And it is the segmented control the mockup specifies, not a tab strip.
        expect(html).toContain('data-react-fancy-multi-switch');
        expect(html).toContain('Changes this session');
        expect(html).toContain('data-react-fancy-table');
        expect(html).toContain('a.ts');
        expect(html).toContain('atlas');
        expect(html).not.toContain('+42');
    });
});
