import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';
import { FilesWindow } from '../src/renderer/components/FilesWindow.js';
import { NO_FILES } from '../src/renderer/bridge.js';

/**
 * THE PANEL'S POP-OUT AND PAUSE MARKUP (§4.3). The header carries pop-out beside pin and close; in its
 * own window the panel has neither pin nor pop-out — one control, "Dock it back". A paused agent is
 * named in the footer as ASKED to pause (Genie cannot stop a tool call mid-flight) and the tab wears
 * the mark. `FilesWindow` is the popped-out window: the panel and nothing else.
 */

const base: FilesPanelProps = {
    workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
    tree: [{ id: 'src', label: 'src', type: 'folder', children: [{ id: 'src/a.ts', label: 'a.ts', type: 'file', ext: 'ts' }] }],
    state: { files: [], activity: [], unreported: [], changed: null },
    tabs: ['src/a.ts'],
    open: { ok: true, path: 'src/a.ts', text: 'one\n', sha: 'abc' },
    pinned: false,
    onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
};
const render = (p: Partial<FilesPanelProps>) => renderToStaticMarkup(<FilesPanel {...base} {...p} />);

describe('pop-out in the header', () => {
    it('docked or inline: pin, pop-out and close; popped: Dock it back and nothing else', () => {
        const inline = render({ onPopOut: () => {} });
        expect(inline).toContain('data-action="pin-files"');
        expect(inline).toContain('data-action="pop-out-files"');
        expect(inline).toContain('data-action="close-files"');
        expect(inline).not.toContain('data-action="bring-back-files"');
        const popped = render({ popped: true });
        expect(popped).toContain('data-action="bring-back-files"');
        expect(popped).not.toContain('data-action="pin-files"');
        expect(popped).not.toContain('data-action="pop-out-files"');
        expect(popped).not.toContain('data-action="close-files"');
    });

    it('without an onPopOut there is no pop-out button — a remote window cannot pop a window on the host', () => {
        expect(render({})).not.toContain('data-action="pop-out-files"');
    });
});

describe('a paused agent', () => {
    it('is named in the footer as ASKED to pause on the file, and the tab wears the mark', () => {
        const html = render({ paused: [{ agent: 'kora', path: 'src/a.ts' }] });
        expect(html).toMatch(/data-paused="src\/a\.ts"[^>]*>[\s\S]*?kora[\s\S]*?asked to pause/);
        expect(html).toMatch(/data-file-tab="src\/a\.ts"[^>]*data-paused="true"/);
        expect(html).not.toMatch(/stopped/);
        expect(render({ paused: [] })).not.toContain('data-paused');
    });
});

describe('FilesWindow', () => {
    it('is the panel in popped mode and nothing else; an unknown workspace is said', () => {
        const html = renderToStaticMarkup(<FilesWindow workspace={{ id: 'tynn', path: '/w/tynn' }} files={NO_FILES} onBringBack={() => {}} />);
        expect(html).toContain('data-surface="files"');
        expect(html).toContain('data-files-panel="tynn"');
        expect(html).toContain('data-action="bring-back-files"');
        expect(html).not.toContain('data-rail');
        expect(html).not.toContain('data-title-bar');
        const unknown = renderToStaticMarkup(<FilesWindow workspace={null} files={NO_FILES} onBringBack={() => {}} />);
        expect(unknown).toContain('data-files-window="unknown"');
        expect(unknown).not.toContain('data-files-panel=');
    });
});
