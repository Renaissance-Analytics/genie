/**
 * The OFFICIAL (curated, Genie-maintained) plugin list for the Settings →
 * Plugins "Official" tab, plus the BUNDLED first-party plugins Genie ships.
 *
 * The signed, integrity-pinned production curation is Phase 3 (§12.3); the
 * curated remote list is EMPTY until then (owner to populate with real repos +
 * a signing authority). What Genie ships in the box are the BUNDLED plugins:
 *   - Presentation      — dark-slide .pptx generation (Phase 1).
 *   - Spreadsheet       — holy-sheet .xlsx generation (Phase 1).
 *   - Document          — .md/.docx WYSIWYG editing (react-fancy Editor);
 *                         editors-only, no MCP tools.
 *
 * hello-world is deliberately NOT bundled or otherwise installable from here —
 * owner decision: it is TEACHING material only, living in
 * `main/plugins/examples/hello-world/` + `docs/plugin-authoring.md`.
 *
 * Each bundled plugin is MATERIALISED to `<userData>/plugins/.bundled/<id>/`
 * from the embedded sources below (webpack doesn't copy `main/**` non-TS assets,
 * so embedding is how they exist on disk in both dev and packaged builds), then
 * installed via the folder path. Manifests are plain objects (JSON.stringify —
 * no escaping traps); tool modules are escaping-safe CommonJS source strings
 * (single-quoted, no backticks / `${` / backslash; newlines via fromCharCode).
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/** A curated Official plugin entry (installed from its signed repo). */
export interface OfficialPluginEntry {
    id: string;
    name: string;
    description: string;
    /** The git repo URL Genie installs from (signed/pinned in Phase 3). */
    repo: string;
}

/**
 * Curated Official plugins. EMPTY until Phase 3 wires the signed registry +
 * signing authority (do not invent URLs/names). The two first-party generation
 * plugins ship BUNDLED (below), not from a remote repo.
 */
export const OFFICIAL_PLUGINS: OfficialPluginEntry[] = [];

/** A bundled plugin's embedded sources: its manifest object + its tools module. */
export interface BundledPluginSource {
    id: string;
    name: string;
    description: string;
    /** The `genie-plugin.json` as an object (serialised on materialise). */
    manifest: Record<string, unknown>;
    /** The `tools.cjs` module source. */
    tools: string;
}

// --- Presentation (Phase 1 — dark-slide .pptx generation) --------------------

const PRESENTATION_TOOLS = `'use strict';
// Presentation plugin tools — runs in the Genie plugin worker. Generates a .pptx
// with @particle-academy/dark-slide and writes it via the capability-scoped,
// guard-resolved, extension-limited fs bridge (never a raw filesystem write).
var Agent = require('@particle-academy/dark-slide').Agent;
var NL = String.fromCharCode(10);

function slugify(s) {
    var v = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return v || 'deck';
}

function outPath(input, title) {
    var p = (typeof input.path === 'string' && input.path.trim()) ? input.path.trim() : slugify(title) + '.pptx';
    var low = p.toLowerCase();
    if (!(low.endsWith('.pptx') || low.endsWith('.odp'))) p = p + '.pptx';
    return p;
}

function textEl(id, content, x, y, w, h, style) {
    return { id: id, type: 'text', x: x, y: y, w: w, h: h, content: String(content == null ? '' : content), format: 'markdown', style: style || {} };
}

function buildSlide(raw, i) {
    var s = (raw && typeof raw === 'object') ? raw : {};
    var elements = [];
    var title = (typeof s.title === 'string') ? s.title : '';
    if (title) elements.push(textEl('s' + i + '-title', '# ' + title, 0.06, 0.07, 0.88, 0.18, { fontSize: 40, fontWeight: 700 }));
    var body = (typeof s.body === 'string') ? s.body : '';
    if (!body && Array.isArray(s.bullets)) body = s.bullets.map(function (b) { return '- ' + String(b); }).join(NL);
    if (body) elements.push(textEl('s' + i + '-body', body, 0.06, 0.30, 0.88, 0.62, { fontSize: 22 }));
    if (elements.length === 0) elements.push(textEl('s' + i + '-empty', '', 0.06, 0.30, 0.88, 0.40));
    return { id: 'slide-' + (i + 1), layout: (typeof s.layout === 'string') ? s.layout : 'title-content', elements: elements };
}

async function createDeck(args, bridge) {
    var input = (args && typeof args === 'object') ? args : {};
    var title = (typeof input.title === 'string' && input.title.trim()) ? input.title.trim() : 'Untitled deck';
    var slidesIn = Array.isArray(input.slides) ? input.slides : [];
    var deck = {
        id: 'deck-' + Date.now(),
        title: title,
        theme: { name: (typeof input.theme === 'string' && input.theme.trim()) ? input.theme.trim() : 'default' },
        slides: slidesIn.map(buildSlide)
    };
    if (deck.slides.length === 0) deck.slides.push(buildSlide({ title: title }, 0));

    var errors = Agent.validate(deck);
    if (errors && errors.length) {
        var rep = Agent.validateAndRepair(deck);
        if (!rep.ok) {
            return { isError: true, content: [{ type: 'text', text: 'Deck did not validate:' + NL + errors.map(function (e) { return '- ' + e.path + ': ' + e.hint; }).join(NL) }] };
        }
    }

    var bytes = Agent.toBytes(deck);
    var rel = outPath(input, title);
    var res = await bridge.fs.writeBytes(rel, bytes);
    return { content: [{ type: 'text', text: 'Created ' + res.relPath + ' (' + deck.slides.length + ' slide(s), ' + res.bytes + ' bytes). Open it in Genie to view.' }] };
}

module.exports = { createDeck: createDeck };
`;

