import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DisplayPost } from '../src/core/artboard.js';
import { ArtBoardView, ArtifactPreview } from '../src/renderer/components/ArtBoardPanel.js';
import { control } from './helpers/control-markup.js';

/**
 * THE ARTBOARD TAB'S BOARD (Tynn #739). What the person sees: Waiting by default (decided items hidden, pinned ones kept),
 * Decided and All a click away, a pin on every item, every version viewable and comparable side by side, the whole trail on
 * the card, HTML shown at the size it was made for with a zoom, documents rendered — and the one item a link points at shown
 * even when it has been decided.
 */
const at = (n: number) => `2026-11-15T10:${String(n).padStart(2, '0')}:00.000Z`;
const base = (over: Partial<DisplayPost> & { id: string }): DisplayPost => ({ title: over.id, kind: 'html', createdAt: at(1), html: `<p>${over.id}</p>`, askVerdict: true, ...over });
const waiting = base({ id: 'waiting', createdAt: at(1) });
const approved = base({ id: 'approved', createdAt: at(2), review: { verdict: 'approved', at: at(5) } });
const rejected = base({ id: 'rejected', createdAt: at(3), review: { verdict: 'rejected', at: at(6), comment: 'No' } });
const pinned = base({ id: 'pinned', createdAt: at(4), pinned: true, review: { verdict: 'approved', at: at(7) } });
const info = base({ id: 'info', createdAt: at(8), askVerdict: false });
const all = [info, pinned, rejected, approved, waiting];
const view = (props: Partial<Parameters<typeof ArtBoardView>[0]> = {}) => renderToStaticMarkup(<ArtBoardView posts={all} error={null} onReview={() => {}} onPin={() => {}} {...props} />);
const shownIds = (html: string) => [...html.matchAll(/data-artboard-post="([^"]+)"/g)].map((m) => m[1]);
const card = (html: string, id: string) => {
    const from = html.indexOf(`data-artboard-post="${id}"`);
    const next = html.indexOf('data-artboard-post="', from + 1);
    return html.slice(from, next === -1 ? undefined : next);
};

describe('what shows by default: Waiting', () => {
    it('hides decided items; pinned ones and ones that asked for nothing stay', () => {
        expect(shownIds(view())).toEqual(['info', 'pinned', 'waiting']);
    });

    it('Decided shows only the decided, All shows everything', () => {
        expect(shownIds(view({ initialFilter: 'decided' }))).toEqual(['pinned', 'rejected', 'approved']);
        expect(shownIds(view({ initialFilter: 'all' }))).toEqual(['info', 'pinned', 'rejected', 'approved', 'waiting']);
    });

    it('the three filters are real buttons, the current one pressed, each with its count', () => {
        const html = view();
        expect(control(html, 'data-artboard-filter="waiting"')).toMatchObject({ tag: 'button', fancy: true });
        expect(control(html, 'data-artboard-filter="waiting"')!.open).toContain('aria-pressed="true"');
        expect(control(html, 'data-artboard-filter="waiting"')!.text).toMatch(/Waiting\s*3/);
        expect(control(html, 'data-artboard-filter="decided"')!.open).toContain('aria-pressed="false"');
        expect(control(html, 'data-artboard-filter="decided"')!.text).toMatch(/Decided\s*3/);
        expect(control(html, 'data-artboard-filter="all"')!.text).toMatch(/All\s*5/);
    });

    it('the item a link points at is shown even though it is decided', () => {
        expect(shownIds(view({ focusId: 'approved' }))).toEqual(['info', 'pinned', 'approved', 'waiting']);
        expect(card(view({ focusId: 'approved' }), 'approved')).toContain('data-artboard-focus="true"');
        expect(card(view({ focusId: 'approved' }), 'waiting')).not.toContain('data-artboard-focus');
    });

    it('with everything decided, says nothing is waiting and where the rest is, instead of a blank panel', () => {
        const html = view({ posts: [approved, rejected] });
        expect(html).toMatch(/Nothing is waiting/);
        expect(html).toMatch(/2 decided/);
        expect(shownIds(html)).toEqual([]);
    });

    it('an empty board still says nothing has been posted', () => {
        expect(view({ posts: [] })).toContain('Nothing on the board yet');
    });
});

describe('pinning', () => {
    it('every card has a Pin button; a pinned item shows it pressed', () => {
        const html = view({ initialFilter: 'all' });
        expect(control(card(html, 'approved'), 'data-action="artboard-pin"')).toMatchObject({ tag: 'button', fancy: true });
        expect(control(card(html, 'approved'), 'data-action="artboard-pin"')!.open).toContain('aria-pressed="false"');
        expect(control(card(html, 'pinned'), 'data-action="artboard-pin"')!.open).toContain('aria-pressed="true"');
        expect(control(card(html, 'pinned'), 'data-action="artboard-pin"')!.text).toMatch(/Pinned/);
    });

    it('a view with no pin host offers none', () => {
        expect(view({ onPin: undefined })).not.toContain('data-action="artboard-pin"');
    });
});

