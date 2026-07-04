import { describe, expect, it, vi } from 'vitest';

/**
 * The Document plugin's bytes<->model seam — now a thin adapter over
 * @particle-academy/last-word's Agent (markdown -> Doc -> .docx bytes and
 * back). The round trip is the contract that matters — a document SAVED by
 * the editor must REOPEN in the editor with its structure intact (headings,
 * emphasis, lists, links, tables), because both open and save funnel through
 * these two functions.
 */

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { docxToMarkdown, markdownToDocx } from '../document-convert';

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
        expect(bytes.length).toBeGreaterThan(500);
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