const PRESENTATION_SOURCE: BundledPluginSource = {
    id: 'ai.genie.presentation',
    name: 'Presentation',
    description: 'Generate .pptx decks from a structured outline with dark-slide.',
    manifest: {
        id: 'ai.genie.presentation',
        namespace: 'presentation',
        name: 'Presentation',
        version: '0.1.0',
        description:
            'Generate .pptx decks from a structured outline with dark-slide. Phase 2 adds a fancy-slides editor and Present mode.',
        publisher: { name: 'Genie', url: 'https://github.com/Renaissance-Analytics/genie' },
        engines: { genie: '>=0.7.0' },
        entry: { tools: 'tools.cjs' },
        agent: {
            guide: 'Use presentation.createDeck when the user asks to generate a PowerPoint deck. Gather or infer a title and ordered slide outline, write only within the workspace, then report the created path.',
        },
        mcpTools: [
            {
                name: 'createDeck',
                description:
                    'Generate a .pptx slide deck from a structured outline and write it into the workspace. Provide slides (each with a title and a markdown body or bullets); optional title, theme, and a workspace-relative output path.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Deck title (used for the default filename).' },
                        theme: { type: 'string', description: 'Theme name (defaults to default).' },
                        path: { type: 'string', description: 'Workspace-relative output path; defaults to <title>.pptx.' },
                        slides: {
                            type: 'array',
                            description: 'The slides, in order.',
                            items: {
                                type: 'object',
                                properties: {
                                    title: { type: 'string' },
                                    body: { type: 'string', description: 'Markdown body.' },
                                    bullets: { type: 'array', items: { type: 'string' } },
                                    layout: { type: 'string' },
                                },
                            },
                        },
                    },
                    required: ['slides'],
                },
                run: 'tools',
                process: 'worker',
                gated: false,
            },
        ],
        editors: [
            {
                id: 'deck',
                title: 'Slides',
                extensions: ['.pptx', '.odp'],
                fancyEditor: { package: '@particle-academy/fancy-slides', version: '>=0.1.0', export: 'DeckEditor' },
                toolbarActions: [{ id: 'present', title: 'Present', icon: 'play', mode: 'fullscreen' }],
            },
        ],
        capabilities: {
            fs: { scope: 'workspace', extensions: ['.pptx', '.odp'] },
            network: { hosts: [] },
        },
    },
    tools: PRESENTATION_TOOLS,
};

// --- Spreadsheet (Phase 1 — holy-sheet .xlsx generation) ---------------------

