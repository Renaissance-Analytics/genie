import { describe, expect, it } from 'vitest';
import { clearChoices, clearedMessage, clearedToast, clearPrompt, clearSelection, restoredMessage, visiblePosts, type BoardPost, type Review } from '../src/core/artboard.js';
import { originLabel } from '../src/core/workspace-storage.js';

/**
 * CLEARING THE BOARD (genie#847). The owner: "give me a way to clear all boards in an artboard" — a board showing Waiting 9,
 * Decided 6, All 15, and nothing to empty it with. What is pinned here is the PURE half:
 *  - Clear decided takes every decided item except the pinned; Clear all takes every item, waiting ones too, except the
 *    pinned; Clear everything takes the pinned as well;
 *  - the menu says each one's count, and the confirmation names it ("Clear 12 items?");
 *  - a waiting item cleared is closed "without a verdict", and its agent is told so, by name and id, so it does not wait
 *    forever; put back, it is told again;
 *  - a cleared batch in .trash reads as ArtBoard items in the Storage tab.
 */
const at = (n: number) => `2026-11-17T10:${String(n).padStart(2, '0')}:00.000Z`;
const review = (verdict: Review['verdict'], n: number): Review => ({ verdict, at: at(n) });
const post = (id: string, over: Partial<BoardPost> = {}): BoardPost => ({ id, title: `Title ${id}`, kind: 'html', file: `${id}.html`, createdAt: at(1), ...over });

// 15 items: 6 waiting, 1 shown (asked for nothing), 1 waiting AND pinned, 5 decided, 2 decided AND pinned.
const board: BoardPost[] = [
    ...['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((id) => post(id)),
    post('s1', { askVerdict: false }),
    post('wp', { pinned: true }),
    post('d1', { review: review('approved', 2) }), post('d2', { review: review('rejected', 3) }), post('d3', { review: review('approved', 4) }),
    post('d4', { review: review('approved', 5) }), post('d5', { review: review('rejected', 6) }),
    post('dp1', { review: review('approved', 7), pinned: true }), post('dp2', { review: review('rejected', 8), pinned: true }),
];
const ids = (list: readonly { id: string }[]) => list.map((p) => p.id);

describe('what each Clear takes', () => {
    it('Clear decided: the 5 decided items, never the 2 pinned ones', () => {
        expect(ids(clearSelection(board, 'decided'))).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    });

    it('Clear all: 12 items, waiting ones included, every pinned item kept', () => {
        expect(ids(clearSelection(board, 'all'))).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 's1', 'd1', 'd2', 'd3', 'd4', 'd5']);
    });

    it('Clear everything (pinned too): all 15', () => {
        expect(clearSelection(board, 'everything')).toHaveLength(15);
    });

    it('what Clear decided leaves is exactly what the board still shows as decided: the pinned', () => {
        const left = board.filter((p) => !clearSelection(board, 'decided').includes(p));
        expect(ids(visiblePosts(left, 'decided'))).toEqual(['dp1', 'dp2']);
    });
});

describe('the menu and its confirmation', () => {
    it('lists the three choices in order, each with how many items it would take', () => {
        expect(clearChoices(board)).toEqual([
            { scope: 'decided', label: 'Clear decided', count: 5 },
            { scope: 'all', label: 'Clear all', count: 12 },
            { scope: 'everything', label: 'Clear all, pinned too', count: 15 },
        ]);
    });

    it('asks with the count: "Clear 12 items?", and "Clear 1 item?" for one', () => {
        expect(clearPrompt('all', 12).title).toBe('Clear 12 items?');
        expect(clearPrompt('decided', 1).title).toBe('Clear 1 item?');
        expect(clearPrompt('all', 12).confirmLabel).toBe('Clear 12');
    });

    it('says where they go, what happens to waiting ones, and what stays', () => {
        expect(clearPrompt('decided', 5).body).toMatch(/\.trash/);
        expect(clearPrompt('decided', 5).body).toMatch(/pinned/i);
        expect(clearPrompt('all', 12).body).toMatch(/without a verdict/);
        expect(clearPrompt('everything', 15).body).not.toMatch(/pinned items stay/i);
    });

    it('the toast afterwards offers Undo for a few seconds', () => {
        const t = clearedToast(12);
        expect(t.title).toBe('Cleared 12 items');
        expect(t.actionLabel).toBe('Undo');
        expect(t.duration).toBeGreaterThanOrEqual(5000);
        expect(t.duration).toBeLessThanOrEqual(10_000);
        expect(clearedToast(1).title).toBe('Cleared 1 item');
    });
});

describe('what the agent that posted it is told', () => {
    it('cleared without a verdict, by title and id, and what to do if it still needs one', () => {
        const m = clearedMessage({ id: 'w1', title: 'Login page' });
        expect(m).toContain('"Login page"');
        expect(m).toMatch(/cleared from the board without a verdict/);
        expect(m).toContain('`w1`');
    });

    it('put back: it is waiting for a verdict again', () => {
        const m = restoredMessage({ id: 'w1', title: 'Login page' });
        expect(m).toContain('"Login page"');
        expect(m).toMatch(/back on the board/);
    });
});

describe('a cleared batch in .trash, as the Storage tab names it', () => {
    it('reads as ArtBoard items, by its label', () => {
        expect(originLabel({ kind: 'artboard', ids: ['d1', 'd2'], label: '2 items (Clear decided)' })).toBe('ArtBoard: 2 items (Clear decided)');
    });
});
