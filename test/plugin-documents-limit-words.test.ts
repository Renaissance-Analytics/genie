import { ArchiveRefused, ReadLimitExceeded, UnsupportedFormatException } from '@particle-academy/holy-sheet';
import { describe, expect, it } from 'vitest';
import { workbookRefusal } from '../src/renderer/plugin-documents.js';

/*
 * THE WORDS FOR EVERY READ LIMIT (Tynn #399). holy-sheet 2.13.0's ReadLimitExceeded carries `limit`, `max` and `actual`;
 * the editor says which limit and both numbers in a sentence. The two limits a small fixture can't reach (twenty million
 * cells, twenty million shared strings) are held here, built as holy-sheet builds them. Anything it doesn't recognise is
 * left as it was thrown.
 */
describe('workbookRefusal: a refusal as a sentence', () => {
    const bytes = new Uint8Array([0x50, 0x4b]);

    it.each([
        ['maxRows', 1_048_576, 2_000_000, /a sheet has 2,000,000 rows, and the limit is 1,048,576 rows/],
        ['maxColumns', 16_384, 2_000_000_000, /a sheet has 2,000,000,000 columns, and the limit is 16,384 columns/],
        ['maxCells', 20_000_000, 20_000_001, /it has at least 20,000,001 cells, and the limit is 20,000,000 cells/],
        ['maxSharedStrings', 20_000_000, 25_000_000, /it has 25,000,000 shared strings, and the limit is 20,000,000/],
    ] as const)('%s: which limit and both numbers', (limit, max, actual, words) => {
        const text = workbookRefusal(new ReadLimitExceeded(limit, max, actual), bytes)?.message ?? '';
        expect(text).toMatch(/^This workbook is too big to open here: /);
        expect(text).toMatch(words);
        expect(text).toMatch(/\.$/);
    });

    it('a DOCTYPE in a part, and in the declaration', () => {
        expect(workbookRefusal(UnsupportedFormatException.refusedPart(), bytes)?.message).toMatch(/DOCTYPE/);
        expect(workbookRefusal(UnsupportedFormatException.refusedDeclaration(), bytes)?.message).toMatch(/DOCTYPE/);
    });

    it('anything else is not rewritten', () => {
        expect(workbookRefusal(new Error('something else'), bytes)).toBeNull();
        expect(workbookRefusal(new ArchiveRefused('archive_path'), bytes)).toBeNull();
    });
});
