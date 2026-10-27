import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtBoardView, ArtifactPreview } from '../src/renderer/components/ArtBoardPanel.js';
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
            { id: 'login', title: 'Login screen', kind: 'html', createdAt: '2026-10-20T10:00:00Z', note: 'check contrast', html: '<h1>Hi</h1>', askVerdict: true },
            { id: 'hero', title: 'Hero', kind: 'image', createdAt: '2026-10-20T09:00:00Z', src: 'data:image/png;base64,AAAA', askVerdict: true, review: { verdict: 'approved', at: '2026-10-20T11:00:00Z' } },
        ]} error={null} onReview={() => {}} />);
        expect(html).toContain('Login screen');
        expect(html).toContain('check contrast');
        expect(html).toMatch(/<iframe[^>]*sandbox=""[^>]*srcDoc="&lt;h1&gt;Hi&lt;\/h1&gt;"|<iframe[^>]*srcDoc="&lt;h1&gt;Hi&lt;\/h1&gt;"[^>]*sandbox=""/i);
        expect(html).toContain('src="data:image/png;base64,AAAA"');
        expect(html).toMatch(/data-action="artboard-approve"/);
        expect(html).toMatch(/data-action="artboard-reject"/);
        expect(html).toMatch(/data-verdict="approved"/);
    });

    // genie#1275 — the owner: "Artboard cards should size to the panel. They aren't always used for Approval either."
    const show = { id: 'palette', title: 'Palette', kind: 'html' as const, createdAt: '2026-10-27T10:00:00Z', html: '<p>x</p>', askVerdict: false };
    const ask = { id: 'login', title: 'Login', kind: 'html' as const, createdAt: '2026-10-27T09:00:00Z', html: '<p>y</p>', askVerdict: true };
    const card = (html: string, id: string) => {
        const at = html.indexOf(`data-artboard-post="${id}"`);
        const next = html.indexOf('data-artboard-post="', at + 1);
        return html.slice(at, next === -1 ? undefined : next);
    };

    it('a post that asks for no verdict shows the artifact only: no Approve / Reject, no comment box, no "awaiting review"', () => {
        const html = renderToStaticMarkup(<ArtBoardView posts={[show]} error={null} onReview={() => {}} />);
        expect(html).toContain('data-artboard-post="palette"');
        expect(html).toMatch(/<iframe[^>]*srcDoc="&lt;p&gt;x&lt;\/p&gt;"/);
        expect(html).not.toMatch(/data-action="artboard-approve"|data-action="artboard-reject"/);
        expect(html).not.toContain('<textarea');
        expect(html).not.toMatch(/awaiting review/i);
    });

    it('a post that asks for one gets Approve / Reject and the comment box — on its own card only', () => {
        const html = renderToStaticMarkup(<ArtBoardView posts={[show, ask]} error={null} onReview={() => {}} />);
        expect(card(html, 'login')).toMatch(/data-action="artboard-approve"/);
        expect(card(html, 'login')).toMatch(/data-action="artboard-reject"/);
        expect(card(html, 'login')).toContain('<textarea');
        expect(card(html, 'palette')).not.toMatch(/data-action="artboard-approve"|<textarea/);
    });

    it('cards fill the panel: tracks collapse when empty (auto-fit, never a fixed narrow column), the preview is sized from the panel, not a fixed box', () => {
        const html = renderToStaticMarkup(<ArtBoardView posts={[show, ask]} error={null} onReview={() => {}} />);
        // The panel is the size container its previews measure against.
        expect(html).toMatch(/data-artboard=""[^>]*class="[^"]*\[container-type:size\]/);
        // auto-FIT: one card spans the whole width (auto-fill kept empty tracks — the ~400 px card in the owner's screenshot);
        // min(100%, …): a panel narrower than the minimum still gets one full-width card, never an overflow.
        expect(html).toMatch(/data-artboard-grid=""[^>]*class="[^"]*grid-cols-\[repeat\(auto-fit,minmax\(min\(100%,\d+rem\),1fr\)\)\]/);
        expect(html).not.toContain('auto-fill');
        // The preview's height comes from the panel's height (container units), not the old fixed h-64 scrolling box.
        expect(html).not.toMatch(/\bh-64\b/);
        expect(html).toMatch(/<iframe[^>]*class="[^"]*100cqh/);
    });

    it('an image grows to its own height, capped by the panel', () => {
        const html = renderToStaticMarkup(<ArtBoardView posts={[{ id: 'hero', title: 'Hero', kind: 'image', createdAt: '2026-10-27T09:00:00Z', src: 'data:image/png;base64,AAAA', askVerdict: false }]} error={null} onReview={() => {}} />);
        expect(html).toMatch(/<img[^>]*class="[^"]*h-auto[^"]*max-h-\[[^\]]*100cqh/);
    });

    it('every card can be opened full size', () => {
        const html = renderToStaticMarkup(<ArtBoardView posts={[show, ask]} error={null} onReview={() => {}} />);
        expect(card(html, 'palette')).toMatch(/data-action="artboard-full"/);
        expect(card(html, 'login')).toMatch(/data-action="artboard-full"/);
    });

    it('the sandbox is unchanged, in the card AND full size: sandbox="" exactly — no allow-scripts, no allow-same-origin', () => {
        const inCard = renderToStaticMarkup(<ArtBoardView posts={[show, ask]} error={null} onReview={() => {}} />);
        const full = renderToStaticMarkup(<ArtifactPreview post={show} full />);
        for (const html of [inCard, full]) {
            const frames = html.match(/<iframe[^>]*>/g) ?? [];
            expect(frames.length).toBeGreaterThan(0);
            for (const f of frames) expect(f).toMatch(/\ssandbox=""/);
            expect(html).not.toMatch(/allow-/);
        }
        expect(full).toMatch(/<iframe[^>]*srcDoc="&lt;p&gt;x&lt;\/p&gt;"/);
    });

    it('nothing posted yet is said, not a blank panel', () => {
        expect(renderToStaticMarkup(<ArtBoardView posts={[]} error={null} onReview={() => {}} />)).toContain('Nothing on the board yet');
    });
});
