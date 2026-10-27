import { describe, expect, it } from 'vitest';
import { COPIED_MS, contentCopyPayload, htmlToPlain, resultCopyPayload, writeCopy, writeThroughHost } from '../src/core/chat-copy.js';

/**
 * WHAT A COPY BUTTON PUTS ON THE CLIPBOARD (genie#1263). moic's lesson, the one its copy buttons exist to answer: copy
 * what the person SEES, never the Markdown source — "writing only the plain text is how a drafted email arrives as a wall
 * of unformatted prose, and writing the markdown SOURCE is how it arrives full of asterisks" (ChatRenderService.php
 * resultsCopyButtonHtml). Every payload is built by a pure function, tested here directly.
 */

/*
 * "Copy code" and "Copy table" are react-fancy's since 5.67.0: the code as written between the fences, a table as TSV of
 * each cell's rendered text (fancy's ContentRenderer docs, "Copy buttons"). What Genie decides is what reaches the
 * clipboard from them — through its own writer.
 */
describe('contentCopyPayload — what Genie puts on the clipboard from react-fancy’s copy buttons', () => {
    it('code copies its code as plain text, nothing else (moic: "a code block copies its code, as written")', () => {
        expect(contentCopyPayload({ kind: 'code', text: 'npm ci\nnpm test', html: '<pre><code>npm ci\nnpm test</code></pre>' })).toEqual({ plain: 'npm ci\nnpm test' });
    });

    it('a table copies as TSV, with its HTML beside it for a rich paste — a Genie link in it is its words', () => {
        const html = '<table><tr><td><a href="#agent:ag_1">atlas</a></td><td><a href="https://e.com">docs</a></td></tr></table>';
        const out = contentCopyPayload({ kind: 'table', text: 'atlas\tdocs', html });
        expect(out.plain).toBe('atlas\tdocs');
        expect(out.html).not.toContain('#agent:');
        expect(out.html).toContain('<td>atlas</td>');
        // CONTROL: a web link is still a link.
        expect(out.html).toContain('href="https://e.com"');
    });
});

describe('writeThroughHost — the copy goes through Electron’s clipboard in MAIN when Genie has one', () => {
    const payload = { html: '<p><strong>x</strong></p>', plain: 'x' };
    const silent = { write: async () => {}, writeText: async () => {} };

    it('the text and the HTML go to the host, and the page’s clipboard is not touched', async () => {
        const sent: unknown[][] = [];
        const touched: string[] = [];
        const ok = await writeThroughHost(payload, { write: async (...a) => { sent.push(a); return true; } }, { writeText: async () => { touched.push('writeText'); } }, undefined);
        expect(ok).toBe(true);
        expect(sent).toEqual([['x', '<p><strong>x</strong></p>']]);
        expect(touched).toEqual([]);
    });

    it('a plain payload sends no HTML', async () => {
        const sent: unknown[][] = [];
        await writeThroughHost({ plain: 'ls' }, { write: async (...a) => { sent.push(a); return true; } }, undefined, undefined);
        expect(sent).toEqual([['ls']]);
    });

    it('a host that says no, or throws, is a FAILED copy — never retried on a page clipboard that can fail silently', async () => {
        expect(await writeThroughHost(payload, { write: async () => false }, silent, undefined)).toBe(false);
        expect(await writeThroughHost(payload, { write: async () => { throw new Error('ipc'); } }, silent, undefined)).toBe(false);
    });

    it('with no host (a browser on another machine), the page’s clipboard is used as before', async () => {
        const texts: string[] = [];
        expect(await writeThroughHost({ plain: 'ls' }, undefined, { writeText: async (t) => { texts.push(t); } }, undefined)).toBe(true);
        expect(texts).toEqual(['ls']);
    });
});

