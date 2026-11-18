import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseHome } from '../src/core/tynn-pages.js';
import { TynnHomePanel } from '../src/renderer/components/TynnHomePanel.js';

/**
 * Tynn story #848: the Home dashboard's version picker lists only the current roadmap.
 *
 * tynn.ai's ProjectHome (app/Services/Workspace/ProjectHome.php, `availableVersions`) answers every `active`, `accepted`
 * and `released` version, newest roadmap slot first (`orderByDesc('order')`), each with its `status`. It has no filter
 * parameter, and the web dashboard wants the released ones, so Genie filters: the active version first, then the
 * upcoming (`accepted`) ones in roadmap order (ascending `order`, which is Tynn's order reversed). Released, done,
 * archived, draft, review and VIP versions are never offered. Titles arrive HTML-escaped ("R&amp;D") and are decoded.
 */
const noop = (): void => undefined;

/** In Tynn's order: `order` descending. */
const SERVED = [
    { id: 'rel-new', number: '0.9.0-beta.3', title: 'Old beta', status: 'released' },
    { id: 'up-2', number: '1.3.0', title: 'Later', status: 'accepted' },
    { id: 'up-1', number: '1.2.0', title: 'R&amp;D &#39;next&#39; &lt;b&gt;', status: 'accepted' },
    { id: 'now', number: '1.1.0', title: 'Now &amp; here', status: 'active' },
    { id: 'rel-hot', number: '1.0.1', title: 'Hotfix', status: 'released' },
    { id: 'gone', number: '0.1.0', title: 'Gone', status: 'archived' },
    { id: 'idea', number: 'IYZ-284', title: 'Platform', status: 'draft' },
    { id: 'shipped', number: '0.2.0', title: 'Shipped', status: 'done' },
    { id: 'vip', number: 'MGN-454', title: 'Guardian', status: 'vip' },
];

const served = (version: { id: string; number: string; title: string; status: string } | null, availableVersions: unknown[] = SERVED) => ({
    project_id: 'p1', section: 'dashboard', details: null,
    dashboard: {
        range: 30, metrics: {}, taskBreakdown: {}, storyBreakdown: {}, sparkline: [], charts: {},
        availableVersions,
        version: version === null ? null : { ...version, completed_tasks: 1, total_tasks: 2, completed_stories: 0, total_stories: 1, burndown: {}, window: {}, forecast: { tone: 'on_track', label: 'On track', remaining_tasks: 1 } },
        versionComparison: [], attention: [], recentActivity: [],
    },
});

const options = (html: string): Array<{ value: string; label: string; selected: boolean }> =>
    [...html.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map((m) => ({
        value: /value="([^"]*)"/.exec(m[1]!)?.[1] ?? '',
        label: m[2]!,
        selected: /\sselected=""/.test(m[1]!),
    }));

describe('#848 the Home version picker lists the current roadmap only', () => {
    it('keeps the active version first, then upcoming versions in roadmap order; nothing released, done, archived, draft or VIP', () => {
        const d = parseHome(served(SERVED[3]!))!.dashboard!;
        expect(d.versions.map((v) => v.id)).toEqual(['now', 'up-1', 'up-2']);
    });

    it('decodes HTML entities in version titles, once', () => {
        const d = parseHome(served(SERVED[3]!, [...SERVED, { id: 'up-3', number: '1.4.0', title: 'A &amp;amp; B', status: 'accepted' }]))!.dashboard!;
        expect(d.versions.map((v) => v.title)).toEqual(["Now & here", "R&D 'next' <b>", 'Later', 'A &amp; B']);
    });

    it('the picker offers those versions, labelled, with the active one selected by default', () => {
        const html = renderToStaticMarkup(<TynnHomePanel state={{ state: 'ready', view: parseHome(served(SERVED[3]!))! }} onQuery={noop} onSave={noop} />);
        const offered = options(html).filter((o) => o.value !== '');
        expect(offered.map((o) => o.value)).toEqual(['now', 'up-1', 'up-2']);
        expect(offered.find((o) => o.selected)?.value).toBe('now');
        // React escapes the decoded "&" once; an undecoded title would show "&amp;amp;".
        expect(html).not.toContain('&amp;amp;');
        expect(html).not.toMatch(/Old beta|Hotfix|Gone|Platform|Shipped|Guardian/);
    });

    it('a served version that is not on the roadmap (a released one asked for by id) selects nothing rather than mislabelling the dashboard', () => {
        const html = renderToStaticMarkup(<TynnHomePanel state={{ state: 'ready', view: parseHome(served(SERVED[4]!))! }} onQuery={noop} onSave={noop} />);
        const offered = options(html).filter((o) => o.value !== '');
        expect(offered.map((o) => o.value)).toEqual(['now', 'up-1', 'up-2']);
        expect(offered.some((o) => o.selected)).toBe(false);
        // Control: the same render with the active version served does select it (see the test above).
    });
});
