import { describe, expect, it } from 'vitest';
import {
    POST_KINDS, addPost, addReply, applyVerdict, artboardItemRoute, nextVersionNumber, parseBoard, postStatus, setPinned, trailOf, trailTimeline,
    versionFile, versionsOf, visiblePosts, waitingCount, type BoardPost,
} from '../src/core/artboard.js';
import { parseRoute } from '../src/core/route.js';

/**
 * THE PAPER TRAIL (Tynn #739; the owner, 2026-11-15: "Items in an artboard need to have a paper trail as long as they are in
 * the workspace, hide after voting but can be pinned for longer review"). An item keeps every revision, every verdict and
 * every agent reply; a decided item hides from the default view unless the person pinned it. This is the pure store: what is
 * kept, and what is shown. It is written to the workspace as JSON and read back after a restart, so persistence is a test too.
 */
const at = (n: number) => `2026-11-15T10:${String(n).padStart(2, '0')}:00.000Z`;
const post = (over: Partial<BoardPost> = {}): BoardPost => ({ id: 'p1', title: 'Login screen', kind: 'html', file: 'p1.html', createdAt: at(0), askVerdict: true, ...over });
const review = (verdict: 'approved' | 'rejected', n: number, comment?: string) => ({ verdict, at: at(n), ...(comment ? { comment } : {}) });

describe('item kinds', () => {
    it('adds documents (markdown, PDF) to HTML and images', () => {
        expect([...POST_KINDS]).toEqual(['html', 'image', 'markdown', 'pdf']);
        expect(parseBoard(JSON.stringify({ posts: [post({ kind: 'markdown', file: 'spec.md' }), post({ id: 'p2', kind: 'pdf', file: 'spec.pdf' })] }))).toHaveLength(2);
    });
});

describe('versions: re-posting an id appends, it does not replace', () => {
    it('a new post is version 1', () => {
        const board = addPost([], post());
        expect(versionsOf(board[0]!)).toMatchObject([{ n: 1, file: 'p1.html', createdAt: at(0) }]);
    });

    it('a re-post adds version 2 and keeps version 1 viewable, with its own file and note', () => {
        const first = addPost([], post({ note: 'first try' }));
        const board = addPost(first, post({ title: 'Login screen v2', file: 'p1.v2.html', createdAt: at(5), note: 'more contrast' }));
        expect(board).toHaveLength(1);
        expect(board[0]).toMatchObject({ title: 'Login screen v2', file: 'p1.v2.html' });
        expect(versionsOf(board[0]!).map((v) => [v.n, v.file, v.note])).toEqual([[1, 'p1.html', 'first try'], [2, 'p1.v2.html', 'more contrast']]);
    });

    it('a post stored before versions existed counts as version 1 when it is re-posted', () => {
        const legacy = post({ createdAt: at(0) });
        expect(versionsOf(legacy)).toMatchObject([{ n: 1, file: 'p1.html' }]);
        const board = addPost([legacy], post({ file: 'p1.v2.html', createdAt: at(3) }));
        expect(versionsOf(board[0]!).map((v) => v.n)).toEqual([1, 2]);
    });

    it('names the next version and its file so no earlier file is overwritten', () => {
        const board = addPost(addPost([], post()), post({ file: 'p1.v2.html', createdAt: at(1) }));
        expect(nextVersionNumber(board, 'p1')).toBe(3);
        expect(nextVersionNumber(board, 'unknown')).toBe(1);
        expect(versionFile('p1', 1, '.html')).toBe('p1.html');
        expect(versionFile('p1', 3, '.html')).toBe('p1.v3.html');
    });

    it('keeps the poster on each version', () => {
        const board = addPost(addPost([], post({ agentId: 'agent_1', agentName: 'atlas' })), post({ file: 'p1.v2.html', createdAt: at(2), agentId: 'agent_2', agentName: 'wren' }));
        expect(versionsOf(board[0]!).map((v) => v.agentName)).toEqual(['atlas', 'wren']);
    });
});

