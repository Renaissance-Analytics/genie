import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mediaMimeOf, mediaOpen } from '../src/core/files-media.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * AN IMAGE OPENED IN FILES SHOWS THE IMAGE, EDGE TO EDGE (the owner, 2026-10-21, a screenshot of `sandbox/v31-dark.png`:
 * "artboards don't work. and they shouldn't have that stupid border. they can be seamless"). Measured: the panel handed
 * fancy-code's FileViewer the file's UTF-8 TEXT and no `src`, so the `<img>` got the bare relative path and showed a broken
 * image; and FileViewer frames media in a device FauxClient by default — the thick rounded border. Now a media tab is read
 * as BYTES and shown from a `data:` URL, with no frame and no rounded box.
 */

const PNG = 'iVBORw0KGgo=';
const base: FilesPanelProps = {
    workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
    tree: [],
    state: { files: [], activity: [], unreported: [], changed: null },
    tabs: ['sandbox/v31-dark.png'],
    open: { ok: true, path: 'sandbox/v31-dark.png', text: '', sha: 'x', src: `data:image/png;base64,${PNG}` },
    pinned: false,
    onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
};
const render = (p: Partial<FilesPanelProps> = {}) => renderToStaticMarkup(<FilesPanel {...base} {...p} />);

describe('an image tab', () => {
    it('shows the image from its bytes: the <img> gets the data: URL, never the bare path', () => {
        const html = render();
        expect(html).toContain('data-react-fancy-image-viewer');
        expect(html).toContain(`src="data:image/png;base64,${PNG}"`);
        expect(html).not.toContain('src="sandbox/v31-dark.png"');
    });

    it('is SEAMLESS: no device frame around it, and no rounded box', () => {
        const html = render();
        // CONTROL: the viewer is drawn, so "no frame" is not passing on an empty pane.
        expect(html).toContain('data-react-fancy-image-viewer');
        expect(html).not.toContain('data-react-fancy-faux-client');
        const viewer = /data-react-fancy-image-viewer=""[^>]*class="([^"]*)"/.exec(html)?.[1] ?? /class="([^"]*)"[^>]*data-react-fancy-image-viewer=""/.exec(html)?.[1];
        expect(viewer).toBeDefined();
        expect(viewer).not.toMatch(/\brounded-md\b/);
        expect(viewer).toMatch(/\bh-full\b/);
    });
});

describe('a media read', () => {
    it('becomes an open tab whose src is a data: URL typed by the file, and whose text is empty', () => {
        expect(mediaOpen({ ok: true, path: 'sandbox/v31-dark.png', base64: PNG, sha: 's1' }, 'sandbox/v31-dark.png'))
            .toEqual({ ok: true, path: 'sandbox/v31-dark.png', text: '', sha: 's1', src: `data:image/png;base64,${PNG}` });
    });

    it('types each kind so the browser can draw it (an SVG is not drawn as octet-stream)', () => {
        expect(mediaMimeOf('a/logo.svg')).toBe('image/svg+xml');
        expect(mediaMimeOf('a/photo.JPG')).toBe('image/jpeg');
        expect(mediaMimeOf('a/clip.mp4')).toBe('video/mp4');
        expect(mediaMimeOf('a/doc.pdf')).toBe('application/pdf');
        expect(mediaMimeOf('a/sound.mp3')).toBe('audio/mpeg');
    });

    it('a refused read stays a refusal, in words', () => {
        expect(mediaOpen({ ok: false, path: 'big.png', error: 'too large to open (300 MB)' }, 'big.png'))
            .toEqual({ ok: false, path: 'big.png', error: 'too large to open (300 MB)' });
    });
});
