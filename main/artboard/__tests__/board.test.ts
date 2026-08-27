import { describe, expect, it } from 'vitest';
import { parseBoard, addPost, BOARD_DIR, BOARD_INDEX, type BoardPost } from '../board';

/**
 * THE BOARD INDEX — what an agent posted, and in what order.
 *
 * ArtBoard exists because an agent that has MADE something has no way to show
 * it. Today it can only describe the thing in words through ForceTheQuestion,
 * which is precisely what a visual review surface exists to avoid.
 *
 * The plugin worker is filesystem-only, so the shape of this feature is: the
 * agent WRITES a post, the Genie-authored panel READS it. That makes this index
 * the contract between the two halves, and the one part worth pinning before
 * either half exists.
 *
 * It is written by a plugin worker and rendered in the UI, so it is treated as
 * UNTRUSTED at parse time: a malformed entry is dropped rather than allowed to
 * fail the whole board. One bad post must not cost the others.
 */
const post = (over: Partial<BoardPost> = {}): BoardPost => ({
    id: 'p1',
    title: 'Login screen',
    kind: 'html',
    file: 'p1.html',
    createdAt: '2026-08-26T10:00:00.000Z',
    ...over,
});

describe('parseBoard', () => {
    it('reads posts newest-first, whatever order they are on disk', () => {
        const raw = JSON.stringify({
            posts: [
                post({ id: 'old', createdAt: '2026-08-26T09:00:00.000Z' }),
                post({ id: 'new', createdAt: '2026-08-26T11:00:00.000Z' }),
            ],
        });

        expect(parseBoard(raw).map((p) => p.id)).toEqual(['new', 'old']);
    });

    it('drops a malformed post instead of failing the whole board', () => {
        const raw = JSON.stringify({
            posts: [post(), { id: 'broken' }, post({ id: 'p2', file: 'p2.html' })],
        });

        expect(parseBoard(raw).map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    });

    it('drops a post whose kind is not one the panel can render', () => {
        // The kind selects a renderer. An unknown kind is a post nothing can
        // draw, so listing it would put a permanently broken card on the board.
        const raw = JSON.stringify({ posts: [post({ kind: 'executable' as never })] });

        expect(parseBoard(raw)).toEqual([]);
    });

    it('refuses a file path that escapes the board directory', () => {
        // The worker writes this file and the panel loads it. A post naming
        // `../../.ssh/id_rsa` would make the board a file-disclosure surface, so
        // it is a BARE FILENAME or it is not a post.
        const escapes = ['../secret.html', 'nested/x.html', 'C:/Windows/x.html', '..' + String.fromCharCode(92) + 'x.html'];

        for (const file of escapes) {
            expect(parseBoard(JSON.stringify({ posts: [post({ file })] }))).toEqual([]);
        }
    });

    it('survives junk without throwing, because a worker writes this file', () => {
        for (const raw of ['', 'not json', '{}', '{"posts":null}', '[]']) {
            expect(parseBoard(raw)).toEqual([]);
        }
    });

    it('keeps a post that is complete and well-formed', () => {
        // Positive control: the rejections above pass just as happily against a
        // parser that returns nothing at all.
        expect(parseBoard(JSON.stringify({ posts: [post()] }))).toEqual([post()]);
    });
});

describe('addPost', () => {
    it('puts the newest post first', () => {
        expect(addPost([post({ id: 'a' })], post({ id: 'b' })).map((p) => p.id)).toEqual(['b', 'a']);
    });

    it('replaces a post with the same id rather than duplicating it', () => {
        // Re-posting after a revision is the common case: an agent iterates on a
        // mockup and posts again. Two cards for one thing is not a history, it is
        // a board that gets harder to read every time the agent tries.
        const got = addPost([post({ id: 'a', title: 'v1' })], post({ id: 'a', title: 'v2' }));

        expect(got).toHaveLength(1);
        expect(got[0]!.title).toBe('v2');
    });

    it('caps the board so a looping agent cannot grow it without bound', () => {
        let board: BoardPost[] = [];
        for (let i = 0; i < 200; i++) board = addPost(board, post({ id: 'p' + i }));

        expect(board.length).toBeLessThanOrEqual(100);
        // The newest survive — an agent posting in a loop should push out its own
        // old drafts, not the first thing it ever showed you.
        expect(board[0]!.id).toBe('p199');
    });
});

describe('where the board lives', () => {
    it('is a single self-describing directory at the workspace root', () => {
        expect(BOARD_DIR).toBe('.artboard');
        expect(BOARD_INDEX).toBe('index.json');
    });
});