describe('verdicts are recorded, never overwritten', () => {
    it('keeps every verdict with who and when, and the latest is the item\'s review', () => {
        let board = addPost([], post());
        board = applyVerdict(board, 'p1', review('rejected', 1, 'More contrast'), 'person');
        board = addPost(board, post({ file: 'p1.v2.html', createdAt: at(2) }));
        board = applyVerdict(board, 'p1', review('approved', 3), 'person');
        expect(board[0]!.review).toEqual(review('approved', 3));
        expect(board[0]!.trail).toEqual([
            { type: 'verdict', version: 1, verdict: 'rejected', comment: 'More contrast', at: at(1), by: 'person' },
            { type: 'verdict', version: 2, verdict: 'approved', at: at(3), by: 'person' },
        ]);
    });

    it('a re-post is awaiting a verdict again, but the earlier verdicts stay in the trail', () => {
        let board = applyVerdict(addPost([], post()), 'p1', review('rejected', 1, 'No'), 'person');
        expect(postStatus(board[0]!)).toBe('rejected');
        board = addPost(board, post({ file: 'p1.v2.html', createdAt: at(2) }));
        expect(board[0]!.review).toBeUndefined();
        expect(postStatus(board[0]!)).toBe('waiting');
        expect(board[0]!.trail).toHaveLength(1);
    });

    it('a verdict on a post that is not there changes nothing', () => {
        const board = addPost([], post());
        expect(applyVerdict(board, 'gone', review('approved', 1), 'person')).toEqual(board);
    });

    it('a very long comment is cut in the trail, with the cut said', () => {
        const board = applyVerdict(addPost([], post()), 'p1', review('rejected', 1, 'x'.repeat(50_000)), 'person');
        const entry = board[0]!.trail![0]! as { comment?: string };
        expect(entry.comment!.length).toBeLessThan(21_000);
        expect(entry.comment).toMatch(/cut$|\[cut\]$|…$/);
    });
});

describe('agent replies', () => {
    it('records a reply against the version it answers', () => {
        let board = applyVerdict(addPost([], post()), 'p1', review('rejected', 1, 'More contrast'), 'person');
        board = addReply(board, 'p1', { text: 'Darkened the header to #111', at: at(2), agentId: 'agent_1', agentName: 'atlas' });
        expect(board[0]!.trail!.at(-1)).toEqual({ type: 'reply', version: 1, text: 'Darkened the header to #111', at: at(2), agentId: 'agent_1', agentName: 'atlas' });
    });

    it('a blank reply is not recorded', () => {
        const board = addPost([], post());
        expect(addReply(board, 'p1', { text: '   ', at: at(1) })).toEqual(board);
    });
});

describe('what shows: Waiting hides decided items, pinned ones stay', () => {
    const waiting = post({ id: 'w', title: 'Waiting', createdAt: at(1) });
    const approved = post({ id: 'a', title: 'Approved', createdAt: at(2), review: review('approved', 5) });
    const rejected = post({ id: 'r', title: 'Rejected', createdAt: at(3), review: review('rejected', 6) });
    const info = post({ id: 'i', title: 'Just a look', createdAt: at(4), askVerdict: false });
    const all = [info, rejected, approved, waiting];

    it('the default view (Waiting) hides decided items; an item that asked for nothing is not decided', () => {
        expect(visiblePosts(all, 'waiting').map((p) => p.id)).toEqual(['i', 'w']);
    });

    it('Decided shows only the decided; All shows everything', () => {
        expect(visiblePosts(all, 'decided').map((p) => p.id)).toEqual(['r', 'a']);
        expect(visiblePosts(all, 'all').map((p) => p.id)).toEqual(['i', 'r', 'a', 'w']);
    });

    it('a pinned decided item stays in the default view; unpinned, it hides again', () => {
        const pinned = setPinned(all, 'a', true);
        expect(visiblePosts(pinned, 'waiting').map((p) => p.id)).toEqual(['i', 'a', 'w']);
        expect(visiblePosts(setPinned(pinned, 'a', false), 'waiting').map((p) => p.id)).toEqual(['i', 'w']);
    });

    it('pinning survives a re-post', () => {
        const board = addPost(setPinned([approved], 'a', true), post({ id: 'a', file: 'a.v2.html', createdAt: at(9) }));
        expect(board[0]!.pinned).toBe(true);
    });

    it('an item the link points at is shown even when it is hidden by the filter', () => {
        expect(visiblePosts(all, 'waiting', 'a').map((p) => p.id)).toEqual(['i', 'a', 'w']);
    });

    it('the badge counts items awaiting a verdict: asked, and not yet decided', () => {
        expect(waitingCount(all)).toBe(1);
        expect(waitingCount([])).toBe(0);
        expect(waitingCount([waiting, post({ id: 'w2', createdAt: at(7) })])).toBe(2);
        // Pinned and decided is not waiting; it is only kept in view.
        expect(waitingCount(setPinned(all, 'a', true))).toBe(1);
    });
});

