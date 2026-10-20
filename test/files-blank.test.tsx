import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesHost } from '../src/main/files-host.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE BLANK FILE PANE (owner, beta.26, 2026-10-15). An agent's Changes tab opened `.ai/plans/<name>.md` in the
 * single-file panel: the tab showed, the body was EMPTY — no crumb, no text, no error. The body was gated on the
 * WORKSPACE TREE (`tree === null ? null : …`), which single mode never draws and which, on a workspace of ~325k
 * entries, had not arrived (or had rejected, uncaught). A file the host HAD read was hidden behind a walk it did not need.
 *
 * Every assertion that something is ABSENT here rides on a positive control of the same shape in the same test.
 */

const MARK = 'SHIPLINE7F3A';
const tree: FilesPanelProps['tree'] = [{ id: 'README.md', label: 'README.md', type: 'file', ext: 'md' }];
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
/** The single-file pane the Changes tab mounts (AgentView: `single={changeOpen}`), with the file already read. */
const single = (path: string, t: FilesPanelProps['tree']) =>
    render({ single: path, tabs: [path], tree: t, open: { ok: true, path, text: `# plan\n${MARK}\n`, sha: 'sha_1' } });

describe('a file opened from the Changes tab shows its content without waiting for the workspace tree', () => {
    for (const path of ['.ai/plans/ship-line.md', 'README.md']) {
        it(`${path}: the crumb and its exact content render with the tree unread, exactly as they do with it read`, () => {
            const loaded = single(path, tree); // positive control: the gauge sees the content when the tree is there
            expect(count(loaded, `data-file-crumb="${path}"`)).toBe(1);
            const contentCount = count(loaded, MARK);
            expect(contentCount).toBeGreaterThan(0);
            const unread = single(path, null);
            expect(count(unread, `data-file-crumb="${path}"`)).toBe(1);
            expect(count(unread, 'data-fancy-code-editor')).toBe(1); // the editor itself (Tynn #840: no FileViewer wrapper for text)
            expect(count(unread, MARK)).toBe(contentCount);
        });
    }

    it('single mode, while its one file is still being read, says so — never a blank, never "pick one in the tree"', () => {
        const path = '.ai/sandbox/example/notes.md';
        const opening = render({ single: path, tabs: [path], tree: null, open: null });
        expect(count(opening, `data-file-opening="${path}"`)).toBe(1);
        // Control: once read, the opening line is gone and the content is there.
        const read = single(path, null);
        expect(count(read, 'data-file-opening')).toBe(0);
        expect(count(read, MARK)).toBeGreaterThan(0);
        // And the multi-file panel's prompt is not single mode's words, tree or no tree.
        expect(render({ single: path, tabs: [path], tree, open: null })).not.toMatch(/Pick one in the tree/);
    });

    it('a tree that could not be read says why in its place; a tree still coming shows skeletons and no error', () => {
        const failed = render({ treeError: "ENOENT: no such file or directory, scandir '/w/example.test/tmp'" });
        expect(count(failed, 'data-tree-error')).toBe(1);
        expect(failed).toContain('ENOENT: no such file or directory');
        expect(count(failed, 'data-files-skeleton')).toBe(0);
        const coming = render({});
        expect(count(coming, 'data-files-skeleton')).toBe(1);
        expect(count(coming, 'data-tree-error')).toBe(0);
    });
});

/**
 * ELIMINATION, not red-first: the host already opens a workspace-relative path under a dot-directory. This is GREEN on
 * origin/main and is here so the cause stays located — the path, the leading dot and the separators were not it.
 */
describe('the host opens a dot-directory path exactly as it opens a top-level one', () => {
    let root: string;
    let host: FilesHost;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'genie2-files-blank-'));
        await mkdir(join(root, '.ai', 'plans'), { recursive: true });
        await mkdir(join(root, '.ai', 'sandbox', 'example'), { recursive: true });
        await writeFile(join(root, '.ai', 'plans', 'ship-line.md'), `# plan\n${MARK}\n`);
        await writeFile(join(root, '.ai', 'sandbox', 'example', 'notes.md'), `notes ${MARK}\n`);
        await writeFile(join(root, 'README.md'), `# top ${MARK}\n`);
        host = new FilesHost({ workspace: (id) => (id === 'ws_example' ? { id, path: root } : null), agentsOf: () => [], eventsOf: () => [] });
    });
    afterEach(async () => {
        await host.close();
        await rm(root, { recursive: true, force: true });
    });

    it('.ai/plans, .ai/sandbox (and the backslash form) read their exact text; control: README.md', async () => {
        expect(await host.open('ws_example', 'README.md')).toMatchObject({ ok: true, path: 'README.md', text: `# top ${MARK}\n` });
        expect(await host.open('ws_example', '.ai/plans/ship-line.md')).toMatchObject({ ok: true, path: '.ai/plans/ship-line.md', text: `# plan\n${MARK}\n` });
        expect(await host.open('ws_example', '.ai\\sandbox\\example\\notes.md')).toMatchObject({ ok: true, path: '.ai/sandbox/example/notes.md', text: `notes ${MARK}\n` });
    });
});
