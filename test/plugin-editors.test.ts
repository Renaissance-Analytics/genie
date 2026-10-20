import { describe, expect, it } from 'vitest';
import { parseManifest, type PluginManifest } from '../src/core/plugins.js';
import { editorBytesAccess, editorFor, pluginFileExtension, type ClaimingEditor } from '../src/core/plugin-editors.js';

/**
 * PLUGIN EDITORS (beta.33 item 14). The owner, 2026-10-20: "why am I seeing raw markdown … I STILL DO NOT SEE OUR PLUGINS
 * SUPPORTED." Measured on origin/main 476fda95: the manifest accepted `editors` (core/plugins.ts TOP_KEYS) and NOTHING read
 * it — the parser dropped it, so no file could ever be routed to a plugin's editor. Genie 1 (main/plugins/editor-routing.ts,
 * side.ts): an ENABLED plugin's `editors[]` claims extensions, the file opens in that plugin's first-party Fancy editor, an
 * unclaimed file keeps the code editor, and a malformed or disabled plugin claims nothing (fail-closed).
 */

const base = { id: 'com.example.docs', name: 'Docs', version: '1.0.0', publisher: { name: 'Example Co', keyId: 'k' } };
const docEditor = { id: 'document', title: 'Document', extensions: ['.md', '.MDC'], fancyEditor: { export: 'Editor' } };

const parsed = (raw: unknown): PluginManifest => {
    const r = parseManifest(raw);
    if (!r.ok) throw new Error(r.reason);
    return r.manifest;
};

describe('the manifest keeps `editors`', () => {
    it('a declared editor survives the parse, extensions lower-cased (it used to be accepted and dropped)', () => {
        const m = parsed({ ...base, editors: [docEditor], capabilities: { fs: { scope: 'workspace', extensions: ['.md', '.mdc'] } } });
        expect(m.editors).toEqual([{ id: 'document', title: 'Document', extensions: ['.md', '.mdc'], fancyEditor: { export: 'Editor' } }]);
        // A manifest without editors has none, never undefined.
        expect(parsed(base).editors).toEqual([]);
    });

    it('refuses an editor it cannot vouch for, naming the field: a component Genie does not bundle, no extensions, an extension without its dot, an unknown key', () => {
        expect(parseManifest({ ...base, editors: [{ ...docEditor, fancyEditor: { export: 'EvilEditor' } }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/"EvilEditor" is not a vetted Fancy editor/) });
        expect(parseManifest({ ...base, editors: [{ ...docEditor, extensions: [] }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/editor "document" must claim at least one extension/) });
        expect(parseManifest({ ...base, editors: [{ ...docEditor, extensions: ['md'] }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/extensions like "\.md"/) });
        expect(parseManifest({ ...base, editors: [{ ...docEditor, script: 'x.js' }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown key "script" in editors/) });
        expect(parseManifest({ ...base, editors: 'all' })).toMatchObject({ ok: false, reason: 'editors must be an array' });
    });
});

describe('which editor opens a file (client-side, fail-closed)', () => {
    const claims: ClaimingEditor[] = [
        { pluginId: 'ai.genie.document', pluginName: 'Document', id: 'document', title: 'Document', extensions: ['.md', '.markdown', '.mdc', '.docx'], fancyEditor: { export: 'Editor' } },
        { pluginId: 'com.example.other', pluginName: 'Other', id: 'md', title: 'Other', extensions: ['.md'], fancyEditor: { export: 'Editor' } },
        { pluginId: 'ai.genie.spreadsheet', pluginName: 'Spreadsheet', id: 'sheet', title: 'Sheets', extensions: ['.xlsx', '.csv', '.ods'], fancyEditor: { export: 'SheetWorkbook' } },
    ];

    it('a claimed extension routes to its editor, case-insensitively and at any depth; the first claim wins', () => {
        expect(editorFor(claims, 'docs/README.md')).toMatchObject({ pluginId: 'ai.genie.document', fancyEditor: { export: 'Editor' } });
        expect(editorFor(claims, 'Q3/Budget.XLSX')).toMatchObject({ pluginId: 'ai.genie.spreadsheet' });
        expect(editorFor(claims, 'C:\\w\\notes.mdc')).toMatchObject({ pluginId: 'ai.genie.document' });
    });

    it('an unclaimed file, a dotfile and a file with no extension keep the code editor (null)', () => {
        expect(editorFor(claims, 'src/app.ts')).toBeNull();
        expect(editorFor(claims, '.md')).toBeNull();
        expect(editorFor(claims, 'Makefile')).toBeNull();
        expect(editorFor([], 'README.md')).toBeNull();
    });

    it('pluginFileExtension: the last dot of the base name, lower-cased; none for a dotfile', () => {
        expect(pluginFileExtension('a/b.tar.GZ')).toBe('.gz');
        expect(pluginFileExtension('a.b/c')).toBe('');
        expect(pluginFileExtension('.env')).toBe('');
    });
});

describe('the bytes a plugin editor may read and write', () => {
    const m = parsed({ ...base, editors: [docEditor], capabilities: { fs: { scope: 'workspace', extensions: ['.md'] } } });

    it('only a type its OWN editor claims AND its fs capability declares (Genie 1 side.ts clientEditorExtensions)', () => {
        expect(editorBytesAccess(m, 'notes/a.md')).toEqual({ allowed: true });
        // Claimed by the editor but not declared in fs: refused, naming both halves.
        expect(editorBytesAccess(m, 'rules/x.mdc')).toEqual({ allowed: false, reason: 'com.example.docs does not declare fs access to .mdc files; its editor cannot read or save them' });
        // Not claimed at all.
        expect(editorBytesAccess(m, 'a.pdf')).toEqual({ allowed: false, reason: 'no editor of com.example.docs opens .pdf files' });
    });

    it('no fs capability at all: nothing, ever', () => {
        expect(editorBytesAccess(parsed({ ...base, editors: [docEditor] }), 'a.md')).toMatchObject({ allowed: false });
    });
});
