import { describe, expect, it } from 'vitest';
import { resolveActiveBoardPost, resolveBoardFocus } from '../artboard-model';

describe('ArtBoard active preview', () => {
    const posts = [
        { id: 'new', title: 'New', kind: 'html', createdAt: 'now' },
        { id: 'old', title: 'Old', kind: 'image', createdAt: 'then' },
    ] as const;

    it('selects the artifact requested by artboard.post', () => {
        expect(resolveActiveBoardPost(posts as never, 'old')?.id).toBe('old');
    });

    it('falls back to the newest artifact when the requested one is gone', () => {
        expect(resolveActiveBoardPost(posts as never, 'missing')?.id).toBe('new');
    });
});

/**
 * The CANVAS focus is a different question from which post the review card shows
 * (genie#457).
 *
 * `resolveActiveBoardPost` answers "which post does the card below show?", and
 * its fallback to the newest post is right for that. The panel was also using it
 * to answer "which post is zoomed on the canvas?", where the same fallback means
 * ALWAYS ZOOMED: fancy-artboard is controlled for focus, so dismissing it called
 * `onFocusChange(null)`, the resolver handed back `posts[0]` on the very next
 * render, and focus mode reopened. There was no reachable off state — the owner
 * had to delete the element from the DOM to escape it.
 */
describe('ArtBoard canvas focus (genie#457)', () => {
    const posts = [
        { id: 'new', title: 'New', kind: 'html', createdAt: 'now' },
        { id: 'old', title: 'Old', kind: 'image', createdAt: 'then' },
    ] as const;

    it('stays dismissed — a null focus does not fall back to a post', () => {
        expect(resolveBoardFocus(posts as never, null)).toBeNull();
    });

    it('keeps a focus that still names a post on the board', () => {
        // POSITIVE CONTROL for the test above: focus is genuinely resolvable
        // here, so "null" there is a dismissal and not an inert function.
        expect(resolveBoardFocus(posts as never, 'old')).toBe('old');
    });

    it('drops a focus whose post has left the board', () => {
        expect(resolveBoardFocus(posts as never, 'deleted')).toBeNull();
    });

    it('is null on an empty board', () => {
        expect(resolveBoardFocus([], 'new')).toBeNull();
    });
});
