import { describe, expect, it } from 'vitest';
import { matchEditorForExtension, type ResolvedPluginEditor } from '../editor-routing';
import { BUNDLED_PLUGIN_SOURCES } from '../official';
import { clientEditorExtensions } from '../side';
import type { PluginManifest } from '../manifest';
import type { PluginRow } from '../../db';
import { emptyPluginGrants } from '../../db';

/**
 * Phase-2 routing (§6.1): a file whose extension an enabled plugin claims routes
 * to that plugin's editor; every other extension stays with the default code
 * editor (null). Malformed / disabled plugins contribute nothing (fail-closed).
 */

function row(id: string, namespace: string, manifest: Record<string, unknown>): PluginRow {
    return {
        id,
        namespace,
        name: id,
        version: '1.0.0',
        source_type: 'folder',
        source_url: null,
        source_ref: null,
        install_path: `/plugins/${id}`,
        marketplace_id: null,
        enabled: true,
        manifest_json: JSON.stringify(manifest),
        grants: emptyPluginGrants(),
        integrity: null,
        signature: null,
        publisher_key_id: null,
        trust: 'trusted',
        dev_approved: false,
        installed_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
    };
}

const presentation = row('ai.genie.presentation', 'presentation', {
    id: 'ai.genie.presentation',
    namespace: 'presentation',
    name: 'Presentation',
    version: '1.0.0',
    editors: [
        {
            id: 'deck',
            title: 'Slides',
            extensions: ['.pptx', '.odp'],
            fancyEditor: {
                package: '@particle-academy/fancy-slides',
                version: '>=0.1.0',
                export: 'DeckEditor',
            },
        },
    ],
});

const spreadsheet = row('ai.genie.spreadsheet', 'spreadsheet', {
    id: 'ai.genie.spreadsheet',
    namespace: 'spreadsheet',
    name: 'Spreadsheet',
    version: '1.0.0',
    editors: [
        {
            id: 'sheet',
            title: 'Sheets',
            extensions: ['.xlsx', '.csv', '.ods'],
            fancyEditor: {
                package: '@particle-academy/fancy-sheets',
                version: '>=0.1.0',
                export: 'SheetWorkbook',
            },
        },
    ],
});

describe('matchEditorForExtension', () => {
    const plugins = [presentation, spreadsheet];

    it('routes a claimed extension to the declaring plugin editor', () => {
        const r = matchEditorForExtension(plugins, 'deck.pptx') as ResolvedPluginEditor;
        expect(r).not.toBeNull();
        expect(r.pluginId).toBe('ai.genie.presentation');
        expect(r.editorId).toBe('deck');
        expect(r.fancyExport).toBe('DeckEditor');
        expect(r.fancyPackage).toBe('@particle-academy/fancy-slides');
    });

    it('routes .xlsx to the spreadsheet editor', () => {
        const r = matchEditorForExtension(plugins, 'budget.xlsx') as ResolvedPluginEditor;
        expect(r.pluginId).toBe('ai.genie.spreadsheet');
        expect(r.fancyExport).toBe('SheetWorkbook');
    });

    it('is case-insensitive on the extension', () => {
        expect(matchEditorForExtension(plugins, 'DECK.PPTX')?.editorId).toBe('deck');
    });

    it('leaves an unclaimed extension for the default code editor (null)', () => {
        expect(matchEditorForExtension(plugins, 'notes.txt')).toBeNull();
        expect(matchEditorForExtension(plugins, 'main.ts')).toBeNull();
        expect(matchEditorForExtension(plugins, 'README')).toBeNull();
    });

    it('resolves against a nested workspace-relative path', () => {
        expect(matchEditorForExtension(plugins, 'a/b/c/deck.pptx')?.editorId).toBe('deck');
    });

    it('fails closed on a malformed manifest (skips it)', () => {
        const broken: PluginRow = { ...presentation, manifest_json: '{ not json' };
        expect(matchEditorForExtension([broken], 'deck.pptx')).toBeNull();
    });
});

/**
 * `.mdc` — Cursor's rule files — are markdown carrying a YAML front-matter
 * block. They belong to the Document editor, and the fs allow-list has to agree:
 * `clientEditorExtensions` is `editors[].extensions` INTERSECT
 * `capabilities.fs.extensions`, so an extension declared in only one of the two
 * lists opens to an empty allow-list and every read/write of it fails closed.
 */
describe('the bundled Document editor claims the markdown text types', () => {
    const source = BUNDLED_PLUGIN_SOURCES.find((b) => b.id === 'ai.genie.document')!;
    const manifest = source.manifest as unknown as PluginManifest;
    const installed = [row('ai.genie.document', 'document', source.manifest)];

    it.each(['rules.mdc', '.cursor/rules/seam.mdc', 'RULES.MDC'])(
        'routes %s to the Document editor',
        (file) => {
            const r = matchEditorForExtension(installed, file) as ResolvedPluginEditor;
            expect(r).not.toBeNull();
            expect(r.pluginId).toBe('ai.genie.document');
            expect(r.editorId).toBe('document');
            expect(r.fancyExport).toBe('Editor');
        },
    );

    it('still routes .md, .markdown and .docx', () => {
        for (const f of ['notes.md', 'notes.markdown', 'report.docx']) {
            expect(matchEditorForExtension(installed, f)?.pluginId).toBe('ai.genie.document');
        }
    });

    it('grants .mdc through the fs sandbox as well as the editor claim', () => {
        expect(clientEditorExtensions(manifest, 'rules.mdc')).toContain('.mdc');
    });
});