const SPREADSHEET_TOOLS = `'use strict';
// Spreadsheet plugin tools — runs in the Genie plugin worker. Generates an .xlsx
// with @particle-academy/holy-sheet and writes it via the guarded fs bridge.
var Agent = require('@particle-academy/holy-sheet').Agent;
var NL = String.fromCharCode(10);

function slugify(s) {
    var v = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return v || 'workbook';
}

function outPath(input, title) {
    var p = (typeof input.path === 'string' && input.path.trim()) ? input.path.trim() : slugify(title) + '.xlsx';
    var low = p.toLowerCase();
    if (!(low.endsWith('.xlsx') || low.endsWith('.csv') || low.endsWith('.ods'))) p = p + '.xlsx';
    return p;
}

function normaliseSheet(raw, i) {
    var s = (raw && typeof raw === 'object') ? raw : {};
    return {
        name: (typeof s.name === 'string' && s.name.trim()) ? s.name.trim() : ('Sheet' + (i + 1)),
        columns: Array.isArray(s.columns) ? s.columns : undefined,
        rows: Array.isArray(s.rows) ? s.rows : [],
        theme: (typeof s.theme === 'string') ? s.theme : undefined,
        totals: (s.totals && typeof s.totals === 'object') ? s.totals : undefined
    };
}

async function createWorkbook(args, bridge) {
    var input = (args && typeof args === 'object') ? args : {};
    var schema;
    if (Array.isArray(input.sheets) && input.sheets.length) {
        schema = { sheets: input.sheets.map(normaliseSheet) };
    } else if (Array.isArray(input.rows)) {
        schema = Agent.fromArray(input.rows, Array.isArray(input.headers) ? input.headers : null, (typeof input.sheetName === 'string' && input.sheetName) ? input.sheetName : 'Sheet1');
    } else if (typeof input.csv === 'string') {
        schema = Agent.fromCsv(input.csv);
    } else {
        schema = { sheets: [{ name: (typeof input.sheetName === 'string' && input.sheetName) ? input.sheetName : 'Sheet1', columns: [], rows: [] }] };
    }

    var errors = Agent.validate(schema);
    if (errors && errors.length) {
        var rep = Agent.validateAndRepair(schema);
        if (rep && rep.schema) schema = rep.schema;
        var stillBad = Agent.validate(schema);
        if (stillBad && stillBad.length) {
            return { isError: true, content: [{ type: 'text', text: 'Workbook did not validate:' + NL + errors.map(function (e) { return '- ' + e.path + ': ' + e.hint; }).join(NL) }] };
        }
    }

    var bytes = Agent.toBytes(schema);
    var title = (typeof input.title === 'string' && input.title) ? input.title : 'workbook';
    var rel = outPath(input, title);
    var res = await bridge.fs.writeBytes(rel, bytes);
    var count = Array.isArray(schema.sheets) ? schema.sheets.length : 1;
    return { content: [{ type: 'text', text: 'Created ' + res.relPath + ' (' + count + ' sheet(s), ' + res.bytes + ' bytes). Open it in Genie to view.' }] };
}

module.exports = { createWorkbook: createWorkbook };
`;

const SPREADSHEET_SOURCE: BundledPluginSource = {
    id: 'ai.genie.spreadsheet',
    name: 'Spreadsheet',
    description: 'Generate .xlsx/.csv workbooks from structured data with holy-sheet.',
    manifest: {
        id: 'ai.genie.spreadsheet',
        namespace: 'spreadsheet',
        name: 'Spreadsheet',
        version: '0.1.0',
        description:
            'Generate .xlsx/.csv workbooks from structured data with holy-sheet. Phase 2 adds a fancy-sheets editor.',
        publisher: { name: 'Genie', url: 'https://github.com/Renaissance-Analytics/genie' },
        engines: { genie: '>=0.7.0' },
        entry: { tools: 'tools.cjs' },
        agent: {
            guide: 'Use spreadsheet.createWorkbook when the user asks to generate an Excel workbook from structured rows, CSV, or sheets. Write only within the workspace, then report the created path.',
        },
        mcpTools: [
            {
                name: 'createWorkbook',
                description:
                    'Generate an .xlsx workbook from structured data and write it into the workspace. Provide sheets (name + columns + rows), or a flat rows array (with optional headers), or csv text; optional title and workspace-relative output path.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: { type: 'string' },
                        path: { type: 'string', description: 'Workspace-relative output path; defaults to <title>.xlsx.' },
                        sheetName: { type: 'string' },
                        headers: { type: 'array', items: { type: 'string' } },
                        rows: {
                            type: 'array',
                            description: 'Flat rows (each an array of cell values) when not using sheets.',
                            items: { type: 'array' },
                        },
                        csv: { type: 'string', description: 'CSV text; the first row is treated as headers.' },
                        sheets: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    name: { type: 'string' },
                                    columns: { type: 'array' },
                                    rows: { type: 'array' },
                                },
                            },
                        },
                    },
                },
                run: 'tools',
                process: 'worker',
                gated: false,
            },
        ],
        editors: [
            {
                id: 'sheet',
                title: 'Sheets',
                extensions: ['.xlsx', '.csv', '.ods'],
                fancyEditor: { package: '@particle-academy/fancy-sheets', version: '>=0.1.0', export: 'SheetWorkbook' },
            },
        ],
        capabilities: {
            fs: { scope: 'workspace', extensions: ['.xlsx', '.csv', '.ods'] },
            network: { hosts: [] },
        },
    },
    tools: SPREADSHEET_TOOLS,
};

