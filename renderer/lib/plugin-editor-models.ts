/**
 * PURE model adapters for the two Phase-2 plugin editors — the bytes <-> editor
 * model seam (design §6.2 / §12.4). No React, no DOM, no Electron, so this is
 * unit-testable in the node vitest env and safe to import from the renderer host.
 *
 * Round-trips:
 *   .pptx bytes --dark-slide Agent.read--> Deck (fancy-slides model) --DeckEditor
 *   edits--> Deck --dark-slide Agent.toBytes--> .pptx bytes
 *
 *   .xlsx bytes --holy-sheet Agent.read--> HolySheet schema --adapt--> WorkbookData
 *   (fancy-sheets model) --SheetWorkbook edits--> WorkbookData --adapt--> HolySheet
 *   schema --holy-sheet Agent.toBytes--> .xlsx bytes
 *
 * dark-slide's Deck schema mirrors fancy-slides 1:1, so slides only need a cast +
 * light normalisation. holy-sheet's row/column schema differs from fancy-sheets'
 * sparse A1 cell map, so sheets get a real two-way adapter. The generation libs
 * are the isomorphic (de)serializers; the UI packages are only referenced by TYPE
 * (erased at runtime), so this module stays free of any React dependency.
 */
import { Agent as SlideAgent } from '@particle-academy/dark-slide';
import { Agent as SheetAgent } from '@particle-academy/holy-sheet';
import type { Deck } from '@particle-academy/fancy-slides';
import type { WorkbookData, SheetData, CellData } from '@particle-academy/fancy-sheets';

// --- base64 <-> bytes (renderer + node safe) ---------------------------------

