/**
 * THE OFFICIAL PLUGINS — the ones that ship IN Genie (beta.33 item 14; Genie 1 main/plugins/official.ts BUNDLED_PLUGIN_SOURCES).
 *
 * The owner, 2026-10-20: "I STILL DO NOT SEE OUR PLUGINS SUPPORTED." Genie 1 put these in the box; Genie 2 had none, so a
 * `.md` opened as raw text and a `.xlsx` as bytes. They are trusted BY CONSTRUCTION — their manifests are compiled into the
 * signed app, never read from a folder — so the plugin host lists them without a publisher key or developer mode, and a
 * folder claiming one of these ids is refused rather than admitted in its place. Each can be disabled in Settings → Plugins,
 * which hands its file types back to the code editor.
 *
 * Plain objects, run through the SAME strict `parseManifest` as any plugin (official-plugins.test.ts proves each parses).
 *
 * Not carried from Genie 1, with the reason:
 *  - Presentation's `.odp`: dark-slide reads and writes PPTX only. Claiming `.odp` would route the file to an editor that
 *    cannot open it. Asked of dark-slide (an ODP reader) in the builder's report.
 *  - The generation tools (`presentation.createDeck`, `spreadsheet.createWorkbook`) and the Repository / ArtBoard panels
 *    land in their own change (item 14, part two); these three manifests declare editors only.
 */

export interface OfficialPlugin {
    /** One line for Settings → Plugins. */
    readonly description: string;
    /** The `genie-plugin.json` this plugin would have, as an object. */
    readonly manifest: Readonly<Record<string, unknown>>;
}

const publisher = { name: 'Genie', keyId: 'genie-official', url: 'https://github.com/Renaissance-Analytics/genie' };
const DOCUMENT_TYPES = ['.md', '.markdown', '.mdc', '.docx'];
const SHEET_TYPES = ['.xlsx', '.csv', '.ods'];
const DECK_TYPES = ['.pptx'];

export const OFFICIAL_PLUGINS: readonly OfficialPlugin[] = [
    {
        description: 'Edit Markdown, Cursor rules and Word documents (.md, .markdown, .mdc, .docx) in a WYSIWYG editor; a YAML front-matter block is edited through the fm pill, not typed into the page.',
        manifest: {
            id: 'ai.genie.document',
            name: 'Document',
            version: '2.0.0',
            publisher,
            editors: [{ id: 'document', title: 'Document', extensions: DOCUMENT_TYPES, fancyEditor: { export: 'Editor' } }],
            capabilities: { fs: { scope: 'workspace', extensions: DOCUMENT_TYPES }, network: { hosts: [] } },
        },
    },
    {
        description: 'Open and edit spreadsheets (.xlsx, .csv; .ods read-only) in a Fancy sheet editor with formulas.',
        manifest: {
            id: 'ai.genie.spreadsheet',
            name: 'Spreadsheet',
            version: '2.0.0',
            publisher,
            editors: [{ id: 'sheet', title: 'Sheets', extensions: SHEET_TYPES, fancyEditor: { export: 'SheetWorkbook' } }],
            capabilities: { fs: { scope: 'workspace', extensions: SHEET_TYPES }, network: { hosts: [] } },
        },
    },
    {
        description: 'Open and edit PowerPoint decks (.pptx) in a Fancy slide editor, and Present them full screen.',
        manifest: {
            id: 'ai.genie.presentation',
            name: 'Presentation',
            version: '2.0.0',
            publisher,
            editors: [{ id: 'deck', title: 'Slides', extensions: DECK_TYPES, fancyEditor: { export: 'DeckEditor' } }],
            capabilities: { fs: { scope: 'workspace', extensions: DECK_TYPES }, network: { hosts: [] } },
        },
    },
];
