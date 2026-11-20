import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { lockedRepos } from '../src/core/repo-status.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * THE WORKSPACE'S BAR FITS ITS COLUMN (beta.33 item 23: "why is any content at all behind the chat panel?").
 * 2026-11-16 (the owner: "I don't need all of the repos listed in the workspace header"): no repo list, only a LOCKED repo
 * (a problem with a fix). REWRITTEN for the one bar (the owner on beta.64, 2026-11-17: "the way you have workspaces headers
 * now it's a lot of wasted space"): no header row above the tabs; the strip is the bar, its tabs scroll, and its right end
 * holds the locked repo and the actions as icons. In a column too narrow for both (800px with the chat pinned: 72px) the
 * right end moves to a line of its own rather than spill (the layout sweep measures it on a real window).
 */
const repo = (slug: string, lock: { heldSince: number; stale: boolean } | null = null) => ({ name: slug, slug, path: `repos/${slug}`, host: false, branch: 'main', lock });
const twelve = ['app', 'web', 'api', 'docs', 'cli', 'infra', 'design', 'site', 'mobile', 'sdk', 'ops', 'data'].map((s) => repo(s));
const ops = (list: ReturnType<typeof repo>[]): WorkspaceOpsProps => ({
    asleep: false, agentCount: 0, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    repos: { list, onAdd: () => {}, onRemove: () => {}, onOpen: () => {}, onRemoveLock: () => {} },
});
const render = (list: ReturnType<typeof repo>[]) => renderToStaticMarkup(<Workspace view="home" workspace={{ id: 'acme', name: 'Acme', path: '/w/acme' }} terminals={NO_TERMINALS} ops={ops(list)} />);
const bar = (html: string) => { const at = html.indexOf('data-top-bar'); return at < 0 ? '' : html.slice(html.lastIndexOf('<', at), html.indexOf('</nav>', at)); };
const classOf = (h: string, attr: string) => (new RegExp(`<[a-z]+\\b[^>]*${attr}[^>]*>`).exec(h)?.[0].match(/\sclass="([^"]*)"/)?.[1] ?? '').split(' ');

describe('which repos the bar shows', () => {
    it('only the locked ones (COUNTED: one of twelve)', () => {
        const list = twelve.map((r) => (r.slug === 'data' ? repo('data', { heldSince: 1, stale: true }) : r));
        expect(lockedRepos(list).map((r) => r.slug)).toEqual(['data']);
        expect((bar(render(list)).match(/data-repo-chip="/g) ?? []).length).toBe(1);
    });

    it('CONTROL: none locked, no chip and no "+N more"', () => {
        const h = bar(render(twelve));
        expect(h).not.toBe('');
        expect(h).not.toContain('data-repo-chip');
        expect(h).not.toContain('more-repos');
    });
});

describe('the bar, drawn', () => {
    it('one line while it fits; the tabs scroll; the right end shrinks, then wraps on a line of its own rather than spill', () => {
        const h = bar(render(twelve));
        for (const c of ['min-h-8', 'flex-wrap']) expect(classOf(h, 'data-top-bar=""')).toContain(c);
        for (const c of ['min-w-[min(6rem,100%)]', 'flex-1', 'overflow-x-auto']) expect(classOf(h, 'data-bar-tabs=""')).toContain(c);
        for (const c of ['shrink', 'min-w-0', 'max-w-full', 'flex-wrap']) expect(classOf(h, 'data-bar-trailing=""')).toContain(c);
    });

    // The path rides in the selected tab's react-fancy Tooltip (Tynn #945: built-in tabs are icons with tooltips), pinned by
    // hovering it in test/workspace-header-icons-945.test.tsx; a native title on top would show a second bubble.
    it('no path column, and no native title on the selected built-in tab', () => {
        const h = bar(render(twelve));
        expect(h).not.toContain('data-header-path');
        expect(h).toContain('data-workspace-tab="home"');
        expect(h).not.toMatch(/data-workspace-tab="home"[^>]*title=|title="[^"]*"[^>]*data-workspace-tab="home"/);
    });

    it('the actions are icons with a name: no words to wrap', () => {
        const h = bar(render(twelve));
        const rm = h.match(/<button [^>]*data-action="remove-workspace"[^>]*>/)?.[0] ?? '';
        expect(rm).toMatch(/aria-label="Remove from Genie"/);
        expect(rm).toMatch(/title="Remove from Genie[^"]*"/);
        expect(h).not.toMatch(/data-action="remove-workspace"[^>]*>(?:(?!<\/button>).)*>Remove</);
    });
});