/** base64 string -> bytes. Uses Buffer in node/vitest, atob in the renderer. */
export function base64ToBytes(b64: string): Uint8Array {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** bytes -> base64 string. Uses Buffer in node/vitest, btoa in the renderer. */
export function bytesToBase64(bytes: Uint8Array): string {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

// --- A1 helper (self-contained so the adapter never imports the UI package) ---

/** 0-based column index -> Excel-style column letters (0->A, 25->Z, 26->AA). */
export function columnLetter(index: number): string {
    let s = '';
    let n = index;
    do {
        s = String.fromCharCode(65 + (n % 26)) + s;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return s;
}

function addr(col0: number, row1: number): string {
    return `${columnLetter(col0)}${row1}`;
}

// --- slides (dark-slide <-> fancy-slides Deck) -------------------------------

/** Read .pptx bytes into the fancy-slides Deck model. */
export function deckFromBytes(bytes: Uint8Array): Deck {
    const raw = SlideAgent.read(bytes) as Record<string, unknown>;
    return normaliseDeck(raw);
}

/** Serialize a fancy-slides Deck model back to .pptx bytes. */
export function deckToBytes(deck: Deck): Uint8Array {
    return SlideAgent.toBytes(deck);
}

function normaliseDeck(raw: Record<string, unknown>): Deck {
    const d = raw && typeof raw === 'object' ? raw : {};
    const themeIn =
        d.theme && typeof d.theme === 'object' ? (d.theme as Record<string, unknown>) : {};
    return {
        id: typeof d.id === 'string' && d.id ? (d.id as string) : `deck-${Date.now()}`,
        title: typeof d.title === 'string' ? (d.title as string) : 'Untitled deck',
        theme: { ...themeIn, name: typeof themeIn.name === 'string' ? themeIn.name : 'default' },
        slides: Array.isArray(d.slides) ? d.slides : [],
        ...(d.metadata && typeof d.metadata === 'object' ? { metadata: d.metadata } : {}),
    } as unknown as Deck;
}

// --- sheets (holy-sheet schema <-> fancy-sheets WorkbookData) ----------------

/** Read .xlsx bytes into the fancy-sheets WorkbookData model. */
export function workbookFromHolyBytes(bytes: Uint8Array): WorkbookData {
    const schema = SheetAgent.read(bytes) as { sheets?: unknown[] };
    const sheetsIn = Array.isArray(schema.sheets) ? schema.sheets : [];
    const sheets = sheetsIn.map((s, i) => holySheetToSheetData(s as Record<string, unknown>, i));
    if (sheets.length === 0) sheets.push(emptySheetData(0));
    return { sheets, activeSheetId: sheets[0].id };
}

/** Serialize a fancy-sheets WorkbookData model back to .xlsx bytes. */
export function holyBytesFromWorkbook(wb: WorkbookData): Uint8Array {
    const sheets = (wb.sheets ?? []).map((s) => ({
        name: s.name || 'Sheet1',
        cells: sheetDataToHolyCells(s.cells ?? {}),
        ...(s.frozenRows ? { frozenRows: s.frozenRows } : {}),
        ...(s.frozenCols ? { frozenCols: s.frozenCols } : {}),
        ...(s.mergedRegions && s.mergedRegions.length ? { mergedRegions: s.mergedRegions } : {}),
    }));
    if (sheets.length === 0) sheets.push({ name: 'Sheet1', cells: {} });
    return SheetAgent.toBytes({ sheets });
}

function emptySheetData(i: number): SheetData {
    return {
        id: `sheet-${i + 1}`,
        name: `Sheet${i + 1}`,
        cells: {},
        columnWidths: {},
        mergedRegions: [],
        columnFilters: {},
        frozenRows: 0,
        frozenCols: 0,
    };
}

function holySheetToSheetData(s: Record<string, unknown>, i: number): SheetData {
    const cells: Record<string, CellData> = {};
    // Preferred: an explicit A1 cell map (highest fidelity).
    if (s.cells && typeof s.cells === 'object') {
        for (const [address, cd] of Object.entries(s.cells as Record<string, unknown>)) {
            const cell = holyCellToCell(cd);
            if (cell) cells[address] = cell;
        }
    } else {
        // Fallback: reconstruct from a header row (columns) + a 2-D rows array.
        const cols = Array.isArray(s.columns) ? (s.columns as unknown[]) : [];
        let row = 1;
        if (cols.length) {
            cols.forEach((c, ci) => {
                cells[addr(ci, row)] = { value: headerText(c) };
            });
            row = 2;
        }
        const rows = Array.isArray(s.rows) ? (s.rows as unknown[]) : [];
        for (const r of rows) {
            const arr = Array.isArray(r) ? (r as unknown[]) : [];
            arr.forEach((raw, ci) => {
                const cell = holyCellToCell(raw);
                if (cell) cells[addr(ci, row)] = cell;
            });
            row++;
        }
    }
    return {
        id: typeof s.id === 'string' && s.id ? (s.id as string) : `sheet-${i + 1}`,
        name: typeof s.name === 'string' && s.name ? (s.name as string) : `Sheet${i + 1}`,
        cells,
        columnWidths: {},
        mergedRegions: Array.isArray(s.mergedRegions)
            ? (s.mergedRegions as SheetData['mergedRegions'])
            : [],
        columnFilters: {},
        frozenRows: typeof s.frozenRows === 'number' ? (s.frozenRows as number) : 0,
        frozenCols: typeof s.frozenCols === 'number' ? (s.frozenCols as number) : 0,
    };
}

function headerText(c: unknown): string {
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object' && typeof (c as { header?: unknown }).header === 'string') {
        return (c as { header: string }).header;
    }
    return '';
}

/** One holy-sheet row cell (a primitive or a CellData object) -> fancy CellData. */
function holyCellToCell(raw: unknown): CellData | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
        return { value: raw };
    }
    if (typeof raw === 'object') {
        const o = raw as Record<string, unknown>;
        const cell: CellData = {
            value: (o.value ?? null) as CellData['value'],
        };
        if (typeof o.formula === 'string') cell.formula = o.formula;
        if (o.computedValue !== undefined) cell.computedValue = o.computedValue as CellData['computedValue'];
        return cell;
    }
    return null;
}

/** fancy-sheets A1 cell map -> holy-sheet cells map (value + formula essentials). */
function sheetDataToHolyCells(cells: Record<string, CellData>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [address, cd] of Object.entries(cells)) {
        if (!cd) continue;
        const cell: Record<string, unknown> = {};
        if (cd.value !== undefined) cell.value = cd.value;
        if (typeof cd.formula === 'string' && cd.formula) cell.formula = cd.formula;
        if (cd.computedValue !== undefined) cell.computedValue = cd.computedValue;
        // Skip cells that carry nothing (a null value with no formula is empty).
        if (cell.value === undefined && cell.formula === undefined) continue;
        out[address] = cell;
    }
    return out;
}
