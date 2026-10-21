import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtBoardView } from '../src/renderer/components/ArtBoardPanel.js';
import { RepoChangesView, workingTreeStatusFrom } from '../src/renderer/components/RepoChangesPanel.js';
import { PluginPane } from '../src/renderer/components/PluginPane.js';
import { VETTED_FANCY_EXPORTS } from '../src/core/plugin-panels.js';

/**
 * THE OFFICIAL PANELS (beta.33 item 14; Genie 1 renderer/components/Plugins/{ArtBoardPanel,RepoChangesPanel}.tsx). A plugin
 * ships no UI: its manifest names a vetted, Genie-bundled component and Genie draws it. Repository = the workspace repo's
 * changes, a diff, stage / unstage, commit, branch, push, pull (fancy-git-ui's WorkingTree / CommitComposer / DiffViewer).
 * ArtBoard = what agents posted for review, each with Approve / Reject and a comment that goes back to the agent.
 */

describe('the vetted list names the two first-party panels', () => {
    it('RepoChangesPanel and ArtBoardPanel are vetted exports', () => {
        expect(VETTED_FANCY_EXPORTS).toEqual(expect.arrayContaining(['RepoChangesPanel', 'ArtBoardPanel']));
    });

    it('a plugin pane naming one draws it for its workspace; without a host bridge it says so in words', () => {
        const html = renderToStaticMarkup(<PluginPane panel={{ pluginId: 'ai.genie.repository', pluginName: 'Repository', id: 'changes', title: 'Repository', fancyComponent: { export: 'RepoChangesPanel' }, props: {} }} workspace={{ id: 'tynn', path: '/w/tynn' }} />);
        expect(html).toContain('data-fancy-export="RepoChangesPanel"');
        expect(html).toMatch(/This window has no repository host|Reading the repository/);
    });
});

describe('the Repository panel', () => {
    const status = { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: false, changes: [
        { path: 'a.ts', index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false, label: 'modified' as const },
        { path: 'b.ts', index: 'A', worktree: ' ', staged: true, unstaged: false, untracked: false, label: 'added' as const },
    ] };

    it('maps git\'s status to the WorkingTree model (Genie 1 repo-status-model)', () => {
        expect(workingTreeStatusFrom(status)).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, clean: false, files: [
            { path: 'a.ts', index: null, worktree: 'modified' },
            { path: 'b.ts', index: 'added', worktree: null },
        ] });
    });

    it('shows the branch, ahead / behind, the changes, the commit box, and Push / Pull / New branch', () => {
        const html = renderToStaticMarkup(<RepoChangesView repos={[{ rel: '', name: 'tynn' }]} repoRel="" status={status} selected={[]} diff={null} busy={false} error={null} notice={null} draft={{ message: '' }} on={{}} />);
        expect(html).toContain('main');
        expect(html).toMatch(/↑\s*2|ahead 2/);
        expect(html).toContain('a.ts');
        expect(html).toContain('b.ts');
        expect(html).toMatch(/data-action="repo-push"/);
        expect(html).toMatch(/data-action="repo-pull"/);
        expect(html).toMatch(/data-action="repo-branch"/);
    });

    it('a git failure is said in git\'s words', () => {
        expect(renderToStaticMarkup(<RepoChangesView repos={[]} repoRel="" status={null} selected={[]} diff={null} busy={false} error="fatal: not a git repository" notice={null} draft={{ message: '' }} on={{}} />)).toContain('fatal: not a git repository');
    });
});

describe('the ArtBoard panel', () => {
    it('each post: its title, note, the artifact (html sandboxed, image inline), and Approve / Reject with a comment', () => {
        const html = renderToStaticMarkup(<ArtBoardView posts={[
            { id: 'login', title: 'Login screen', kind: 'html', createdAt: '2026-10-20T10:00:00Z', note: 'check contrast', html: '<h1>Hi</h1>' },
            { id: 'hero', title: 'Hero', kind: 'image', createdAt: '2026-10-20T09:00:00Z', src: 'data:image/png;base64,AAAA', review: { verdict: 'approved', at: '2026-10-20T11:00:00Z' } },
        ]} error={null} onReview={() => {}} />);
        expect(html).toContain('Login screen');
        expect(html).toContain('check contrast');
        expect(html).toMatch(/<iframe[^>]*sandbox=""[^>]*srcDoc="&lt;h1&gt;Hi&lt;\/h1&gt;"|<iframe[^>]*srcDoc="&lt;h1&gt;Hi&lt;\/h1&gt;"[^>]*sandbox=""/i);
        expect(html).toContain('src="data:image/png;base64,AAAA"');
        expect(html).toMatch(/data-action="artboard-approve"/);
        expect(html).toMatch(/data-action="artboard-reject"/);
        expect(html).toMatch(/data-verdict="approved"/);
    });

    it('nothing posted yet is said, not a blank panel', () => {
        expect(renderToStaticMarkup(<ArtBoardView posts={[]} error={null} onReview={() => {}} />)).toContain('Nothing on the board yet');
    });
});
