import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../..', file), 'utf8');

describe('workspace files use the existing panel and push sources', () => {
    it('threads the master session snapshot through the Floor and grid', () => {
        expect(source('pages/master.tsx')).toMatch(/<Floor\s+sessions=\{sessions\}/);
        expect(source('components/Master/Floor.tsx')).toMatch(/sessions\?: AgentSession\[\]/);
        const grid = source('components/Master/TerminalGrid.tsx');
        expect(grid).toMatch(/<PanelFor\s+sessions=\{sessions\}/);
        // RETARGETED: the grid's `code` slot now mounts `WorkspaceFilePanel`, which decides
        // between the panel and a stand-in (popped / not claimed / duplicate window) before
        // rendering `CodePanel`. The invariant is unchanged and is the point of this guard —
        // the session snapshot must reach the panel through every layer, or the Changes list
        // silently shows nothing and looks like an agent that edited nothing.
        expect(grid).toMatch(/<WorkspaceFilePanel\s+sessions=\{sessions\}/);
        expect(source('components/Code/WorkspaceFilePanel.tsx')).toMatch(/sessions=\{sessions\}/);
    });

    it('reuses a workspace panel instead of creating another, including closed panels', () => {
        expect(source('pages/master.tsx')).toMatch(/filePanelForWorkspace\(specs, workspaceId\)/);
    });

    it('deduplicates selected legacy editors, not unselected specs that could hide the chosen editor', () => {
        expect(source('pages/master.tsx')).toMatch(/uniqueWorkspaceFilePanels\(workspaceSurfaceSpecs\(specs\)\.filter/);
    });

    it('the popped window hosts CodePanel, never another editor or terminal', () => {
        expect(source('pages/terminal.tsx')).toMatch(/<WorkspaceFilesWindow\s+specId=\{fileSpecId\}/);
        expect(source('components/Code/WorkspaceFilesWindow.tsx')).toMatch(/<CodePanel/);
        expect(source('components/Code/WorkspaceFilesWindow.tsx')).not.toMatch(/<CodeEditor|<Terminal\b/);
    });

    it('the popped editor mounts the existing prompt host for unsaved edits and file operations', () => {
        expect(source('components/Code/WorkspaceFilesWindow.tsx')).toMatch(/<PromptHost\s*\/>/);
    });

    it('retains the explicit System workspace full-filesystem mode in its popped window', () => {
        expect(source('components/Code/WorkspaceFilesWindow.tsx')).toContain('makeSystemWorkspace(panel.cwd)');
    });

    it('sessions keep updating on the workbench and on pushed activity', () => {
        const master = source('pages/master.tsx');
        expect(master).not.toContain('if (!surface.showDeck && !surface.showAgent) return;');
        expect(master).toMatch(/api\(\)\.on\.agentPulse\?\.\(loadSessions\)/);
    });
});
