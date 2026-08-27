import { describe, expect, it } from 'vitest';
import { resolveBoard } from '../resolve';
import type { BoardPost } from '../board';

/**
 * Turning a stored board into what a human actually sees.
 *
 * The renderer cannot read the filesystem, so content is resolved in main and
 * crosses the IPC boundary as markup or a `data:` URL. The panel therefore never
 * holds a path — there is nothing for it to be tricked into fetching.
 *
 * The judgement worth pinning is what happens to a post that CANNOT be resolved,
 * because a review surface that quietly shows four of five posts is how a
 * reviewer approves the wrong thing.
 */
const post = (over: Partial<BoardPost> = {}): BoardPost => ({
    id: 'p1',
    title: 'Login screen',
    kind: 'html',
    file: 'p1.html',
    createdAt: '2026-08-26T10:00:00.000Z',
    ...over,
});

const deps = (over: Partial<Parameters<typeof resolveBoard>[1]> = {}) => ({
    readText: () => '<h1>hi</h1>',
    readBase64: () => 'AAAA',
    ...over,
});

describe('resolveBoard', () => {
    it('inlines the markup of an html post', () => {
        const got = resolveBoard([post()], deps());

        expect(got.posts[0]!.html).toBe('<h1>hi</h1>');
        expect(got.error).toBeUndefined();
    });

    it('turns an image into a data URL with the right mime type', () => {
        // A wrong mime renders nothing at all, silently — the card would look
        // posted-but-blank, which reads as the agent's fault.
        const got = resolveBoard([post({ kind: 'image', file: 'p1.png' })], deps());

        expect(got.posts[0]!.src).toBe('data:image/png;base64,AAAA');
    });

    it('carries the note and the existing verdict through', () => {
        const got = resolveBoard(
            [post({ note: 'check the nav', review: { verdict: 'rejected', at: 't' } })],
            deps(),
        );

        expect(got.posts[0]!.note).toBe('check the nav');
        expect(got.posts[0]!.review?.verdict).toBe('rejected');
    });

    it('DROPS a post whose file is gone, and says how many', () => {
        // Not rendered as an empty card: an empty card claims the agent posted
        // nothing, which is a different statement and a wrong one.
        const got = resolveBoard([post(), post({ id: 'p2', file: 'p2.html' })], {
            ...deps(),
            readText: (f: string) => (f === 'p1.html' ? '<h1>hi</h1>' : null),
        });

        expect(got.posts.map((p) => p.id)).toEqual(['p1']);
        expect(got.error).toContain('1 post');
    });

    it('drops an image whose extension names no known type', () => {
        // Guessing a mime for `.bin` would render a broken image rather than an
        // honest absence.
        const got = resolveBoard([post({ kind: 'image', file: 'p1.bin' })], deps());

        expect(got.posts).toEqual([]);
        expect(got.error).toBeTruthy();
    });

    it('treats a THROWING read as a missing post, not a broken board', () => {
        const got = resolveBoard([post(), post({ id: 'ok', file: 'ok.html' })], {
            ...deps(),
            readText: (f: string) => {
                if (f === 'p1.html') throw new Error('EACCES');
                return '<p>fine</p>';
            },
        });

        // Positive control rides along: the surviving post is still resolved, so
        // this cannot pass against an implementation that gave up on first error.
        expect(got.posts.map((p) => p.id)).toEqual(['ok']);
        expect(got.error).toContain('1 post');
    });

    it('reports nothing wrong when every post resolves', () => {
        // Negative control for the error cases above.
        const got = resolveBoard([post(), post({ id: 'p2', file: 'p2.html' })], deps());

        expect(got.posts).toHaveLength(2);
        expect(got.error).toBeUndefined();
    });
});
