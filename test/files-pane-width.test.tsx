import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE FILES PANE SIZES TO ITS CONTAINER, NOT ITS CONTENT (Tynn story #382; the owner: "the Files tab editor panel needs to
 * size to the container, not the content … it only does this on images, documents open full width").
 *
 * The panel's root `<section>` sat in the Files tab's flex ROW (`data-workspace-body="files"`) with neither `flex-1` nor a
 * width, so it was as wide as its content. A text file's CodeEditor reached the edge on its own; an image (fancy-code's
 * FileViewer, intrinsically sized) did not, and the whole column — tabs, crumb, viewer, status bar — shrank to the image.
 * The fix is the container's: the panel takes its parent's width whatever it shows. The image inside is centred and scaled
 * DOWN to fit, never up (`object-fit: scale-down`).
 */
const PNG = 'iVBORw0KGgo=';
const base: FilesPanelProps = {
    workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
    tree: [],
    state: { files: [], activity: [], unreported: [], changed: null },
    tabs: ['art/logo.png', 'docs/guide.md'],
    open: { ok: true, path: 'art/logo.png', text: '', sha: 'x', src: `data:image/png;base64,${PNG}` },
    pinned: false,
    onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
};
const image = renderToStaticMarkup(<FilesPanel {...base} />);
const doc = renderToStaticMarkup(<FilesPanel {...base} open={{ ok: true, path: 'docs/guide.md', text: '# Guide\n\nHello.\n', sha: 'y' }} />);

/** The class list of the first element whose opening tag carries `attr`, as the browser reads it (`&amp;` is `&`). */
const classesOf = (html: string, attr: string): string[] | null => {
    const at = html.indexOf(attr);
    if (at < 0) return null;
    const start = html.lastIndexOf('<', at);
    const tag = html.slice(start, html.indexOf('>', at) + 1);
    return (/class="([^"]*)"/.exec(tag)?.[1] ?? '').replace(/&amp;/g, '&').split(/\s+/).filter(Boolean);
};

describe('the Files pane takes its container’s width, whatever it shows', () => {
    it('the panel root fills its parent row: flex-1, w-full, min-w-0 — with an image open', () => {
        expect(classesOf(image, 'data-files-panel=')).toEqual(expect.arrayContaining(['flex-1', 'w-full', 'min-w-0']));
    });

    it('the open-file column is the same element with the same stretch classes for an image and a document', () => {
        const forImage = classesOf(image, 'data-file-column=');
        const forDoc = classesOf(doc, 'data-file-column=');
        expect(forImage, 'the column is marked data-file-column').not.toBeNull();
        expect(forImage).toEqual(expect.arrayContaining(['flex', 'min-w-0', 'flex-1', 'flex-col']));
        expect(forDoc).toEqual(forImage);
        // Positive control: each render really shows its own file.
        expect(image).toContain('data-react-fancy-image-viewer');
        expect(doc).not.toContain('data-react-fancy-image-viewer');
    });

    it('the image is centred and scaled down to fit, never up', () => {
        expect(classesOf(image, 'data-fancy-file-viewer=')).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'w-full', '[&_img]:object-scale-down']));
    });
});
