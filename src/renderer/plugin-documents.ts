import { Agent as SlideAgent } from '@particle-academy/dark-slide';
import { Agent as SheetAgent, ArchiveRefused, ReadLimitExceeded, UnsupportedFormatException, type ReadLimitName } from '@particle-academy/holy-sheet';
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
    let schema: Record<string, unknown>;
    try {
        schema = SheetAgent.read(bytes);
    } catch (error) {
        throw workbookRefusal(error, bytes) ?? error;
    }
    return { workbook: workbookFromRead(schema), source: { kind: 'read', schema }, readOnly: ext === '.ods' ? ODS_READ_ONLY : null };
}

/*
 * A WORKBOOK HOLY-SHEET REFUSES, IN WORDS (Tynn #399). The editor shows what the read throws as its error line, so a
 * refusal becomes one sentence: which limit and the count. Never a blank sheet (a DOCTYPE once read as an empty one) and
 * never a library's own tag or a stack trace. Anything else is left as it was thrown (`null`).
 */
const TOO_BIG = 'This workbook is too big to open here: ';
const count = (n: number): string => Math.round(n).toLocaleString('en-US');
const mib = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MiB`;
const READ_LIMIT_WORDS: Record<ReadLimitName, (actual: number, max: number) => string> = {
    maxRows: (a, m) => `a sheet has ${count(a)} rows, and the limit is ${count(m)} rows.`,
    maxColumns: (a, m) => `a sheet has ${count(a)} columns, and the limit is ${count(m)} columns.`,
    maxCells: (a, m) => `it has at least ${count(a)} cells, and the limit is ${count(m)} cells.`,
    maxSharedStrings: (a, m) => `it has ${count(a)} shared strings, and the limit is ${count(m)}.`,
};

export function workbookRefusal(error: unknown, bytes: Uint8Array): Error | null {
    if (error instanceof ReadLimitExceeded) return new Error(TOO_BIG + READ_LIMIT_WORDS[error.limit](error.actual, error.max));
    if (error instanceof UnsupportedFormatException && /DOCTYPE/.test(error.message)) {
        return new Error('This workbook can’t be opened: one of its parts carries a DOCTYPE, which no spreadsheet has.');
    }
    if (error instanceof ArchiveRefused && error.reason === 'archive_limit') return new Error(TOO_BIG + archiveLimitWords(bytes));
    return null;
}

/** holy-sheet's archive limits (DEFAULT_ARCHIVE_LIMITS, not exported): one reason for all five, so which one is read here. */
const ARCHIVE = { maxArchiveBytes: 64 * 1024 * 1024, maxEntries: 16_384, maxPartBytes: 64 * 1024 * 1024, maxExpandedBytes: 256 * 1024 * 1024, maxCompressionRatio: 1_000 };

function archiveLimitWords(bytes: Uint8Array): string {
    if (bytes.length > ARCHIVE.maxArchiveBytes) return `the file is ${mib(bytes.length)}, and the limit is 64 MiB.`;
    const entries = zipEntries(bytes);
    if (entries === null) return 'it is over one of the size limits for a spreadsheet file.';
    if (entries.length > ARCHIVE.maxEntries) return `it has ${count(entries.length)} parts, and the limit is ${count(ARCHIVE.maxEntries)}.`;
    const big = entries.find((e) => e.size > ARCHIVE.maxPartBytes);
    if (big) return `${big.name} unpacks to ${mib(big.size)}, and the limit for one part is 64 MiB.`;
    const total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total > ARCHIVE.maxExpandedBytes) return `its parts unpack to ${mib(total)} in all, and the limit is 256 MiB.`;
    const packed = entries.find((e) => e.size > Math.max(1, e.packed) * ARCHIVE.maxCompressionRatio);
    if (packed) return `${packed.name} unpacks to ${count(packed.size / Math.max(1, packed.packed))} times its packed size, and the limit is ${count(ARCHIVE.maxCompressionRatio)} times.`;
    return 'it is over one of the size limits for a spreadsheet file.';
}

/**
 * The zip's central directory: each part's name and sizes, as recorded (nothing is unpacked). Bounded: the end record is
 * looked for in the last 64 KiB + 22 bytes, and at most 65,535 entries are read. `null` when it can't be read (or is zip64).
 */
function zipEntries(bytes: Uint8Array): { name: string; size: number; packed: number }[] | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i -= 1) {
        if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) return null;
    const total = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    if (at === 0xffffffff) return null;
    const names = new TextDecoder();
    const out: { name: string; size: number; packed: number }[] = [];
    for (let n = 0; n < total; n += 1) {
        if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;
        const packed = view.getUint32(at + 20, true);
        const size = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extra = view.getUint16(at + 30, true);
        const comment = view.getUint16(at + 32, true);
        if (packed === 0xffffffff || size === 0xffffffff || at + 46 + nameLength > bytes.length) return null;
        out.push({ name: names.decode(bytes.subarray(at + 46, at + 46 + nameLength)), size, packed });
        at += 46 + nameLength + extra + comment;
    }
    return out;
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