describe('resultCopyPayload — a <result> copies as RICH text: HTML for Outlook/Word/Gmail, plain text beside it', () => {
    const body = '## Q3 summary\n\n**Signed:** Acme\n\n- one\n- two\n\n| Deal | Size |\n|---|---|\n| Acme | $40k |';

    it('the HTML is the rendered, semantic markup: heading, bold, list and table survive a paste', () => {
        const { html } = resultCopyPayload(body);
        expect(html).toMatch(/<h2[^>]*>Q3 summary<\/h2>/);
        expect(html).toContain('<strong>Signed:</strong>');
        expect((html.match(/<li>/g) ?? []).length).toBe(2);
        expect(html).toMatch(/<table>[\s\S]*<td>Acme<\/td>/);
    });

    it('NEVER the Markdown source: no asterisks, no hashes, no pipes in either flavour', () => {
        const { html, plain } = resultCopyPayload(body);
        for (const s of [html, plain]) {
            expect(s).not.toContain('**');
            expect(s).not.toContain('## ');
            expect(s).not.toContain('|---');
        }
    });

    it('the plain text reads as the card does: heading line, list items, the table as TSV', () => {
        expect(resultCopyPayload(body).plain).toBe('Q3 summary\n\nSigned: Acme\n\n- one\n- two\n\nDeal\tSize\nAcme\t$40k');
    });

    it('a Genie link (a pill) copies as its words: it means nothing in an email', () => {
        const { html, plain } = resultCopyPayload('Ask [atlas](#agent:ag_1) about [route.ts](#file:src/route.ts).');
        expect(html).not.toContain('#agent:');
        expect(html).not.toContain('#file:');
        expect(html).toContain('atlas');
        expect(plain).toBe('Ask atlas about route.ts.');
    });

    it('CONTROL: an ordinary web link stays a link in the HTML', () => {
        expect(resultCopyPayload('[docs](https://example.com)').html).toContain('href="https://example.com"');
    });
});

describe('htmlToPlain', () => {
    it('ordered lists are numbered, entities decoded, line breaks kept', () => {
        expect(htmlToPlain('<ol><li>a &amp; b</li><li>c</li></ol><p>x<br>y</p>')).toBe('1. a & b\n2. c\n\nx\ny');
    });

    it('no tag survives: a tag split around another is removed too (one pass would leave `b>` behind)', () => {
        expect(htmlToPlain('<p>a<<b></b>b>c</p>')).toBe('ac');
        expect(htmlToPlain('<pre><code><<i></i>script>x</code></pre>')).toBe('x');
    });

    it('CONTROL: a "<" the reader sees (escaped in the HTML) is kept as text', () => {
        expect(htmlToPlain('<p>3 &lt; 4 &lt;b&gt;</p>')).toBe('3 < 4 <b>');
    });
});

describe('writeCopy — rich when the clipboard can, plain when it cannot, and honest when neither works', () => {
    const payload = { html: '<p><strong>x</strong></p>', plain: 'x' };

    it('writes ONE item holding text/html AND text/plain', async () => {
        const items: Array<Record<string, Blob>> = [];
        class FakeItem { constructor(public data: Record<string, Blob>) { items.push(data); } }
        const writes: unknown[] = [];
        const ok = await writeCopy(payload, { write: async (i) => { writes.push(i); }, writeText: async () => { throw new Error('not used'); } }, FakeItem as never);
        expect(ok).toBe(true);
        expect(writes).toHaveLength(1);
        expect(Object.keys(items[0]!).sort()).toEqual(['text/html', 'text/plain']);
        expect(await items[0]!['text/html']!.text()).toBe(payload.html);
        expect(await items[0]!['text/plain']!.text()).toBe('x');
    });

    it('falls back to writeText(plain) when the rich write rejects (an unfocused document) or ClipboardItem is absent', async () => {
        const texts: string[] = [];
        const clip = { write: async () => { throw new Error('denied'); }, writeText: async (t: string) => { texts.push(t); } };
        expect(await writeCopy(payload, clip, class { constructor(_: unknown) {} } as never)).toBe(true);
        expect(await writeCopy(payload, clip, undefined)).toBe(true);
        expect(texts).toEqual(['x', 'x']);
    });

    it('plain-only payloads (code, a table) go straight to writeText', async () => {
        const texts: string[] = [];
        expect(await writeCopy({ plain: 'npm ci' }, { writeText: async (t) => { texts.push(t); } }, undefined)).toBe(true);
        expect(texts).toEqual(['npm ci']);
    });

    it('reports FALSE when nothing reached the clipboard — "Copied" is never claimed for a failed copy', async () => {
        expect(await writeCopy(payload, { writeText: async () => { throw new Error('no'); } }, undefined)).toBe(false);
        expect(await writeCopy(payload, undefined, undefined)).toBe(false);
    });

    it('the check shows for 2 s', () => {
        expect(COPIED_MS).toBe(2000);
    });
});
