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
 *
 * Their TOOLS run inside Genie (main/official-tools.ts, `run: 'official'`), under the same declared-capability guard as any
 * plugin's; their PANELS are first-party components on the vetted list (core/plugin-panels.ts): the Repository changes panel
 * and the ArtBoard (Tynn #784).
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
const BOARD_TYPES = ['.json', '.html', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
const tool = (name: string, description: string, inputSchema: Record<string, unknown>) => ({ name, description, inputSchema, run: 'official', process: 'worker', gated: false });

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
            mcpTools: [tool('createWorkbook', 'Generate an .xlsx workbook from structured data and write it into the workspace. Provide sheets (name + columns + rows), or a flat rows array (with optional headers), or csv text; optional title and a workspace-relative output path (default <title>.xlsx). Open it in Genie to edit it.', {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    path: { type: 'string', description: 'Workspace-relative output path; defaults to <title>.xlsx.' },
                    sheetName: { type: 'string' },
                    headers: { type: 'array', items: { type: 'string' } },
                    rows: { type: 'array', description: 'Flat rows (each an array of cell values) when not using sheets.', items: { type: 'array' } },
                    csv: { type: 'string', description: 'CSV text; the first row is the headers.' },
                    sheets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, columns: { type: 'array' }, rows: { type: 'array' } } } },
                },
            })],
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
            mcpTools: [tool('createDeck', 'Generate a .pptx slide deck from a structured outline and write it into the workspace. Provide slides (each with a title and a markdown body or bullets); optional title, theme and a workspace-relative output path (default <title>.pptx). Open it in Genie to edit it and Present it.', {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Deck title (also the default file name).' },
                    theme: { type: 'string', description: 'Theme name (default: default).' },
                    path: { type: 'string', description: 'Workspace-relative output path; defaults to <title>.pptx.' },
                    slides: { type: 'array', description: 'The slides, in order.', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string', description: 'Markdown body.' }, bullets: { type: 'array', items: { type: 'string' } }, layout: { type: 'string' } } } },
                },
                required: ['slides'],
            })],
            capabilities: { fs: { scope: 'workspace', extensions: DECK_TYPES }, network: { hosts: [] } },
        },
    },
    {
        description: 'The workspace repository in a panel: review the changes and their diff, stage, commit, branch, push and pull — your clicks, the real git on the host.',
        manifest: {
            id: 'ai.genie.repository',
            name: 'Repository',
            version: '2.0.0',
            publisher,
            panels: [{ id: 'changes', title: 'Repository', fancyComponent: { export: 'RepoChangesPanel' } }],
            capabilities: { network: { hosts: [] } },
        },
    },
    {
        description: 'A review surface for what agents MAKE: an agent posts a rendered mockup or an image; you approve or reject it with a comment, and the verdict goes back to that agent.',
        manifest: {
            id: 'ai.genie.artboard',
            name: 'ArtBoard',
            version: '2.0.0',
            publisher,
            mcpTools: [tool('post', 'Put something you MADE on the ArtBoard for a person to review — a rendered HTML mockup, or an image you generated. Not for plans or written proposals (those are text: send a message). Provide a title and either html (the markup) or kind "image" with imagePath (workspace-relative; it is COPIED onto the board). Pass a stable id and post again with the same id to REPLACE that card when you revise. Returns at once; the approve / reject verdict, with any comment, arrives in your AgentInbox — carry on with work that does not depend on it.', {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'What the reviewer sees on the card.' },
                    kind: { type: 'string', enum: ['html', 'image'], description: 'html (default) or image.' },
                    html: { type: 'string', description: 'For kind html: the full markup to render.' },
                    imagePath: { type: 'string', description: 'For kind image: the workspace-relative path of the image you made.' },
                    id: { type: 'string', description: 'Stable id; posting again with it REPLACES that card.' },
                    note: { type: 'string', description: 'One line on what you want looked at.' },
                },
                required: ['title'],
            })],
            panels: [{ id: 'board', title: 'ArtBoard', fancyComponent: { export: 'ArtBoardPanel' } }],
            capabilities: { fs: { scope: 'workspace', extensions: BOARD_TYPES }, network: { hosts: [] } },
        },
    },
];
