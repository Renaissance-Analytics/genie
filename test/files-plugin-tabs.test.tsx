import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';
import { DocumentEditor } from '../src/renderer/components/DocumentEditor.js';
import { PluginEditorBody } from '../src/renderer/components/PluginEditorBody.js';
import { NO_FILES } from '../src/renderer/bridge.js';

/**
 * A PLUGIN-CLAIMED FILE OPENS AS A PLUGIN TAB IN THE SAME PANEL (beta.33 item 14; Genie 1 CodePanel.openTab + PluginEditorBody).
 * The owner: "why am I seeing raw markdown". A `.md` opened in fancy-code's CodeEditor as source. Now the file opens
 * where it was clicked, in the claiming plugin's Fancy editor; its tab STAYS MOUNTED while another tab is in front, because
 * the editor's model (unsaved edits included) lives inside it — unmounting on a tab switch would discard them.
 */

const base: FilesPanelProps = {
    workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
    tree: [{ id: 'README.md', label: 'README.md', type: 'file', ext: 'md' }, { id: 'a.ts', label: 'a.ts', type: 'file', ext: 'ts' }],
    state: { files: [], activity: [], unreported: [], changed: null },
    tabs: ['README.md', 'a.ts'],
    open: null,
    pinned: false,
    onSelect: () => {}, onCloseTab: () => {}, onClose: () => {},
};
const render = (p: Partial<FilesPanelProps>) => renderToStaticMarkup(<FilesPanel {...base} {...p} />);
const doc = { path: 'README.md', pluginName: 'Document', node: <div data-doc-body="README.md">the WYSIWYG</div> };

describe('plugin tabs in the file panel', () => {
    it('the active plugin tab shows its plugin editor — not the code editor, not "No file open"', () => {
        const html = render({ active: 'README.md', pluginTabs: [doc] });
        expect(html).toContain('data-doc-body="README.md"');
        expect(html).not.toContain('data-fancy-code-editor');
        expect(html).not.toContain('No file open');
        // The tab says which plugin's editor holds it.
        expect(html).toMatch(/data-plugin-tab="README.md"[^>]*>[\s\S]*Document/);
    });

    it('behind a text tab, the plugin tab is still MOUNTED (hidden) so its unsaved model survives the switch', () => {
        const html = render({ active: 'a.ts', open: { ok: true, path: 'a.ts', text: 'x', sha: 's' }, pluginTabs: [doc] });
        expect(html).toContain('data-fancy-code-editor');
        expect(html).toMatch(/data-plugin-body="README.md"[^>]*hidden|hidden[^>]*data-plugin-body="README.md"/);
        expect(html).toContain('data-doc-body="README.md"');
    });

    it('CONTROL: without plugin tabs, nothing of this renders', () => {
        const html = render({ active: 'a.ts', open: { ok: true, path: 'a.ts', text: 'x', sha: 's' } });
        expect(html).not.toContain('data-plugin-body');
    });

    it('a dirty plugin tab carries the unsaved dot', () => {
        expect(render({ active: 'README.md', pluginTabs: [{ ...doc, dirty: true }] })).toMatch(/data-file-tab="README.md"[^>]*data-dirty="true"/);
    });
});

describe('the Document editor', () => {
    it('is the WYSIWYG Editor (markdown in and out), with the fm pill when the file can carry front matter', () => {
        const html = renderToStaticMarkup(<DocumentEditor value={'# Hello'} onChange={() => {}} frontMatter={'title: Hi\ntags: [a]'} onFrontMatterChange={() => {}} />);
        expect(html).toContain('data-react-fancy-editor');
        expect(html).toContain('data-fm-pill');
        expect(html).toMatch(/fm · 2 keys|fm · 2/);
    });

    it('no pill for a file type that carries none (.docx: frontMatter omitted)', () => {
        const html = renderToStaticMarkup(<DocumentEditor value={'# Hello'} onChange={() => {}} />);
        expect(html).toContain('data-react-fancy-editor');
        expect(html).not.toContain('data-fm-pill');
    });
});

describe('the plugin editor body', () => {
    it('before its bytes arrive it says what it is opening (never a blank pane)', () => {
        const html = renderToStaticMarkup(<PluginEditorBody pluginId="ai.genie.document" fancyExport="Editor" workspaceId="tynn" path="docs/README.md" files={NO_FILES} onDirtyChange={() => {}} registerSave={() => {}} />);
        expect(html).toContain('Opening README.md');
    });

    it('a component Genie does not bundle is refused in words, never mounted', () => {
        const html = renderToStaticMarkup(<PluginEditorBody pluginId="com.x" fancyExport="Evil" workspaceId="tynn" path="a.md" files={NO_FILES} onDirtyChange={() => {}} registerSave={() => {}} />);
        expect(html).toContain('not a Fancy editor Genie bundles');
    });
});
