import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fileCrumb, statusBarFor } from '../src/core/files-panel.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE EDITOR CHROME (the board's `Workspace Files`): a crumb over the file — `api / src / Auth / Login.php` — and a
 * status bar under it — `PHP · LF · UTF-8 · you and atlas in this file`. Each part from a fact Genie holds: the path,
 * the text's line endings, the encoding it decoded, who has an edit or a read in flight on this path. No `Ln, Col`:
 * the viewer reports no cursor, and a made-up position would be a lie about where the reader is.
 */
describe('fileCrumb', () => {
    it('is the path, segment by segment', () => {
        expect(fileCrumb('api/src/Auth/Login.php')).toEqual(['api', 'src', 'Auth', 'Login.php']);
        expect(fileCrumb('README.md')).toEqual(['README.md']);
    });
});

describe('statusBarFor', () => {
    it('the language from the extension, the line ending from the text, the encoding, who is in the file', () => {
        expect(statusBarFor('api/src/Auth/Login.php', '<?php\n', [{ agent: 'atlas', verb: 'writing', path: 'api/src/Auth/Login.php' }, { agent: 'zane', verb: 'reading', path: 'other.ts' }]))
            .toEqual({ language: 'PHP', eol: 'LF', encoding: 'UTF-8', presence: 'you and atlas in this file' });
        expect(statusBarFor('a.ts', 'x\r\ny\r\n', [])).toMatchObject({ language: 'TypeScript', eol: 'CRLF', presence: 'you in this file' });
        expect(statusBarFor('notes', '', [{ agent: 'kora', verb: 'reading', path: 'notes' }, { agent: 'wren', verb: 'writing', path: 'notes' }]))
            .toMatchObject({ language: 'Plain text', eol: 'LF', presence: 'you, kora and wren in this file' });
        expect(statusBarFor('x.unknownext', 'a', []).language).toBe('UNKNOWNEXT');
    });
});

describe('in the panel', () => {
    const base: FilesPanelProps = {
        workspace: { id: 'tynn', name: 'tynn', path: '/w/tynn' },
        tree: [{ id: 'api', label: 'api', type: 'folder', children: [{ id: 'api/Login.php', label: 'Login.php', type: 'file', ext: 'php' }] }],
        state: { files: [], activity: [{ agent: 'atlas', verb: 'writing', path: 'api/Login.php' }], unreported: [], changed: null },
        tabs: ['api/Login.php'],
        open: { ok: true, path: 'api/Login.php', text: '<?php\n', sha: 'abc' },
        pinned: false,
        onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
    };

    it('draws the crumb over the file and the status bar under it', () => {
        const html = renderToStaticMarkup(<FilesPanel {...base} />);
        expect(html).toMatch(/data-file-crumb="api\/Login\.php"[^>]*>[\s\S]*?api[\s\S]*?Login\.php/);
        expect(html).toMatch(/data-file-status="api\/Login\.php"[^>]*>[\s\S]*?PHP · LF · UTF-8 · you and atlas in this file/);
        // The cursor is the EDITOR's own (fancy-code's useCodeEditor, item 15) — Genie 1's status bar showed it too.
        expect(html).toMatch(/data-file-status="api\/Login\.php"[^>]*>[\s\S]*?data-editor-cursor=""[^>]*>Ln 1, Col 1/);
    });

    it('neither without an open file (positive control)', () => {
        const html = renderToStaticMarkup(<FilesPanel {...base} open={null} tabs={[]} />);
        expect(html).not.toContain('data-file-crumb');
        expect(html).not.toContain('data-file-status');
    });
});
