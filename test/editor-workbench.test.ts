import { describe, expect, it } from 'vitest';
import type { ClaimingEditor } from '../src/core/plugin-editors.js';
import { EMPTY_WORKBENCH, activeText, closeTab, dirtyPaths, openTab, workbench, type Workbench } from '../src/core/editor-workbench.js';

/**
 * THE FILE PANEL'S TABS, ONE BUFFER EACH (beta.33 items 14 + 15). Genie 1's CodePanel kept a buffer PER TAB (`files[path]`),
 * so switching tabs never lost an edit. Genie 2 held ONE buffer and dropped it on every open: type in a.ts, click b.ts, and
 * the edit was gone without a word. And a plugin-claimed file (item 14) is a tab whose model lives in its editor; the panel
 * only knows its dirty flag, and remounts it (a `rev` bump) when the disk changes under a CLEAN one.
 */

const doc: ClaimingEditor = { pluginId: 'ai.genie.document', pluginName: 'Document', id: 'document', title: 'Document', extensions: ['.md'], fancyEditor: { export: 'Editor' } };
const text = (path: string, t: string, sha = `sha:${t}`) => ({ ok: true as const, path, text: t, sha });
const run = (...steps: Array<(w: Workbench) => Workbench>) => steps.reduce((w, step) => step(w), EMPTY_WORKBENCH);

describe('opening and closing tabs (Genie 1 editor-tabs, kept)', () => {
    it('open appends once and brings it to the front', () => {
        expect(openTab(['a.ts'], 'b.ts')).toEqual({ open: ['a.ts', 'b.ts'], active: 'b.ts' });
        expect(openTab(['a.ts', 'b.ts'], 'a.ts')).toEqual({ open: ['a.ts', 'b.ts'], active: 'a.ts' });
    });

    it('closing the front tab hands the front to the neighbour in its slot, or the new last; the last one leaves none', () => {
        expect(closeTab(['a', 'b', 'c'], 'b', 'b')).toEqual({ open: ['a', 'c'], active: 'c' });
        expect(closeTab(['a', 'b', 'c'], 'c', 'c')).toEqual({ open: ['a', 'b'], active: 'b' });
        expect(closeTab(['a', 'b', 'c'], 'a', 'c')).toEqual({ open: ['a', 'b'], active: 'a' });
        expect(closeTab(['a'], 'a', 'a')).toEqual({ open: [], active: null });
    });
});

describe('one buffer per tab', () => {
    it('an edit in a.ts SURVIVES opening b.ts and coming back (it used to be dropped)', () => {
        const w = run(
            (w) => workbench(w, { kind: 'open', path: 'a.ts', editor: null }),
            (w) => workbench(w, { kind: 'loaded', file: text('a.ts', 'one') }),
            (w) => workbench(w, { kind: 'edit', path: 'a.ts', text: 'one, edited' }),
            (w) => workbench(w, { kind: 'open', path: 'b.ts', editor: null }),
            (w) => workbench(w, { kind: 'loaded', file: text('b.ts', 'two') }),
            (w) => workbench(w, { kind: 'open', path: 'a.ts', editor: null }),
        );
        expect(w.active).toBe('a.ts');
        expect(activeText(w)).toEqual({ ok: true, path: 'a.ts', text: 'one, edited', sha: 'sha:one' });
        expect(dirtyPaths(w)).toEqual(['a.ts']);
    });

    it('a re-read of a DIRTY tab keeps your text (never auto-reloaded); a clean one takes the disk', () => {
        const w = run(
            (w) => workbench(w, { kind: 'open', path: 'a.ts', editor: null }),
            (w) => workbench(w, { kind: 'loaded', file: text('a.ts', 'one') }),
            (w) => workbench(w, { kind: 'edit', path: 'a.ts', text: 'mine' }),
            (w) => workbench(w, { kind: 'loaded', file: text('a.ts', 'theirs') }),
        );
        // Your text, still against the read it was BASED on — so the save meets their change as a conflict, not an overwrite.
        expect(activeText(w)).toEqual({ ok: true, path: 'a.ts', text: 'mine', sha: 'sha:one' });
        const clean = workbench(workbench(workbench(EMPTY_WORKBENCH, { kind: 'open', path: 'a.ts', editor: null }), { kind: 'loaded', file: text('a.ts', 'one') }), { kind: 'loaded', file: text('a.ts', 'two') });
        expect(activeText(clean)).toEqual(text('a.ts', 'two'));
    });

    it('typing back to what was opened is clean again; a save makes the saved text the baseline', () => {
        let w = run(
            (w) => workbench(w, { kind: 'open', path: 'a.ts', editor: null }),
            (w) => workbench(w, { kind: 'loaded', file: text('a.ts', 'one') }),
            (w) => workbench(w, { kind: 'edit', path: 'a.ts', text: 'onex' }),
            (w) => workbench(w, { kind: 'edit', path: 'a.ts', text: 'one' }),
        );
        expect(dirtyPaths(w)).toEqual([]);
        w = workbench(workbench(w, { kind: 'edit', path: 'a.ts', text: 'two' }), { kind: 'saved', path: 'a.ts', text: 'two', sha: 'sha:two' });
        expect(dirtyPaths(w)).toEqual([]);
        expect(activeText(w)).toEqual(text('a.ts', 'two'));
    });

    it('closing a tab drops its buffer, and the front moves to its neighbour', () => {
        const w = run(
            (w) => workbench(w, { kind: 'open', path: 'a.ts', editor: null }),
            (w) => workbench(w, { kind: 'loaded', file: text('a.ts', 'one') }),
            (w) => workbench(w, { kind: 'edit', path: 'a.ts', text: 'x' }),
            (w) => workbench(w, { kind: 'open', path: 'b.ts', editor: null }),
            (w) => workbench(w, { kind: 'close', path: 'b.ts' }),
        );
        expect(w.tabs).toEqual(['a.ts']);
        expect(w.active).toBe('a.ts');
        const gone = workbench(w, { kind: 'close', path: 'a.ts' });
        expect(dirtyPaths(gone)).toEqual([]);
        expect(gone.active).toBeNull();
    });
});

