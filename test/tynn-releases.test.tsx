import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseReleases, tynnPagePath, TYNN_SECTIONS } from '../src/core/tynn-pages.js';
import { TynnReleasesPanel } from '../src/renderer/components/TynnReleasesPanel.js';

/**
 * THE TYNN TAB'S RELEASES (genie#1295 row R1): tynn.ai's Releases page, natively — read only. The totals (releases,
 * stories delivered), then each release newest first: its number, title, Released chip, its PR, the date, its
 * description, how many stories and the first five by number, "+ n more". "No releases yet" when there are none.
 */
const RELEASES = {
    project_id: 'p1',
    releases: [
        {
            id: 'v2', number: '1.1.0', title: 'Second <drop>', description: 'What shipped', why: null, released_at: '2026-10-30T12:00:00+00:00', pr_id: '42', repository_id: null,
            story_count: 7, story_done_count: 6,
            top_stories: [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, story_number: n, title: `Story ${n}`, status: 'done' })),
        },
        { id: 'v1', number: '1.0.0', title: 'First', description: null, why: null, released_at: '2026-10-01T00:00:00+00:00', pr_id: null, repository_id: null, story_count: 0, story_done_count: 0, top_stories: [] },
    ],
};
const noop = () => {};

describe('reading Releases', () => {
    it('reads each release, newest first as Tynn sends them, with the date, the PR, the rollup and the first stories', () => {
        const r = parseReleases(RELEASES)!;
        expect(r.totalStories).toBe(7);
        expect(r.releases.map((x) => x.id)).toEqual(['v2', 'v1']);
        expect(r.releases[0]).toMatchObject({ number: '1.1.0', date: '2026-10-30', pr: '42', storyCount: 7, more: 2 });
        expect(r.releases[0]!.top.map((s) => s.number)).toEqual(['#1', '#2', '#3', '#4', '#5']);
        expect(parseReleases({ level: 'versions' })).toBeNull();
    });

    it('is read at the project\'s own Releases door, and is a page of the tab with tynn.ai\'s rocket after VIP', () => {
        expect(tynnPagePath('p1', 'releases', {})).toBe('/api/v1/projects/p1/releases');
        const ids = TYNN_SECTIONS.map((s) => s.id);
        expect(ids.indexOf('releases')).toBe(ids.indexOf('vip') + 1);
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
        expect(html).toContain('2026-10-30');
        expect(html).toContain('#42');
        expect(html).toContain('7 stories');
        expect(html).toContain('Story 5');
        expect(html).toContain('+ 2 more stories');
        expect(html).toMatch(/data-release="v1"/);
    });

    it('says there are no releases yet, and why there is nothing when it cannot read', () => {
        expect(render({ state: { state: 'ready', view: parseReleases({ project_id: 'p1', releases: [] })! } })).toContain('No releases yet');
        expect(render({ state: { state: 'loading' } })).toMatch(/data-tynn-page-state="loading"/);
        expect(render({ state: { state: 'signed-out', reason: 'Sign in to Tynn again.' } })).toContain('Sign in to Tynn again.');
        void noop;
    });

    it('shows live as an icon', () => {
        expect(render({ live: 'live' })).toMatch(/data-tynn-live="live"/);
    });
});
