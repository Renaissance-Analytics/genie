import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';
import { Workspace } from '../src/renderer/components/Workspace.js';
import { ICON_NAMES } from '../src/renderer/icons.js';

/**
 * TWO DETAILS OF THE FILE PANEL PER THE BOARD (`Workspace Files.dc.html`): the popped-out bar — `external-link` ·
 * "<name> files are open in their own window." · the window's route in mono · `Bring back` — and the blind-state
 * banner over a file that changed on disk with no agent report: `eye-off` "No agent reported this change". Genie does
 * not guess the author, and it says so where the reader is looking.
 */
describe('the popped-out bar', () => {
    const ws = { id: 'tynn', name: 'tynn', path: '/w/tynn' };
    const render = (popped: boolean) =>
        renderToStaticMarkup(<Workspace view="terminals" workspace={ws} terminals={NO_TERMINALS} files={{} as never} panel="files" filesPopped={popped} onBringBackFiles={() => {}} />);

    it('names the workspace, shows the window’s route in mono, and offers Bring back', () => {
        const html = render(true);
        const bar = html.slice(html.indexOf('data-files-popped="tynn"'), html.indexOf('</div>', html.indexOf('data-files-popped="tynn"')));
        expect(bar).toContain('tynn files are open in their own window.');
        expect(bar).toMatch(/data-files-window-route=""[^>]*>genie:\/\/files\/tynn</);
        expect(bar).toContain('data-action="bring-back-files"');
        expect(bar).toContain('Bring back');
        expect(ICON_NAMES).toContain('external-link');
    });

    it('is absent while the panel is not popped out (positive control)', () => {
        expect(render(false)).not.toContain('data-files-popped');
    });
});

describe('the blind-state banner', () => {
    const base: FilesPanelProps = {
        workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
        tree: [{ id: 'src', label: 'src', type: 'folder', children: [{ id: 'src/a.ts', label: 'a.ts', type: 'file', ext: 'ts' }] }],
        state: { files: [], activity: [], unreported: ['src/a.ts'], changed: null },
        tabs: ['src/a.ts'],
        open: { ok: true, path: 'src/a.ts', text: 'one\n', sha: 'abc' },
        pinned: false,
        onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
    };

    it('over a file that changed with no agent report', () => {
        const html = renderToStaticMarkup(<FilesPanel {...base} />);
        expect(html).toMatch(/data-unreported-banner="src\/a\.ts"[^>]*>[\s\S]*?No agent reported this change/);
    });

    it('not over a file every change of which was reported (positive control)', () => {
        const html = renderToStaticMarkup(<FilesPanel {...base} state={{ ...base.state!, unreported: [] }} />);
        expect(html).not.toContain('data-unreported-banner');
    });
});
