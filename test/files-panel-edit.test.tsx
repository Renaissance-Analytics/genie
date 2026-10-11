import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * EDITING ON SCREEN (§4.3). The viewer is editable; a dirty buffer shows Save and is NEVER auto-reloaded;
 * when a save is refused because the file changed underneath, the panel offers `keep mine` / `take theirs`
 * / `merge` in place — nothing is discarded, and the tab says so. A clean buffer offers no Save.
 */

const base: FilesPanelProps = {
    workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
    tree: [{ id: 'src', label: 'src', type: 'folder', children: [{ id: 'src/a.ts', label: 'a.ts', type: 'file', ext: 'ts' }] }],
    state: { files: [], activity: [], unreported: [], changed: null },
    tabs: ['src/a.ts'],
    open: { ok: true, path: 'src/a.ts', text: 'one\n', sha: 'abc' },
    pinned: false,
    onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
    edit: { dirty: false, conflict: null, onChange: () => {}, onSave: () => {}, onKeepMine: () => {}, onTakeTheirs: () => {}, onMerge: () => {} },
};
const render = (p: Partial<FilesPanelProps>) => renderToStaticMarkup(<FilesPanel {...base} {...p} />);

describe('editing', () => {
    it('clean: no Save; dirty: Save and a dirty mark on the tab', () => {
        expect(render({})).not.toContain('data-action="save-file"');
        const dirty = render({ edit: { ...base.edit!, dirty: true } });
        expect(dirty).toContain('data-action="save-file"');
        expect(dirty).toContain('data-file-tab="src/a.ts" data-dirty="true"');
    });

    it('a conflict is offered in place with the three choices and the promise that nothing is discarded', () => {
        const html = render({ edit: { ...base.edit!, dirty: true, conflict: { path: 'src/a.ts', onDisk: 'one\nagent\n', sha: 'def' } } });
        expect(html).toContain('data-conflict="src/a.ts"');
        expect(html).toContain('data-action="keep-mine"');
        expect(html).toContain('data-action="take-theirs"');
        expect(html).toContain('data-action="merge"');
        expect(html).toMatch(/Nothing is discarded/);
        expect(html).not.toContain('data-action="save-file"');
    });

    it('without edit ops the viewer is read-only: no Save ever', () => {
        expect(render({ edit: undefined })).not.toContain('data-action="save-file"');
    });
});
