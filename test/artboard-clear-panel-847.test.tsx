import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DisplayPost } from '../src/core/artboard.js';
import { ArtBoardView } from '../src/renderer/components/ArtBoardPanel.js';
import { control } from './helpers/control-markup.js';

/**
 * THE CLEAR MENU AND DELETE, ON THE BOARD (genie#847). A "Clear" menu in the board's header beside the filters (react-fancy
 * Button + Dropdown; its choices and counts are core's clearChoices), and a Delete on each card. The header stays when the
 * board is empty, so clearing it does not make the panel jump; Clear is then disabled. A board without the actions offers
 * neither.
 */
const at = (n: number) => `2026-11-17T10:${String(n).padStart(2, '0')}:00.000Z`;
const base = (over: Partial<DisplayPost> & { id: string }): DisplayPost => ({ title: `Title ${over.id}`, kind: 'html', createdAt: at(1), html: `<p>${over.id}</p>`, askVerdict: true, ...over });
const posts = [base({ id: 'w1' }), base({ id: 'w2' }), base({ id: 'd1', review: { verdict: 'approved', at: at(2) } })];
const view = (props: Partial<Parameters<typeof ArtBoardView>[0]> = {}) =>
    renderToStaticMarkup(<ArtBoardView posts={posts} error={null} onReview={() => {}} onPin={() => {}} onClear={() => {}} onDelete={() => {}} {...props} />);
const count = (html: string, attr: string) => html.split(attr).length - 1;

describe('the Clear menu', () => {
    it('is a react-fancy button named Clear, in the header with the filters', () => {
        const html = view();
        const clear = control(html, 'data-action="artboard-clear"');
        expect(clear).toMatchObject({ tag: 'button', fancy: true });
        expect(clear!.text).toBe('Clear');
        const header = html.slice(html.indexOf('data-artboard-header'), html.indexOf('data-artboard-grid'));
        expect(header).toContain('data-artboard-filters');
        expect(header).toContain('data-action="artboard-clear"');
    });

    it('a board that cannot clear offers no menu', () => {
        expect(view({ onClear: undefined })).not.toContain('data-action="artboard-clear"');
    });

    it('an empty board keeps its header (no jump when the last item goes) with Clear disabled', () => {
        const html = view({ posts: [] });
        expect(html).toContain('data-artboard-header');
        expect(html).toContain('data-artboard-filters');
        expect(control(html, 'data-action="artboard-clear"')!.open).toMatch(/\sdisabled(=""|\s|>)/);
    });
});

describe('Delete on each card', () => {
    it('every card shown has one, a react-fancy button named for its item', () => {
        const html = view({ initialFilter: 'all' });
        expect(count(html, 'data-action="artboard-delete"')).toBe(3);
        const del = control(html, 'data-action="artboard-delete"');
        expect(del).toMatchObject({ tag: 'button', fancy: true });
        expect(del!.open).toContain('aria-label="Delete Title w1"');
    });

    it('a board that cannot delete offers none', () => {
        expect(view({ onDelete: undefined })).not.toContain('data-action="artboard-delete"');
    });
});
