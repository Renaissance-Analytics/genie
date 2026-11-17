import { describe, expect, it } from 'vitest';
import { addPost, addReply, applyVerdict, mimeFor, resolveBoard, setPinned, type BoardPost } from '../src/core/artboard.js';

/**
 * WHAT THE PERSON SEES of an item that has a trail (Tynn #739): the latest version at the top level (so everything that read a
 * post before still reads it), every earlier version beside it for the side-by-side view, the trail, the pin, the size the
 * item was made for. Documents render too: Markdown as text, PDF as a data URL.
 */
const at = (n: number) => `2026-11-15T10:${String(n).padStart(2, '0')}:00.000Z`;
const post = (over: Partial<BoardPost> = {}): BoardPost => ({ id: 'p1', title: 'Login', kind: 'html', file: 'p1.html', createdAt: at(0), askVerdict: true, ...over });
const files: Record<string, string> = { 'p1.html': '<h1>one</h1>', 'p1.v2.html': '<h1>two</h1>', 'spec.md': '# Spec', 'spec.pdf': 'JVBERi0=' };
const deps = { readText: (f: string) => files[f] ?? null, readBase64: (f: string) => files[f] ?? null };

describe('versions on display', () => {
    it('an item with two versions shows the latest at the top and keeps both for comparison', () => {
        const board = addPost(addPost([], post()), post({ file: 'p1.v2.html', createdAt: at(5), note: 'bigger' }));
        const [shown] = resolveBoard(board, deps).posts;
        expect(shown!.html).toBe('<h1>two</h1>');
        expect(shown!.versions!.map((v) => [v.n, v.html])).toEqual([[1, '<h1>one</h1>'], [2, '<h1>two</h1>']]);
        expect(shown!.versions![1]).toMatchObject({ note: 'bigger', createdAt: at(5) });
    });

    it('an earlier version whose file is gone is listed with its failure; the item is still there', () => {
        const board = addPost(addPost([], post({ file: 'gone.html' })), post({ file: 'p1.v2.html', createdAt: at(5) }));
        const got = resolveBoard(board, deps);
        expect(got.posts).toHaveLength(1);
        expect(got.posts[0]!.versions![0]).toMatchObject({ n: 1, contentError: expect.stringMatching(/missing/i) });
        expect(got.error).toBeUndefined();
    });

    it('a one-version item carries no versions list (nothing to compare)', () => {
        expect(resolveBoard(addPost([], post()), deps).posts[0]!.versions).toBeUndefined();
    });
});

describe('the trail, the pin and the size on display', () => {
    it('carries the trail, the poster, the pin and the size the item was made for', () => {
        let board = addPost([], post({ agentName: 'atlas', width: 1280, height: 800 }));
        board = applyVerdict(board, 'p1', { verdict: 'rejected', comment: 'Bigger', at: at(1) }, 'person');
        board = addReply(board, 'p1', { text: 'Done', at: at(2), agentName: 'atlas' });
        board = setPinned(board, 'p1', true);
        expect(resolveBoard(board, deps).posts[0]).toMatchObject({
            poster: 'atlas', width: 1280, height: 800, pinned: true,
            trail: [{ type: 'verdict', verdict: 'rejected', comment: 'Bigger' }, { type: 'reply', text: 'Done' }],
        });
    });

    it('adds none of them to a plain post', () => {
        const shown = resolveBoard([post()], deps).posts[0]!;
        for (const key of ['poster', 'width', 'height', 'pinned', 'trail', 'versions']) expect(shown).not.toHaveProperty(key);
    });
});

describe('documents', () => {
    it('Markdown arrives as text to render', () => {
        expect(resolveBoard([post({ kind: 'markdown', file: 'spec.md' })], deps).posts[0]).toMatchObject({ kind: 'markdown', text: '# Spec' });
    });

    it('a PDF arrives as a data URL with the PDF mime type', () => {
        expect(resolveBoard([post({ kind: 'pdf', file: 'spec.pdf' })], deps).posts[0]).toMatchObject({ kind: 'pdf', src: 'data:application/pdf;base64,JVBERi0=' });
    });

    it('names each kind\'s mime type; an image type it does not know is none', () => {
        expect(mimeFor('markdown', 'a.md')).toBe('text/markdown');
        expect(mimeFor('pdf', 'a.pdf')).toBe('application/pdf');
        expect(mimeFor('html', 'a.html')).toBe('text/html');
        expect(mimeFor('image', 'a.png')).toBe('image/png');
        expect(mimeFor('image', 'a.exe')).toBeNull();
    });
});
