import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { openOrError, reasonOf, settle } from '../src/core/files-reads.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * A FAILED READ IS SAID (§4.3: "an error renders in the tab body in words, never a blank editor"). The panel's asks go
 * over IPC and can REJECT; uncaught, the panel's state stays where it was and renders as nothing. `files-reads` settles
 * every ask into the file or the reason, and the container uses it for every open and for the tree.
 */

const MARK = 'SHIPLINE7F3A';
const base: FilesPanelProps = {
    workspace: { id: 'ws_example', name: 'example', path: '/w/example.test' },
    tree: null,
    state: { files: [], activity: [], unreported: [], changed: null },
    tabs: [],
    open: null,
    pinned: false,
    onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
};
const render = (p: Partial<FilesPanelProps>) => renderToStaticMarkup(<FilesPanel {...base} {...p} />);
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('a read that fails is said in the pane, never left blank', () => {
    it('an open whose ask REJECTS settles into an error naming the path and the reason; the pane renders it', async () => {
        const path = '.ai/plans/ship-line.md';
        const failed = await openOrError(() => Promise.reject(new Error('An object could not be cloned.')), path);
        expect(failed).toEqual({ ok: false, path, error: `Genie could not read ${path}: An object could not be cloned.` });
        const html = render({ single: path, tabs: [path], open: failed as never });
        expect(count(html, 'data-tab-error')).toBe(1);
        expect(html).toContain('An object could not be cloned.');
        // Control: a successful ask passes through untouched and renders no error.
        const ok = { ok: true as const, path, text: `${MARK}\n`, sha: 'sha_2' };
        expect(await openOrError(() => Promise.resolve(ok), path)).toBe(ok);
        const fine = render({ single: path, tabs: [path], open: ok });
        expect(count(fine, 'data-tab-error')).toBe(0);
        expect(count(fine, MARK)).toBeGreaterThan(0);
    });

    it('a reason is never empty, and settle() keeps the value or the reason', async () => {
        expect(reasonOf(new Error(''))).toBe('the read failed and gave no reason');
        expect(reasonOf('EPERM')).toBe('EPERM');
        expect(await settle(() => Promise.resolve(3))).toEqual({ ok: true, value: 3 });
        expect(await settle(() => Promise.reject(new Error('EACCES: permission denied')))).toEqual({ ok: false, error: 'EACCES: permission denied' });
    });
});