describe('versions and the trail', () => {
    const two = base({
        id: 'login', title: 'Login', createdAt: at(10), html: '<h1>two</h1>', poster: 'atlas',
        versions: [
            { n: 1, kind: 'html', createdAt: at(1), html: '<h1>one</h1>', poster: 'atlas', note: 'first try' },
            { n: 2, kind: 'html', createdAt: at(10), html: '<h1>two</h1>', poster: 'atlas', note: 'more contrast' },
        ],
        trail: [
            { type: 'verdict', version: 1, verdict: 'rejected', comment: 'More contrast', at: at(5), by: 'person' },
            { type: 'reply', version: 1, text: 'Darkened the header', at: at(6), agentName: 'atlas' },
        ],
    });

    it('lists every version as a button, the newest pressed, and offers a side-by-side compare', () => {
        const html = view({ posts: [two] });
        expect(control(html, 'data-artboard-version="1"')).toMatchObject({ tag: 'button', fancy: true });
        expect(control(html, 'data-artboard-version="2"')!.open).toContain('aria-pressed="true"');
        expect(control(html, 'data-action="artboard-compare"')).toMatchObject({ tag: 'button', fancy: true });
        expect(html).toContain('&lt;h1&gt;two&lt;/h1&gt;');
        expect(html).not.toContain('&lt;h1&gt;one&lt;/h1&gt;');
    });

    it('a post with one version has no version row', () => {
        expect(view({ posts: [waiting] })).not.toContain('data-artboard-versions');
    });

    it('compared, shows the earlier and the later version in two frames side by side', () => {
        const html = view({ posts: [two], initialCompare: 'login' });
        expect(html).toContain('data-artboard-compare=""');
        expect(html).toContain('&lt;h1&gt;one&lt;/h1&gt;');
        expect(html).toContain('&lt;h1&gt;two&lt;/h1&gt;');
    });

    it('the whole trail is on the card: each version posted, each verdict and comment, each reply, oldest first', () => {
        const trail = card(view({ posts: [two] }), 'login');
        const at1 = trail.indexOf('first try'), at2 = trail.indexOf('More contrast'), at3 = trail.indexOf('Darkened the header'), at4 = trail.lastIndexOf('more contrast');
        expect(trail).toContain('data-artboard-trail=""');
        expect([at1, at2, at3, at4].every((i) => i > 0)).toBe(true);
        expect(at1).toBeLessThan(at2);
        expect(at2).toBeLessThan(at3);
        expect(at3).toBeLessThan(at4);
        expect(trail).toMatch(/rejected/);
        expect(trail).toMatch(/atlas/);
    });

    it('a post with no history has no trail section', () => {
        expect(card(view({ posts: [waiting] }), 'waiting')).not.toContain('data-artboard-trail');
    });
});

describe('kinds', () => {
    it('HTML made for a size is shown at that size, scaled to fit, with a zoom', () => {
        const html = renderToStaticMarkup(<ArtifactPreview post={base({ id: 'hero', width: 1280, height: 800 })} />);
        expect(html).toContain('data-artboard-frame-size="1280x800"');
        expect(html).toMatch(/<iframe[^>]*style="[^"]*width:1280px/);
        expect(html).toMatch(/<iframe[^>]*sandbox=""/);
        expect(control(html, 'data-artboard-zoom="fit"')).toMatchObject({ tag: 'button', fancy: true });
        expect(control(html, 'data-artboard-zoom="1"')).toMatchObject({ tag: 'button', fancy: true });
    });

    it('HTML with no size fills the panel, as before, and has no zoom', () => {
        const html = renderToStaticMarkup(<ArtifactPreview post={base({ id: 'x' })} />);
        expect(html).toMatch(/<iframe[^>]*class="[^"]*100cqh/);
        expect(html).not.toContain('data-artboard-zoom');
    });

    it('a Markdown document is rendered, not shown as source', () => {
        const html = renderToStaticMarkup(<ArtifactPreview post={base({ id: 'spec', kind: 'markdown', text: '# Spec heading', html: undefined as never })} />);
        expect(html).toContain('data-artboard-doc="markdown"');
        expect(html).toMatch(/<h1[^>]*>Spec heading/);
        expect(html).not.toContain('# Spec heading');
    });

    it('a PDF is embedded as a PDF, with a way out when it cannot be shown', () => {
        const html = renderToStaticMarkup(<ArtifactPreview post={base({ id: 'brief', kind: 'pdf', src: 'data:application/pdf;base64,JVBERi0=', html: undefined as never })} />);
        expect(html).toMatch(/<object[^>]*type="application\/pdf"/);
        expect(html).toContain('data:application/pdf;base64,JVBERi0=');
        expect(html).toContain('data-artboard-doc="pdf"');
    });
});
