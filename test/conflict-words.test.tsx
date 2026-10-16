import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { changedLines, conflictWords, rangesOf } from '../src/core/conflict-words.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE CONFLICT BANNER'S WORDS (the board): `atlas changed lines 13–16 while you had unsaved edits to line 13`. Both
 * ranges from the kit's diff engine against the text as it was opened — never a guessed count — and the author only
 * when an agent is known to be writing the file; otherwise `The file changed on disk at …`.
 */
const doc = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('changedLines and rangesOf', () => {
    it('a replaced run, an insertion, a removal placed where it was', () => {
        const base = doc(20);
        const theirs = base.split('\n').map((l, i) => (i >= 12 && i <= 15 ? `${l} changed` : l)).join('\n');
        expect(changedLines(base, theirs)).toEqual([13, 14, 15, 16]);
        const inserted = base.split('\n').flatMap((l, i) => (i === 4 ? [l, 'NEW'] : [l])).join('\n');
        expect(changedLines(base, inserted)).toEqual([6]);
        const removed = base.split('\n').filter((_, i) => i !== 9).join('\n');
        expect(changedLines(base, removed)).toEqual([10]);
        expect(changedLines(base, base)).toEqual([]);
    });

    it('ranges: contiguous runs with an en dash, the last joined with "and"', () => {
        expect(rangesOf([13, 14, 15, 16])).toBe('13–16');
        expect(rangesOf([13])).toBe('13');
        expect(rangesOf([13, 14, 40])).toBe('13–14 and 40');
        expect(rangesOf([1, 3, 5])).toBe('1, 3 and 5');
    });
});

describe('conflictWords', () => {
    const base = doc(20);
    const theirs = base.split('\n').map((l, i) => (i >= 12 && i <= 15 ? `${l} changed` : l)).join('\n');
    const mine = base.split('\n').map((l, i) => (i === 12 ? `${l} mine` : l)).join('\n');

    it('names the agent and both sides’ lines', () => {
        expect(conflictWords(base, mine, theirs, 'atlas')).toBe('atlas changed lines 13–16 while you had unsaved edits to line 13');
    });

    it('without an agent writing the file it does not guess the author', () => {
        expect(conflictWords(base, mine, theirs, null)).toBe('The file changed on disk at lines 13–16 while you had unsaved edits to line 13');
    });
});

describe('the banner', () => {
    const base = doc(20);
    const theirs = base.split('\n').map((l, i) => (i >= 12 && i <= 15 ? `${l} changed` : l)).join('\n');
    const mine = base.split('\n').map((l, i) => (i === 12 ? `${l} mine` : l)).join('\n');
    const props = (conflict: { path: string; onDisk: string; sha: string; baseline?: string }, writing: boolean): FilesPanelProps => ({
        workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
        tree: [{ id: 'src', label: 'src', type: 'folder', children: [{ id: 'src/a.ts', label: 'a.ts', type: 'file', ext: 'ts' }] }],
        state: { files: [], activity: writing ? [{ agent: 'atlas', verb: 'writing', path: 'src/a.ts' }] : [], unreported: [], changed: null },
        tabs: ['src/a.ts'],
        open: { ok: true, path: 'src/a.ts', text: mine, sha: 'abc' },
        pinned: false,
        onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
        edit: { dirty: true, conflict, onChange: () => {}, onSave: () => {}, onKeepMine: () => {}, onTakeTheirs: () => {}, onCompare: () => {} },
    });

    it('says the board’s sentence when the baseline rides the conflict and an agent is writing the file', () => {
        const html = renderToStaticMarkup(<FilesPanel {...props({ path: 'src/a.ts', onDisk: theirs, sha: 'def', baseline: base }, true)} />);
        expect(html).toMatch(/data-conflict-words=""[^>]*>atlas changed lines 13–16 while you had unsaved edits to line 13</);
        expect(html).toContain('Your version is kept as a draft and nothing is lost.');
    });

    it('does not name an author nobody is known to be; without a baseline it keeps the plain sentence (positive controls)', () => {
        const noAuthor = renderToStaticMarkup(<FilesPanel {...props({ path: 'src/a.ts', onDisk: theirs, sha: 'def', baseline: base }, false)} />);
        expect(noAuthor).toContain('The file changed on disk at lines 13–16 while you had unsaved edits to line 13');
        const plain = renderToStaticMarkup(<FilesPanel {...props({ path: 'src/a.ts', onDisk: theirs, sha: 'def' }, true)} />);
        expect(plain).not.toContain('data-conflict-words');
        expect(plain).toContain('changed on disk while you were editing it.');
    });
});