describe('a read that lands late', () => {
    it('after its tab was closed, opens nothing (CONTROL: an open tab takes it)', () => {
        const closed = run((w) => workbench(w, { kind: 'open', path: 'a.ts', editor: null }), (w) => workbench(w, { kind: 'close', path: 'a.ts' }), (w) => workbench(w, { kind: 'loaded', file: text('a.ts', 'one') }));
        expect(closed.texts['a.ts']).toBeUndefined();
        expect(closed.tabs).toEqual([]);
        const open = run((w) => workbench(w, { kind: 'open', path: 'a.ts', editor: null }), (w) => workbench(w, { kind: 'loaded', file: text('a.ts', 'one') }));
        expect(open.texts['a.ts']).toEqual(text('a.ts', 'one'));
    });
});

describe('plugin tabs', () => {
    it('a claimed file opens as a plugin tab — no text read, no text in front — and reports dirty through its editor', () => {
        let w = workbench(EMPTY_WORKBENCH, { kind: 'open', path: 'README.md', editor: doc });
        expect(w.plugins['README.md']).toMatchObject({ editor: { pluginId: 'ai.genie.document' }, dirty: false, rev: 0 });
        expect(activeText(w)).toBeNull();
        w = workbench(w, { kind: 'plugin-dirty', path: 'README.md', dirty: true });
        expect(dirtyPaths(w)).toEqual(['README.md']);
    });

    it('a disk change remounts a CLEAN plugin tab (rev+1) and leaves a dirty one alone; it names the clean text tabs to re-read', () => {
        let w = run(
            (w) => workbench(w, { kind: 'open', path: 'README.md', editor: doc }),
            (w) => workbench(w, { kind: 'open', path: 'NOTES.md', editor: doc }),
            (w) => workbench(w, { kind: 'plugin-dirty', path: 'NOTES.md', dirty: true }),
            (w) => workbench(w, { kind: 'open', path: 'a.ts', editor: null }),
            (w) => workbench(w, { kind: 'loaded', file: text('a.ts', 'one') }),
        );
        w = workbench(w, { kind: 'disk-changed', paths: ['README.md', 'NOTES.md', 'a.ts', 'other.ts'] });
        expect(w.plugins['README.md']!.rev).toBe(1);
        expect(w.plugins['NOTES.md']!.rev).toBe(0);
        expect(w.reread).toEqual(['a.ts']);
    });

    it('rename and delete carry every kind of tab along', () => {
        let w = run(
            (w) => workbench(w, { kind: 'open', path: 'docs/README.md', editor: doc }),
            (w) => workbench(w, { kind: 'open', path: 'docs/a.ts', editor: null }),
            (w) => workbench(w, { kind: 'loaded', file: text('docs/a.ts', 'one') }),
            (w) => workbench(w, { kind: 'edit', path: 'docs/a.ts', text: 'two' }),
        );
        w = workbench(w, { kind: 'renamed', from: 'docs', to: 'guide' });
        expect(w.tabs).toEqual(['guide/README.md', 'guide/a.ts']);
        expect(w.active).toBe('guide/a.ts');
        expect(w.plugins['guide/README.md']).toBeDefined();
        expect(activeText(w)).toMatchObject({ path: 'guide/a.ts', text: 'two' });
        w = workbench(w, { kind: 'deleted', path: 'guide' });
        expect(w.tabs).toEqual([]);
        expect(w.active).toBeNull();
    });
});

describe('a text tab claimed once the plugins are known (item 15: tabs restored before the host said which editors exist)', () => {
    it('a CLEAN text tab a plugin now claims becomes that plugin\'s tab, in place; a dirty one keeps your text', () => {
        let w = run(
            (w) => workbench(w, { kind: 'open', path: 'README.md', editor: null }),
            (w) => workbench(w, { kind: 'loaded', file: text('README.md', '# hi') }),
            (w) => workbench(w, { kind: 'open', path: 'NOTES.md', editor: null }),
            (w) => workbench(w, { kind: 'loaded', file: text('NOTES.md', 'n') }),
            (w) => workbench(w, { kind: 'edit', path: 'NOTES.md', text: 'mine' }),
        );
        w = workbench(w, { kind: 'claim', editors: [doc] });
        expect(w.tabs).toEqual(['README.md', 'NOTES.md']);
        expect(w.plugins['README.md']).toMatchObject({ editor: { pluginId: 'ai.genie.document' }, dirty: false });
        expect(w.texts['README.md']).toBeUndefined();
        expect(w.plugins['NOTES.md']).toBeUndefined();
        expect(activeText(w)).toMatchObject({ path: 'NOTES.md', text: 'mine' });
    });
});