// --- Document (Markdown + Word WYSIWYG editing — editors-only) ---------------

const DOCUMENT_TOOLS = `'use strict';
// The Document plugin is EDITORS-ONLY: it claims .md/.markdown/.docx for the
// react-fancy Editor host. It registers no MCP tools.
module.exports = {};
`;

const DOCUMENT_SOURCE: BundledPluginSource = {
    id: 'ai.genie.document',
    name: 'Document',
    description: 'Edit Markdown and Word documents (.md, .docx) in a WYSIWYG editor.',
    manifest: {
        id: 'ai.genie.document',
        namespace: 'document',
        name: 'Document',
        version: '0.1.0',
        description:
            'WYSIWYG editing for Markdown (.md) and Word (.docx) files with the react-fancy Editor. Markdown round-trips exactly; .docx opens and saves with basic fidelity (headings, lists, formatting, links, tables, embedded images) — Word-only features like tracked changes do not survive a save.',
        publisher: { name: 'Genie', url: 'https://github.com/Renaissance-Analytics/genie' },
        engines: { genie: '>=0.7.0' },
        entry: { tools: 'tools.cjs' },
        mcpTools: [],
        editors: [
            {
                id: 'document',
                title: 'Document',
                extensions: ['.md', '.markdown', '.docx'],
                fancyEditor: {
                    package: '@particle-academy/react-fancy',
                    version: '>=4.9.0',
                    export: 'Editor',
                },
            },
        ],
        capabilities: {
            fs: { scope: 'workspace', extensions: ['.md', '.markdown', '.docx'] },
            network: { hosts: [] },
        },
    },
    tools: DOCUMENT_TOOLS,
};

/** Every bundled plugin Genie ships in the box. Exported for tests. */
export const BUNDLED_PLUGIN_SOURCES: BundledPluginSource[] = [
    PRESENTATION_SOURCE,
    SPREADSHEET_SOURCE,
    DOCUMENT_SOURCE,
];

/** A materialised bundled plugin as the Settings "Official" tab renders it. */
export interface BundledPlugin {
    id: string;
    name: string;
    description: string;
    /** The materialised folder path a folder-install consumes. */
    path: string;
}

/** Where a bundled plugin is materialised on disk. */
export function bundledPluginDir(id: string): string {
    const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(app.getPath('userData'), 'plugins', '.bundled', safe);
}

/** Materialise a bundled plugin's manifest + tools to disk; return its folder. */
export function materialiseBundled(id: string): BundledPlugin {
    const src = BUNDLED_PLUGIN_SOURCES.find((b) => b.id === id);
    if (!src) throw new Error(`No bundled plugin "${id}".`);
    const dir = bundledPluginDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'genie-plugin.json'), JSON.stringify(src.manifest, null, 2));
    fs.writeFileSync(path.join(dir, 'tools.cjs'), src.tools);
    return { id: src.id, name: src.name, description: src.description, path: dir };
}

/** Materialise every bundled plugin and return their install-ready summaries. */
export function listBundledPlugins(): BundledPlugin[] {
    return BUNDLED_PLUGIN_SOURCES.map((b) => materialiseBundled(b.id));
}
