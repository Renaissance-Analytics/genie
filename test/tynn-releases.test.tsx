import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseReleases, parseTynnPage, tynnPagePath, TYNN_PAGES, TYNN_SECTIONS } from '../src/core/tynn-pages.js';
import { TynnReleasesPanel } from '../src/renderer/components/TynnReleasesPanel.js';
import { TynnTab } from '../src/renderer/components/TynnTab.js';

/**
 * THE TYNN TAB'S RELEASES (genie#1295 row R1, workspace-ux 0.8.0 surface `releases`): tynn.ai's Releases page, natively,
 * read only. The totals (releases, stories delivered), then each release newest first: its number, title, Released chip,
 * its PR, the date, its description, how many stories and the first five by number, "+ n more". "No releases yet" when
 * there are none. Read through the host's page door (genie-host `engine.tynnPage`), like WIP.
 */
const RELEASES = {
    project_id: 'p1',
    releases: [
        {
            id: 'v2', number: '1.1.0', title: 'Second <drop>', description: 'What shipped', why: null, released_at: '2026-10-30T12:00:00+00:00', pr_id: '42', repository_id: null,
            story_count: 7, story_done_count: 6,
            top_stories: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `s${n}`, story_number: n, title: `Story ${n}`, status: 'done' })),
        },
        { id: 'v1', number: '1.0.0', title: 'First', description: null, why: null, released_at: '2026-10-01T00:00:00+00:00', pr_id: null, repository_id: null, story_count: 0, story_done_count: 0, top_stories: [] },
    ],
};
const noop = () => {};

describe('reading Releases', () => {
    it('reads each release in Tynn\'s order (newest first), with the date, the PR, the rollup and at most five stories', () => {
        const r = parseReleases(RELEASES)!;
        expect(r.totalStories).toBe(7);
        expect(r.releases.map((x) => x.id)).toEqual(['v2', 'v1']);
        expect(r.releases[0]).toMatchObject({ number: '1.1.0', date: '2026-10-30', pr: '42', storyCount: 7, storyDone: 6, more: 2 });
        expect(r.releases[0]!.top.map((s) => s.number)).toEqual(['#1', '#2', '#3', '#4', '#5']);
        expect(r.releases[1]).toMatchObject({ number: '1.0.0', pr: null, description: null, storyCount: 0, more: 0, top: [] });
        // Not a Releases answer: nothing is drawn from it.
        expect(parseReleases({ level: 'versions' })).toBeNull();
        expect(parseTynnPage('releases', RELEASES)).toMatchObject({ page: 'releases', view: { totalStories: 7 } });
        expect(parseTynnPage('releases', { stories: [] })).toBeNull();
    });

    it('is read at the project\'s own Releases door, with only the contract\'s query (product)', () => {
        expect(TYNN_PAGES).toContain('releases');
        expect(tynnPagePath('p1', 'releases', {})).toBe('/api/v1/projects/p1/releases');
        expect(tynnPagePath('p1', 'releases', { product: 'pr-1', view: 'attention', project_id: 'other' })).toBe('/api/v1/projects/p1/releases?product=pr-1');
        expect(tynnPagePath('p1', 'releases', { product: '' })).toBe('/api/v1/projects/p1/releases');
    });

    it('is a page of the tab, after the Board as in tynn.ai\'s nav, with tynn.ai\'s rocket', () => {
        const ids = TYNN_SECTIONS.map((s) => s.id);
        expect(ids.indexOf('releases')).toBeGreaterThan(ids.indexOf('board'));
        expect(TYNN_SECTIONS.find((s) => s.id === 'releases')).toMatchObject({ icon: 'rocket', label: 'Releases' });
    });
});

describe('the Releases page', () => {
    const render = (over: Partial<Parameters<typeof TynnReleasesPanel>[0]> = {}) =>
        renderToStaticMarkup(<TynnReleasesPanel state={{ state: 'ready', view: parseReleases(RELEASES)! }} {...over} />);

    it('shows the totals and each release card as tynn.ai does; titles are text, never markup', () => {
        const html = render();
        expect(html).toMatch(/data-releases-total="releases"[^>]*>2</);
        expect(html).toMatch(/data-releases-total="stories"[^>]*>7</);
        expect(html).toContain('Second &lt;drop&gt;');
        expect(html).not.toContain('<drop>');
        expect(html).toContain('2026-10-30');
        expect(html).toContain('#42');
        expect(html).toContain('7 stories');
        expect(html).toContain('Story 5');
        expect(html).not.toContain('Story 6');
        expect(html).toContain('+ 2 more stories');
        expect(html).toMatch(/data-release="v1"/);
    });

    it('says there are no releases yet, and why there is nothing when it cannot read', () => {
        expect(render({ state: { state: 'ready', view: parseReleases({ project_id: 'p1', releases: [] })! } })).toMatch(/data-releases-state="empty"[\s\S]*No releases yet/);
        expect(render({ state: { state: 'loading' } })).toMatch(/data-tynn-page-state="loading"/);
        expect(render({ state: { state: 'not-linked' } })).toContain('This workspace has no Tynn project.');
        expect(render({ state: { state: 'signed-out', reason: 'Sign in to Tynn again.' } })).toContain('Sign in to Tynn again.');
        expect(render({ state: { state: 'error', reason: 'Tynn did not answer.' } })).toContain('Tynn did not answer.');
    });

    it('shows live and reconnecting as icons', () => {
        expect(render({ live: 'live' })).toMatch(/data-tynn-live="live"/);
        expect(render({ live: 'reconnecting' })).toMatch(/data-tynn-live="reconnecting"/);
        expect(render()).not.toMatch(/data-tynn-live=/);
    });
});

describe('the tab offers Releases where the window can read pages', () => {
    const refused = async () => ({ ok: false as const, state: 'error' as const, reason: 'x' });
    it('opens Releases from the nav with a page door; without one it is not offered', () => {
        const withPages = { read: refused, act: async () => ({ ok: true as const }), page: refused };
        const html = renderToStaticMarkup(<TynnTab workspaceId="w1" host={withPages as never} initialSection="releases" />);
        expect(html).toMatch(/data-tynn-section="releases"/);
        expect(html).toMatch(/data-tynn-page-state="loading"/);
        const boardOnly = { read: refused, act: async () => ({ ok: true as const }) };
        expect(renderToStaticMarkup(<TynnTab workspaceId="w1" host={boardOnly as never} />)).not.toMatch(/data-tynn-section="releases"/);
        void noop;
    });
});
