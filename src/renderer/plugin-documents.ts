import { Agent as SlideAgent } from '@particle-academy/dark-slide';
import { Agent as SheetAgent } from '@particle-academy/holy-sheet';
import { Agent as DocAgent } from '@particle-academy/last-word';
import { csvToWorkbook, workbookFromRead, workbookToCSV, type CellData, type WorkbookData } from '@particle-academy/fancy-sheets';
import type { Deck } from '@particle-academy/fancy-slides';
import { pluginFileExtension, type VettedFancyEditor } from '../core/plugin-editors.js';

/**
 * THE BYTES ⇄ EDITOR MODEL SEAM of the official plugins (beta.33 item 14; Genie 1 renderer/lib/plugin-editor-models.ts and
 * main/plugins/document-convert.ts). Pure: no React, no DOM, no Electron — the round trips are tested in node.
 *
 *   .md .markdown .mdc   UTF-8 text, both ways (front matter is split off by core/front-matter.ts, upstream)
 *   .docx                last-word: read → markdown, and markdown → a .docx
 *   .xlsx .ods           holy-sheet read → fancy-sheets' workbookFromRead; saved back through holy-sheet (xlsx only)
 *   .csv                 fancy-sheets' own CSV helpers, both ways — CSV text, never xlsx bytes
 *   .pptx                dark-slide read → the fancy-slides Deck (one schema), and back
 *
 * Genie 1 wrote xlsx BYTES into a `.csv` or `.ods` (holy-sheet writes xlsx only): the first save corrupted the file. A CSV
 * now saves as CSV text, and an .ods opens READ-ONLY, saying why, until holy-sheet can write ODS (asked in the report).
 * Each module is loaded only when a plugin tab opens (PluginEditorBody imports this lazily).
 */

export type EditorKind = 'doc' | 'sheet' | 'deck';

export function editorKindOf(fancyExport: VettedFancyEditor | string): EditorKind {
    if (fancyExport === 'SheetWorkbook') return 'sheet';
    if (fancyExport === 'DeckEditor') return 'deck';
    return 'doc';
}

// --- base64 (renderer and node) ---------------------------------------------------------------------------------------

export function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return btoa(bin);
}

const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

// --- documents ----------------------------------------------------------------------------------------------------------

/** The editor's model is MARKDOWN for every document type. */
export function markdownFromBytes(path: string, bytes: Uint8Array): string {
    if (pluginFileExtension(path) === '.docx') return DocAgent.toMarkdown(DocAgent.read(bytes));
    return utf8(bytes);
}

export function bytesFromMarkdown(path: string, markdown: string): Uint8Array {
    if (pluginFileExtension(path) === '.docx') return DocAgent.toBytes(DocAgent.fromMarkdown(markdown));
    return encode(markdown);
}

// --- workbooks ----------------------------------------------------------------------------------------------------------

/** What was read, kept so a save puts back what the sheet editor does not hold (charts, row heights, print setup). */
export type WorkbookSource = { kind: 'csv' } | { kind: 'read'; schema: Record<string, unknown> };

export interface OpenedWorkbook {
    readonly workbook: WorkbookData;
    readonly source: WorkbookSource;
    /** Why this file cannot be saved here, or `null` when it can. */
    readonly readOnly: string | null;
}

const ODS_READ_ONLY = 'Genie can show .ods files but not save them yet (holy-sheet writes .xlsx only).';

export function workbookFromBytes(path: string, bytes: Uint8Array): OpenedWorkbook {
    const ext = pluginFileExtension(path);
    if (ext === '.csv') return { workbook: csvToWorkbook(utf8(bytes), sheetNameOf(path)), source: { kind: 'csv' }, readOnly: null };
    const schema = SheetAgent.read(bytes);
    return { workbook: workbookFromRead(schema), source: { kind: 'read', schema }, readOnly: ext === '.ods' ? ODS_READ_ONLY : null };
}

export function bytesFromWorkbook(path: string, workbook: WorkbookData, source: WorkbookSource): Uint8Array {
    const ext = pluginFileExtension(path);
    if (ext === '.ods') throw new Error(ODS_READ_ONLY);
    if (ext === '.csv' || source.kind === 'csv') return encode(workbookToCSV(workbook, workbook.sheets[0]?.id));
    const original = Array.isArray(source.schema.sheets) ? (source.schema.sheets as Record<string, unknown>[]) : [];
    const sheets = workbook.sheets.map((s, i) => {
        // The sheet as it was read, matched by name (a sheet can be renamed: then by position) — its extras survive the save.
        const was = original.find((o) => o.name === s.name) ?? original[i] ?? {};
        const { columns: _c, rows: _r, cells: _x, ...extras } = was;
        return {
            ...extras,
            name: s.name || `Sheet${i + 1}`,
            cells: holyCells(s.cells),
            ...(s.mergedRegions.length > 0 ? { mergedRegions: s.mergedRegions } : {}),
            ...(Object.keys(s.columnWidths).length > 0 ? { columnWidths: s.columnWidths } : {}),
            ...(s.frozenRows ? { frozenRows: s.frozenRows } : {}),
            ...(s.frozenCols ? { frozenCols: s.frozenCols } : {}),
        };
    });
    const { sheets: _s, ...workbookExtras } = source.schema;
    return SheetAgent.toBytes({ ...workbookExtras, sheets: sheets.length > 0 ? sheets : [{ name: 'Sheet1', cells: {} }] });
}

/** fancy-sheets cells → holy-sheet cells. The two share one cell model (value, formula, format, comment); `meta` is ours. */
function holyCells(cells: Record<string, CellData>): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [address, c] of Object.entries(cells)) {
        const hasValue = c.value !== null && c.value !== undefined && c.value !== '';
        if (!hasValue && !c.formula && !c.format && !c.comment) continue;
        out[address] = {
            ...(hasValue ? { value: c.value } : {}),
            ...(c.formula ? { formula: c.formula } : {}),
            ...(c.computedValue !== undefined && c.computedValue !== null ? { computedValue: c.computedValue } : {}),
            ...(c.format ? { format: c.format } : {}),
            ...(c.comment ? { comment: c.comment } : {}),
        };
    }
    return out;
}

function sheetNameOf(path: string): string {
    const base = path.split(/[\\/]/).pop() ?? path;
    const dot = base.lastIndexOf('.');
    return (dot > 0 ? base.slice(0, dot) : base) || 'Sheet1';
}

// --- decks --------------------------------------------------------------------------------------------------------------

/** dark-slide's schema IS the fancy-slides Deck; only the edges are normalised (an id, a title, a theme name). */
export function deckFromBytes(bytes: Uint8Array): Deck {
    const raw = SlideAgent.read(bytes);
    const theme = typeof raw.theme === 'object' && raw.theme !== null ? (raw.theme as Record<string, unknown>) : {};
    return {
        ...raw,
        id: typeof raw.id === 'string' && raw.id ? raw.id : `deck-${Date.now()}`,
        title: typeof raw.title === 'string' ? raw.title : 'Untitled deck',
        theme: { ...theme, name: typeof theme.name === 'string' ? theme.name : 'default' },
        slides: Array.isArray(raw.slides) ? raw.slides : [],
    } as unknown as Deck;
}

export function bytesFromDeck(deck: Deck): Uint8Array {
    return SlideAgent.toBytes(deck);
}