describe('it lasts: stored in the workspace, read back after a restart or an upgrade', () => {
    it('versions, verdicts, replies and the pin round-trip through the index file', () => {
        let board = addPost([], post({ agentId: 'agent_1', agentName: 'atlas', width: 1280, height: 800 }));
        board = applyVerdict(board, 'p1', review('rejected', 1, 'Bigger'), 'person');
        board = addReply(board, 'p1', { text: 'On it', at: at(2), agentId: 'agent_1', agentName: 'atlas' });
        board = addPost(board, post({ file: 'p1.v2.html', createdAt: at(3), agentId: 'agent_1', agentName: 'atlas', width: 1280, height: 800 }));
        board = setPinned(board, 'p1', true);
        expect(parseBoard(JSON.stringify({ posts: board }))).toEqual(board);
    });

    it('a board written before any of this still reads, and shows what it showed', () => {
        const old = JSON.stringify({ posts: [{ id: 'p1', title: 'Old', kind: 'html', file: 'p1.html', createdAt: at(0), review: { verdict: 'approved', at: at(1) } }] });
        const [p] = parseBoard(old);
        expect(p).toMatchObject({ id: 'p1', review: { verdict: 'approved' } });
        expect(versionsOf(p!)).toHaveLength(1);
        expect(visiblePosts([p!], 'waiting')).toEqual([]);
    });

    it('junk in the trail, the versions or the pin costs only that part', () => {
        const raw = JSON.stringify({ posts: [{ ...post(), pinned: 'yes', trail: [{ type: 'verdict' }, 7, { type: 'reply', version: 1, text: 'ok', at: at(1) }], versions: [{ n: 'x' }, { n: 1, file: '../escape.html', kind: 'html', createdAt: at(0) }] }] });
        const [p] = parseBoard(raw);
        expect(p).toBeDefined();
        expect(p!.pinned).toBeUndefined();
        expect(p!.trail).toEqual([{ type: 'reply', version: 1, text: 'ok', at: at(1) }]);
        expect(versionsOf(p!).map((v) => v.file)).toEqual(['p1.html']);
    });

    it('a looping agent cannot grow the board without bound, but a trail is never cut to make room', () => {
        let board: BoardPost[] = [applyVerdict([post({ id: 'keep' })], 'keep', review('approved', 1), 'person')[0]!];
        board = setPinned(board, 'keep', true);
        for (let i = 0; i < 600; i++) board = addPost(board, post({ id: 'p' + i, createdAt: `2026-11-16T00:00:00.${String(i).padStart(3, '0')}Z` }));
        expect(board.length).toBeLessThanOrEqual(501);
        expect(board.some((p) => p.id === 'keep')).toBe(true);
        expect(board.some((p) => p.id === 'p599')).toBe(true);
    });
});

describe('what an agent reads: the trail', () => {
    it('lists the versions and everything decided or said, oldest first, so a revision can answer the last comment', () => {
        let board = addPost([], post({ note: 'first try', agentName: 'atlas', agentId: 'agent_1' }));
        board = applyVerdict(board, 'p1', review('rejected', 1, 'More contrast'), 'person');
        board = addReply(board, 'p1', { text: 'Darkened it', at: at(2), agentName: 'atlas' });
        board = addPost(board, post({ file: 'p1.v2.html', createdAt: at(3), note: 'v2', agentName: 'atlas', agentId: 'agent_1' }));
        expect(trailTimeline(board[0]!).map((e) => [e.kind, e.version])).toEqual([['version', 1], ['verdict', 1], ['reply', 1], ['version', 2]]);
        const report = trailOf(board[0]!);
        expect(report).toMatchObject({ id: 'p1', status: 'waiting', pinned: false, currentVersion: 2, lastVerdict: { verdict: 'rejected', comment: 'More contrast', version: 1 } });
        expect(report.versions).toHaveLength(2);
        expect(report.events).toHaveLength(4);
    });

    it('says plainly when nobody has decided anything yet', () => {
        expect(trailOf(addPost([], post())[0]!)).toMatchObject({ status: 'waiting', lastVerdict: null });
    });
});

describe('the link from a notification or a question goes straight to the item', () => {
    it('opens the workspace on the ArtBoard tab, focused on the item', () => {
        const route = artboardItemRoute('work', 'login-screen');
        expect(parseRoute(route)).toMatchObject({ surface: 'workspace', workspaceId: 'work', view: 'artboard', artboardItem: 'login-screen' });
    });
});
