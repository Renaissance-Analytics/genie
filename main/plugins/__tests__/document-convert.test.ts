import { describe, expect, it, vi } from 'vitest';

/**
 * The Document plugin's bytes<->model seam: markdown -> .docx bytes (marked ->
 * docx builder) and .docx bytes -> markdown (mammoth -> turndown). The round
 * trip is the contract that matters — a document SAVED by the editor must
 * REOPEN in the editor with its structure intact (headings, emphasis, lists,
 * links, tables), because both open and save funnel through these two
 * functions. Fidelity is BASIC by design (owner-approved).
 */

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import {
    docxToMarkdown,
    markdownToDocx,
    pngDimensions,
    jpegDimensions,
} from '../document-convert';

const MD = `# Quarterly report

An **important** paragraph with *emphasis*, ~~struck~~ text, \`inline code\`,
and a [link](https://example.com/q3).

## Findings

- first finding
- second finding

1. step one
2. step two

> a quoted line

| Metric | Value |
| ------ | ----- |
| Users  | 1200  |
`;

describe('markdownToDocx', () => {
    it('produces a real OOXML zip', async () => {
        const bytes = await markdownToDocx(MD);
        // A .docx is a zip: PK\x03\x04.
        expect(bytes[0]).toBe(0x50);
        expect(bytes[1]).toBe(0x4b);
        expect(bytes.length).toBeGreaterThan(1000);
    });

    it('handles empty input without throwing', async () => {
        const bytes = await markdownToDocx('');
        expect(bytes[0]).toBe(0x50);
    });
});

describe('markdown -> docx -> markdown round trip', () => {
    it('preserves headings, emphasis, lists, links and table content', async () => {
        const bytes = await markdownToDocx(MD);
        const md = await docxToMarkdown(bytes);

        // Headings survive at their levels.
        expect(md).toMatch(/# Quarterly report/);
        expect(md).toMatch(/## Findings/);
        // Inline formatting survives.
        expect(md).toMatch(/\*\*important\*\*/);
        expect(md).toMatch(/[*_]emphasis[*_]/);
        // The link survives with its target.
        expect(md).toContain('https://example.com/q3');
        // List items survive as list items.
        expect(md).toMatch(/-\s+first finding/);
        expect(md).toMatch(/second finding/);
        expect(md).toMatch(/step one/);
        expect(md).toMatch(/step two/);
        // Table content survives (gfm table or at minimum the cell text).
        expect(md).toContain('Metric');
        expect(md).toContain('1200');
    });
});

describe('image dimension sniffing', () => {
    it('reads PNG IHDR dimensions', () => {
        // Minimal PNG header: signature + IHDR length/type + 100x50.
        const b = new Uint8Array(26);
        b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const dv = new DataView(b.buffer);
        dv.setUint32(16, 100);
        dv.setUint32(20, 50);
        expect(pngDimensions(b)).toEqual({ width: 100, height: 50 });
    });

    it('returns null for non-PNG bytes', () => {
        expect(pngDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    });

    it('reads JPEG SOF0 dimensions', () => {
        // SOI + APP0 (empty) + SOF0 with 200x120.
        const b = new Uint8Array([
            0xff, 0xd8, // SOI
            0xff, 0xe0, 0x00, 0x02, // APP0, len 2 (no payload)
            0xff, 0xc0, 0x00, 0x0b, // SOF0, len 11
            0x08, // precision
            0x00, 0x78, // height 120
            0x00, 0xc8, // width 200
            0x01, 0x00, 0x00, 0x00, // component stub
        ]);
        expect(jpegDimensions(b)).toEqual({ width: 200, height: 120 });
    });

    it('returns null for non-JPEG bytes', () => {
        expect(jpegDimensions(new Uint8Array([0, 1, 2, 3]))).toBeNull();
    });
});
