import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE FILE PANEL'S HEADER PER THE BOARD (`Workspace Files.dc.html`): 38px — `Files` · `All | Changed N` segmented
 * filter · "one per workspace" · pop-out · close (⌘B); a 264px tree. The Changed filter shows the files GROUPED BY WHO
 * changed them — `atlas · 5 files` with the agent's state dot, `you · 2 files`, `? · 1 file` for changes nobody
 * reported — in the tree's place, not as a footer afterthought. `Changed N` counts files; with none it reads `Changed`.
 */
const state = {
    files: [{ path: 'src/a.ts', agents: [{ id: 'a1', name: 'atlas' }], count: 1, inFlight: true }, { path: 'src/b.ts', agents: [{ id: 'a1', name: 'atlas' }], count: 1, inFlight: false }],
    activity: [{ agent: 'atlas', verb: 'writing' as const, path: 'src/a.ts' }],
    unreported: ['notes.md'],
    changed: [{ who: 'atlas', files: ['src/a.ts', 'src/b.ts'] }, { who: 'you', files: ['config/auth.php'] }, { who: '?', files: ['notes.md'] }],
};
const base: FilesPanelProps = {
    workspace: { id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }, tree: [], state, tabs: [], open: null, pinned: false,
    onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
};
const render = (p: Partial<FilesPanelProps> = {}) => renderToStaticMarkup(<FilesPanel {...base} {...p} />);

describe('the header', () => {
    it('is 38px with Files, the All | Changed N filter (current marked), "one per workspace", and the controls', () => {
        const html = render({ filter: 'all', onFilter: () => {} });
        expect(html).toMatch(/<header[^>]*class="[^"]*h-\[38px\]/);
        expect(html).toMatch(/data-files-filter="all"[^>]*data-current="true"/);
        expect(html).toMatch(/data-files-filter="changed"(?![^>]*data-current)[^>]*>Changed 4</);
        expect(html).toContain('one per workspace');
        expect(html).toContain('data-action="close-files"');
    });

    it('with nothing changed the chip reads `Changed`, not `Changed 0`', () => {
        const html = render({ state: { ...state, changed: null, unreported: [], files: [] }, filter: 'all', onFilter: () => {} });
        expect(html).toMatch(/data-files-filter="changed"[^>]*>Changed</);
        expect(html).not.toContain('Changed 0');
    });

    it('the tree is 264px (the board), not 220', () => {
        expect(render()).toMatch(/w-\[264px\]/);
        expect(render()).not.toMatch(/w-\[220px\]/);
    });
});

describe('the Changed filter', () => {
    it('groups files by who changed them, with a header per group naming the count, you included, ? for unattributed', () => {
        const html = render({ filter: 'changed', onFilter: () => {} });
        expect(html).toMatch(/data-changed-group="atlas"[^>]*>[^<]*(<[^>]*>[^<]*)*atlas · 2 files/);
        expect(html).toMatch(/data-changed-group="you"[^>]*>[^<]*(<[^>]*>[^<]*)*you · 1 file/);
        expect(html).toContain('data-changed-group="?"');
        expect((html.match(/data-changed-file="/g) ?? []).length).toBe(4);
        // The tree itself is not drawn in this mode; the groups stand in its place.
        expect(html).not.toContain('data-files-skeleton');
    });

    it('All mode draws the tree and no groups; the footer no longer carries a Changes ▸ fold — the chip is the door', () => {
        const html = render({ filter: 'all', onFilter: () => {} });
        expect(html).not.toContain('data-changed-group');
        expect(html).not.toContain('<details data-changes');
        // The `data-changes` marker lives on the Changed chip while there are changes (absent when quiet).
        expect(html).toMatch(/data-files-filter="changed"[^>]*data-changes/);
        expect(render({ state: { ...state, changed: null, unreported: [], files: [] }, filter: 'all', onFilter: () => {} })).not.toContain('data-changes');
    });
});
