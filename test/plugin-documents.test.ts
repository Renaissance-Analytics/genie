import { Agent as DocAgent } from '@particle-academy/last-word';
import { Agent as SheetAgent } from '@particle-academy/holy-sheet';
import { describe, expect, it } from 'vitest';
import {
    base64ToBytes,
    bytesFromDeck,
    bytesFromMarkdown,
    bytesFromWorkbook,
    bytesToBase64,
    deckFromBytes,
    editorKindOf,
    markdownFromBytes,
    workbookFromBytes,
} from '../src/renderer/plugin-documents.js';

/**
 * THE BYTES ⇄ EDITOR MODEL SEAM of the official plugins (beta.33 item 14; Genie 1 renderer/lib/plugin-editor-models.ts and
 * main/plugins/document-convert.ts). Each format round-trips through the Fancy suite's own (de)serialisers: dark-slide for
 * .pptx, holy-sheet for .xlsx/.ods, fancy-sheets' CSV helpers for .csv, last-word for .docx. What Genie 1 got wrong, fixed:
 * it wrote .xlsx BYTES into a .csv or .ods file (holy-sheet writes xlsx only) — a .csv now saves as CSV text and an .ods
 * opens read-only, saying why, instead of being corrupted on the first Ctrl+S.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const cellValues = (wb: { sheets: { cells: Record<string, { value: unknown }> }[] }) => wb.sheets.flatMap((s) => Object.values(s.cells).map((c) => String(c.value)));

describe('which model an editor export holds', () => {
    it('Editor = a document, SheetWorkbook = a workbook, DeckEditor = a deck', () => {
        expect(editorKindOf('Editor')).toBe('doc');
        expect(editorKindOf('SheetWorkbook')).toBe('sheet');
        expect(editorKindOf('DeckEditor')).toBe('deck');
    });
});

describe('base64', () => {
    it('round-trips arbitrary binary', () => {
        const b = new Uint8Array([0, 1, 2, 250, 255, 127, 63]);
        expect([...base64ToBytes(bytesToBase64(b))]).toEqual([...b]);
    });
});

describe('documents', () => {
    it('markdown is the file\'s own UTF-8 text, both ways — byte for byte', () => {
        const text = '---\ntitle: x\n---\n# Héllo\n\n- a\r\n';
        expect(markdownFromBytes('notes/a.md', enc(text))).toBe(text);
        expect(dec(bytesFromMarkdown('notes/a.md', text))).toBe(text);
    });

    it('a .docx opens as its markdown and saves as a .docx that reads back the same words', () => {
        const docx = DocAgent.toBytes(DocAgent.fromMarkdown('# Quarterly review\n\nRevenue is **up**.\n'));
        const md = markdownFromBytes('r/q3.docx', docx);
        expect(md).toContain('Quarterly review');
        expect(md).toContain('Revenue is');
        const saved = bytesFromMarkdown('r/q3.docx', `${md}\nAdded line.\n`);
        // A real .docx (a zip), not markdown text written under a .docx name.
        expect([...saved.slice(0, 2)]).toEqual([0x50, 0x4b]);
        expect(DocAgent.toMarkdown(DocAgent.read(saved))).toContain('Added line.');
    });
});

describe('workbooks', () => {
    const xlsx = SheetAgent.toBytes({ sheets: [{ name: 'Sales', columns: [{ header: 'Product' }, { header: 'Qty' }], rows: [['Widget', 3], ['Gadget', 5]] }] });

    it('an .xlsx opens with its values, saves, and reopens with them; editable', () => {
        const opened = workbookFromBytes('q3.xlsx', xlsx);
        expect(opened.readOnly).toBeNull();
        expect(opened.workbook.sheets[0]!.name).toBe('Sales');
        for (const v of ['Product', 'Qty', 'Widget', 'Gadget', '3', '5']) expect(cellValues(opened.workbook)).toContain(v);
        const first = opened.workbook.sheets[0]!;
        const edited = { ...opened.workbook, sheets: [{ ...first, cells: { ...first.cells, C1: { value: 'Note' } } }] };
        const saved = bytesFromWorkbook('q3.xlsx', edited, opened.source);
        const again = workbookFromBytes('q3.xlsx', saved);
        for (const v of ['Widget', 'Gadget', '5', 'Note']) expect(cellValues(again.workbook)).toContain(v);
    });

    it('a .csv opens from its text and saves as CSV TEXT, never xlsx bytes (Genie 1 corrupted it)', () => {
        const opened = workbookFromBytes('data/people.csv', enc('name,age\nAda,36\n'));
        expect(opened.readOnly).toBeNull();
        expect(cellValues(opened.workbook)).toEqual(expect.arrayContaining(['name', 'age', 'Ada']));
        const saved = dec(bytesFromWorkbook('data/people.csv', opened.workbook, opened.source));
        expect(saved).toMatch(/^name,age\r?\nAda,36/);
    });

    it('an .ods opens READ-ONLY, saying why — holy-sheet writes .xlsx only', () => {
        // holy-sheet tells xlsx from ods by CONTENT; an .ods name over xlsx bytes still reads, and is still not writable as .ods.
        const opened = workbookFromBytes('old.ods', xlsx);
        expect(opened.readOnly).toBe('Genie can show .ods files but not save them yet (holy-sheet writes .xlsx only).');
        expect(() => bytesFromWorkbook('old.ods', opened.workbook, opened.source)).toThrow(/not save them/);
    });
});

describe('decks', () => {
    it('a .pptx opens as a deck with its title and words, and saves as a .pptx that reads back', () => {
        const deck = { id: 'd1', title: 'Quarterly Review', theme: { name: 'default' }, slides: [{ id: 's1', layout: 'title-content', elements: [{ id: 'e1', type: 'text', x: 0.1, y: 0.1, w: 0.8, h: 0.2, content: '# Revenue up 20%', format: 'markdown' }] }] };
        const opened = deckFromBytes(bytesFromDeck(deck as never));
        expect(opened.title).toBe('Quarterly Review');
        expect(JSON.stringify(opened.slides)).toContain('Revenue up 20%');
        expect(deckFromBytes(bytesFromDeck(opened)).slides.length).toBe(opened.slides.length);
    });
});
