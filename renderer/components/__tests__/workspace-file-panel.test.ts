import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Floor from '../Master/Floor';
import CodePanel from '../Code/CodePanel';
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
        expect(html).toContain('Changed (1)');
        expect(html).toContain('atlas');
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
        expect(html).toContain('Changed (1)');
        expect(html).toContain('Changes this session');
        expect(html).toContain('data-react-fancy-table');
        expect(html).toContain('a.ts');
        expect(html).toContain('atlas');
        expect(html).not.toContain('+42');
    });
});
