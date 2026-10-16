import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { conflictBody, conflictHunks, takeLabel } from '../src/core/conflict-words.js';
import { conflictMessage } from '../src/core/files-popout.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE CONFLICT, AS THE BOARD DRAWS IT (`Workspace Files`, the error state): a red `git-merge` banner, the lines
 * sentence, then "Your version is kept as a draft and nothing is lost. atlas has been told the file is in conflict
 * and is paused on it.", then `Compare` (primary) · `Keep mine` · `Take atlas’s`, and `conflict · 1 hunk` in the
 * status bar. The old `merge ▾` wrote `<<<<<<<` markers into your buffer; the board has no such button. The second
 * sentence is said only when Genie really told a known agent — otherwise it would be a claim nobody made true.
 */
const doc = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('the words', () => {
    it('the body names the agent only when it was told; the take button names it only when it is known', () => {
        expect(conflictBody('atlas')).toBe('Your version is kept as a draft and nothing is lost. atlas has been told the file is in conflict and is paused on it.');
        expect(conflictBody(null)).toBe('Your version is kept as a draft and nothing is lost.');
        expect(takeLabel('atlas')).toBe('Take atlas’s');
        expect(takeLabel(null)).toBe('Take theirs');
    });

    it('counts the hunks between your buffer and the disk', () => {
        const base = doc(30);
        const one = base.replace('line 5', 'line 5 theirs');
        const two = one.replace('line 25', 'line 25 theirs');
        expect(conflictHunks(base, one)).toBe(1);
        expect(conflictHunks(base, two)).toBe(2);
        expect(conflictHunks(base, base)).toBe(0);
    });

    it('the agent is told the file is in conflict, and to leave it alone', () => {
        expect(conflictMessage('src/a.ts')).toBe('Genie: src/a.ts is in conflict — a person had unsaved edits there when you wrote it. Their version is kept as a draft. Do not write to src/a.ts until they say so; your other work can continue.');
    });
});

describe('the banner', () => {
    const base = doc(20);
    const theirs = base.split('\n').map((l, i) => (i >= 12 && i <= 15 ? `${l} changed` : l)).join('\n');
    const mine = base.split('\n').map((l, i) => (i === 12 ? `${l} mine` : l)).join('\n');
    const props = (over: { writing?: boolean; told?: string | null; comparing?: boolean } = {}): FilesPanelProps => ({
        workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
        tree: [{ id: 'src', label: 'src', type: 'folder', children: [{ id: 'src/a.ts', label: 'a.ts', type: 'file', ext: 'ts' }] }],
        state: { files: [], activity: over.writing ? [{ agent: 'atlas', verb: 'writing', path: 'src/a.ts' }] : [], unreported: [], changed: null },
        tabs: ['src/a.ts'],
        open: { ok: true, path: 'src/a.ts', text: mine, sha: 'abc' },
        pinned: false,
        onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
        edit: {
            dirty: true, conflict: { path: 'src/a.ts', onDisk: theirs, sha: 'def', baseline: base }, told: over.told ?? null, comparing: over.comparing ?? false,
            onChange: () => {}, onSave: () => {}, onKeepMine: () => {}, onTakeTheirs: () => {}, onCompare: () => {},
        },
    });

    it('draws the board: git-merge, the draft sentence with the told agent, Compare · Keep mine · Take atlas’s, no merge', () => {
        const html = renderToStaticMarkup(<FilesPanel {...props({ writing: true, told: 'atlas' })} />);
        expect(html).toMatch(/data-conflict="src\/a\.ts"[^>]*data-tone="bad"/);
        expect(html).toContain('data-conflict-icon="git-merge"');
        expect(html).toContain('Your version is kept as a draft and nothing is lost. atlas has been told the file is in conflict and is paused on it.');
        const order = ['compare', 'keep-mine', 'take-theirs'].map((a) => html.indexOf(`data-action="${a}"`));
        expect(order.every((i) => i > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(html).toMatch(/data-action="take-theirs"[^>]*>Take atlas’s</);
        expect(html).not.toContain('data-action="merge"');
        expect(html).not.toContain('&lt;&lt;&lt;&lt;&lt;&lt;&lt;');
    });

    it('says only what is true without a told agent: the draft sentence alone, Take theirs (positive control above)', () => {
        const html = renderToStaticMarkup(<FilesPanel {...props()} />);
        expect(html).toContain('Your version is kept as a draft and nothing is lost.');
        expect(html).not.toContain('has been told');
        expect(html).toMatch(/data-action="take-theirs"[^>]*>Take theirs</);
    });

    it('the status bar says conflict and the hunk count; Compare shows your buffer against the disk', () => {
        const html = renderToStaticMarkup(<FilesPanel {...props({ writing: true, told: 'atlas' })} />);
        expect(html).toMatch(/data-file-status="src\/a\.ts"[^>]*>[^<]*· conflict · 1 hunk</);
        expect(html).not.toContain('data-conflict-compare');
        const comparing = renderToStaticMarkup(<FilesPanel {...props({ writing: true, told: 'atlas', comparing: true })} />);
        expect(comparing).toContain('data-conflict-compare="src/a.ts"');
    });
});
