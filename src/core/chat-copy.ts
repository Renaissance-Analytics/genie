import { renderMarkdown } from '@particle-academy/react-fancy';

/**
 * WHAT A CHAT COPY BUTTON PUTS ON THE CLIPBOARD (genie#1263).
 *
 * moic's rule, the reason its copy buttons exist (MOIC-Partners/suite `ChatRenderService.php` resultsCopyButtonHtml):
 * copy what the person SEES, never the Markdown source — "writing only the plain text is how a drafted email arrives as a
 * wall of unformatted prose, and writing the markdown SOURCE is how it arrives full of asterisks". So:
 *
 * - a code block copies its code, as written;
 * - a table copies as TSV, each cell its rendered text — a spreadsheet pastes it as a grid;
 * - a `<result>` copies RICH: one clipboard item holding `text/html` (the rendered semantic HTML, so headings, bold and
 *   lists survive a paste into Outlook, Word or Gmail) and `text/plain` beside it, falling back to `writeText`.
 *
 * Every payload is a pure function of the reply's text. The HTML is react-fancy's own `renderMarkdown` — the same parser
 * the chat draws with, sanitised by its default blocklist in the app (a no-op in Node, where these are tested).
 */

/** How long the copy button shows its check (genie#1263: "Icon swaps to a check for 2 s"). */
export const COPIED_MS = 2000;

export interface CopyPayload {
    readonly plain: string;
    readonly html?: string | undefined;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decode(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, e: string) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : all;
        }
        return ENTITIES[e.toLowerCase()] ?? all;
    });
}

const BLOCK = '\u0000';
const HOLD = '\u0001';

/**
 * Every tag removed, repeated until none is left: one pass over `<<b>script>` would leave `<script>` behind (CodeQL
 * js/incomplete-multi-character-sanitization). The result is plain text for the clipboard's `text/plain` and is never
 * used as HTML; a `<` the reader SEES (written `&lt;` in the HTML) is decoded afterwards, as `innerText` would give it.
 */
function stripTags(html: string): string {
    let out = html;
    for (let prev = ''; prev !== out;) { prev = out; out = out.replace(/<[^<>]*>/g, ''); }
    return out;
}

/** Inline HTML to text: `<br>` is a line break, every other tag goes, entities are decoded. */
function inline(html: string): string {
    return decode(stripTags(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n')));
}

/**
 * Rendered HTML as the text a person reads: one paragraph per block, `- ` and `1. ` list items, a table as TSV, code as
 * written. What `innerText` would give, without a DOM — so it is the same in a test as in the app.
 */
export function htmlToPlain(html: string): string {
    const held: string[] = [];
    const hold = (s: string) => `${BLOCK}${HOLD}${held.push(s) - 1}${HOLD}${BLOCK}`;
    const expand = (s: string) => s.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_, i: string) => held[Number(i)]!);
    let s = html;
    s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => hold(decode(stripTags(inner)).replace(/\n$/, '')));
    s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, inner: string) => {
        const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => cellText(c[1]!)));
        return hold(rows.map((r) => r.join('\t')).join('\n'));
    });
    // Lists, innermost first, so a nested list is indented under its item.
    const list = /<(ul|ol)[^>]*>((?:(?!<(?:ul|ol)[\s>])[\s\S])*?)<\/\1>/i;
    for (let m = list.exec(s); m; m = list.exec(s)) {
        const ordered = m[1]!.toLowerCase() === 'ol';
        const items = [...m[2]!.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((li, n) => {
            const lines = expand(inline(li[1]!.replace(/<\/?(?:p|div)[^>]*>/gi, '\n')).replace(new RegExp(BLOCK, 'g'), '\n')).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
            const head = ordered ? `${n + 1}. ` : '- ';
            return [head + (lines[0] ?? '').trim(), ...lines.slice(1).map((l) => `  ${l}`)].join('\n');
        });
        s = s.slice(0, m.index) + hold(items.join('\n')) + s.slice(m.index + m[0].length);
    }
    s = s.replace(/<\/?(?:p|div|h[1-6]|blockquote|hr|section|header|footer|article)\b[^>]*>/gi, BLOCK);
    s = inline(s);
    return s
        .split(BLOCK)
        .map((b) => expand(b).replace(/^\n+|\n+$/g, '').replace(/^[ \t]+$/gm, ''))
        .filter((b) => b.trim() !== '')
        .join('\n\n');
}

function cellText(html: string): string {
    return inline(html).replace(/[\t\n\r]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** A Genie link (a pill, a file) means nothing outside Genie: in a copy it is its words. */
function unwrapGenieLinks(html: string): string {
    return html.replace(/<a\b[^>]*\bhref="#(?:file|agent|workspace):[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, '$1');
}

/** One rendered table cell's text, from its Markdown. */
function renderedCell(md: string): string {
    return cellText(htmlToPlain(unwrapGenieLinks(renderMarkdown(md.replace(/\\\|/g, '|')))));
}

/** "Copy table": tab-separated, header first, each cell the text it renders as. */
export function tableTsv(rows: readonly (readonly string[])[]): string {
    return rows.map((r) => r.map(renderedCell).join('\t')).join('\n');
}

/** "Copy result": the rendered HTML and its plain text — never the Markdown source. */
export function resultCopyPayload(bodyMarkdown: string): { html: string; plain: string } {
    const html = unwrapGenieLinks(renderMarkdown(bodyMarkdown)).trim();
    return { html, plain: htmlToPlain(html) };
}

export interface ClipboardLike {
    write?: ((items: unknown[]) => Promise<void>) | undefined;
    writeText?: ((text: string) => Promise<void>) | undefined;
}
export type ClipboardItemCtor = new (data: Record<string, Blob>) => unknown;

/**
 * Put a payload on the clipboard: rich (one item, `text/html` + `text/plain`) when there is HTML and the clipboard can
 * take it; otherwise — or when that write rejects, as it does in a document without focus — `writeText` of the plain
 * text. `true` only when something reached the clipboard: "Copied" is never claimed for a copy that failed.
 */
export async function writeCopy(payload: CopyPayload, clipboard: ClipboardLike | undefined, Item: ClipboardItemCtor | undefined): Promise<boolean> {
    if (!clipboard) return false;
    if (payload.html !== undefined && Item && clipboard.write) {
        try {
            await clipboard.write([new Item({
                'text/html': new Blob([payload.html], { type: 'text/html' }),
                'text/plain': new Blob([payload.plain], { type: 'text/plain' }),
            })]);
            return true;
        } catch {
            // Fall through to plain text.
        }
    }
    if (!clipboard.writeText) return false;
    try {
        await clipboard.writeText(payload.plain);
        return true;
    } catch {
        return false;
    }
}
