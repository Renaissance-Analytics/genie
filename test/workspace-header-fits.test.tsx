import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { lockedRepos } from '../src/core/repo-status.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';

/**
 * THE WORKSPACE HEADER FITS ITS COLUMN (beta.33 item 23: "why is any content at all behind the chat panel?").
 * REWRITTEN 2026-11-16 (the owner: "I don't need all of the repos listed in the workspace header"): no repo list at all,
 * only a LOCKED repo (a problem with a fix). The header is the agent view's: one line, the title cluster clips, the path
 * gives way first, the actions never wrap.
 */
const repo = (slug: string, lock: { heldSince: number; stale: boolean } | null = null) => ({ name: slug, slug, path: `repos/${slug}`, host: false, branch: 'main', lock });
const twelve = ['app', 'web', 'api', 'docs', 'cli', 'infra', 'design', 'site', 'mobile', 'sdk', 'ops', 'data'].map((s) => repo(s));
const ops = (list: ReturnType<typeof repo>[]): WorkspaceOpsProps => ({
    asleep: false, agentCount: 0, lastOutcome: null, removePreview: false,
    onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
    repos: { list, onAdd: () => {}, onRemove: () => {}, onOpen: () => {}, onRemoveLock: () => {} },
});
const render = (list: ReturnType<typeof repo>[]) => renderToStaticMarkup(<Workspace view="home" workspace={{ id: 'acme', name: 'Acme', path: '/w/acme' }} terminals={NO_TERMINALS} ops={ops(list)} />);
const header = (html: string) => html.slice(html.indexOf('<header data-view-header'), html.indexOf('</header>'));

describe('which repos the header shows', () => {
    it('only the locked ones (COUNTED: one of twelve)', () => {
        const list = twelve.map((r) => (r.slug === 'data' ? repo('data', { heldSince: 1, stale: true }) : r));
        expect(lockedRepos(list).map((r) => r.slug)).toEqual(['data']);
        expect((header(render(list)).match(/data-repo-chip="/g) ?? []).length).toBe(1);
    });

    it('CONTROL: none locked, no chip and no "+N more"', () => {
        const h = header(render(twelve));
        expect(h).not.toContain('data-repo-chip');
        expect(h).not.toContain('more-repos');
    });
});

describe('the header, drawn', () => {
    it('one line whose title cluster clips, so it never spills past its column', () => {
        const h = header(render(twelve));
        expect(h).toMatch(/^<header data-view-header="" class="[^"]*\bh-11\b/);
        expect(h).not.toMatch(/^<header data-view-header="" class="[^"]*\bflex-wrap\b/);
        const cluster = h.match(/<div data-header-title=""[^>]*class="([^"]*)"/)?.[1]?.split(' ') ?? [];
        for (const c of ['min-w-0', 'flex-1', 'overflow-hidden']) expect(cluster).toContain(c);
    });

    it('the path gives way first: it truncates and may shrink to nothing', () => {
        const path = header(render(twelve)).match(/<span data-header-path="" class="([^"]*)"/)?.[1]?.split(' ') ?? [];
        expect(path).toContain('truncate');
        expect(path).toContain('min-w-0');
    });

    it('the actions never wrap; their words give way to the icon in a narrow header, which keeps their name', () => {
        const h = header(render(twelve));
        const hib = h.match(/<button [^>]*data-action="hibernate"[^>]*>/)?.[0] ?? '';
        expect(hib).toMatch(/whitespace-nowrap/);
        expect(hib).toMatch(/aria-label="Hibernate"/);
        expect(h).toMatch(/data-action="hibernate"[^>]*>(?:(?!<\/button>).)*<span class="@max-\[46rem\]:hidden">Hibernate/);
    });
});
