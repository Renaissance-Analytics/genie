import { describe, expect, it } from 'vitest';
import { Agent as SheetAgent } from '@particle-academy/holy-sheet';
import type { Deck } from '@particle-academy/fancy-slides';
import {
    base64ToBytes,
    bytesToBase64,
    columnLetter,
    deckFromBytes,
    deckToBytes,
    holyBytesFromWorkbook,
    workbookFromHolyBytes,
} from '../plugin-editor-models';

/**
 * Phase-2 bytes <-> editor-model round-trip fidelity (§6.2, §10.7). Uses
 * Genie-authored documents as the fixture: generate with the libs, read into the
 * editor model, edit, write, re-read — the essential content must survive.
 */

/** Every cell value present anywhere in a workbook, as strings, for set compares. */
function values(wb: ReturnType<typeof workbookFromHolyBytes>): string[] {
    const out: string[] = [];
    for (const s of wb.sheets) {
        for (const c of Object.values(s.cells)) {
            if (c && c.value !== null && c.value !== undefined) out.push(String(c.value));
        }
    }
    return out;
}

describe('base64 <-> bytes', () => {
    it('round-trips arbitrary binary', () => {
        const b = new Uint8Array([0, 1, 2, 250, 255, 127, 63]);
        expect(Array.from(base64ToBytes(bytesToBase64(b)))).toEqual(Array.from(b));
    });
});

describe('columnLetter', () => {
    it('maps 0-based indices to Excel columns', () => {
        expect(columnLetter(0)).toBe('A');
        expect(columnLetter(25)).toBe('Z');
        expect(columnLetter(26)).toBe('AA');
    });
});

describe('slides round-trip (dark-slide <-> fancy-slides Deck)', () => {
    it('preserves title + slides through write/read', () => {
        const deck: Deck = {
            id: 'd1',
            title: 'Quarterly Review',
            theme: { name: 'default' },
            slides: [
                {
                    id: 's1',
                    layout: 'title-content',
                    elements: [
                        {
                            id: 'e1',
                            type: 'text',
                            x: 0.1,
                            y: 0.1,
                            w: 0.8,
                            h: 0.2,
                            content: '# Revenue up 20%',
                            format: 'markdown',
                        },
                    ],
                },
            ],
        } as unknown as Deck;

        const reopened = deckFromBytes(deckToBytes(deck));
        expect(reopened.title).toBe('Quarterly Review');
        expect(reopened.slides.length).toBeGreaterThanOrEqual(1);
        const text = JSON.stringify(reopened.slides);
        expect(text).toContain('Revenue up 20%');
    });
});

describe('sheets round-trip (holy-sheet <-> fancy-sheets WorkbookData)', () => {
    it('reads generated .xlsx into a workbook and survives edit/save/reopen', () => {
        const schema = {
            sheets: [
                {
                    name: 'Sales',
                    columns: [{ header: 'Product' }, { header: 'Qty' }],
                    rows: [
                        ['Widget', 3],
                        ['Gadget', 5],
                    ],
                },
            ],
        };
        const bytes = SheetAgent.toBytes(schema);

        const wb = workbookFromHolyBytes(bytes);
        expect(wb.sheets.length).toBe(1);
        expect(wb.activeSheetId).toBe(wb.sheets[0].id);
        const v1 = values(wb);
        for (const expected of ['Product', 'Qty', 'Widget', 'Gadget', '3', '5']) {
            expect(v1).toContain(expected);
        }

        // Edit -> save -> reopen: values must persist across the model boundary.
        const wb2 = workbookFromHolyBytes(holyBytesFromWorkbook(wb));
        const v2 = values(wb2);
        for (const expected of ['Widget', 'Gadget', '3', '5']) {
            expect(v2).toContain(expected);
        }
    });
});
