/**
 * Markdown <-> DOCX conversion for the bundled Document plugin.
 *
 * The Document editor is react-fancy's `Editor` — a WYSIWYG whose VALUE is a
 * markdown STRING, with no docx IO of its own (nothing in the Fancy suite
 * reads/writes .docx yet — upstream ask filed on react-fancy). So the editor's
 * single model is markdown, and this module is the bytes<->model seam for the
 * .docx half, kept in MAIN behind one IPC so mammoth/docx/turndown never enter
 * the renderer bundle:
 *
 *   open:  .docx bytes --mammoth--> HTML --turndown(+gfm)--> markdown
 *   save:  markdown --marked lexer--> tokens --docx builder--> .docx bytes
 *
 * Fidelity contract (owner-approved): BASIC. Headings, paragraphs,
 * bold/italic/strikethrough, inline code + code blocks, links, nested
 * bullet/numbered lists, blockquotes, tables, horizontal rules, and inline
 * images that ride as data: URLs survive. Word-only features (tracked changes,
 * comments, exact styles) do NOT survive a round-trip.
 */
import { ipcMain } from 'electron';
import TurndownService from 'turndown';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no published types; see main/types/turndown-plugin-gfm.d.ts
import { gfm } from '@joplin/turndown-plugin-gfm';
import mammoth from 'mammoth';
import { marked, type Token, type Tokens } from 'marked';
import {
    AlignmentType,
    BorderStyle,
    Document,
    ExternalHyperlink,
    HeadingLevel,
    ImageRun,
    LevelFormat,
    Packer,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
} from 'docx';

// --- docx -> markdown ---------------------------------------------------------

/** Read .docx bytes into the editor's markdown model. */
export async function docxToMarkdown(bytes: Uint8Array): Promise<string> {
    // mammoth inlines images as data: URLs by default — they ride the markdown
    // as ![alt](data:...) and re-embed on save (see imageRun below).
    const { value: html } = await mammoth.convertToHtml({
        buffer: Buffer.from(bytes),
    });
    const td = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
    });
    td.use(gfm); // tables + strikethrough
    return td.turndown(html);
}

// --- markdown -> docx ---------------------------------------------------------

/** The numbering reference ordered lists attach to (one per document). */
const NUM_REF = 'md-ordered';

/** Serialize the editor's markdown model to .docx bytes. */
export async function markdownToDocx(md: string): Promise<Uint8Array> {
    const tokens = marked.lexer(md ?? '');
    const doc = new Document({
        numbering: {
            config: [
                {
                    reference: NUM_REF,
                    levels: [0, 1, 2, 3, 4, 5].map((level) => ({
                        level,
                        format: LevelFormat.DECIMAL,
                        text: `%${level + 1}.`,
                        alignment: AlignmentType.START,
                        style: {
                            paragraph: {
                                indent: { left: 720 * (level + 1), hanging: 360 },
                            },
                        },
                    })),
                },
            ],
        },
        sections: [{ children: blocksToDocx(tokens, 0) }],
    });
    const buf = await Packer.toBuffer(doc);
    return new Uint8Array(buf);
}

type Block = Paragraph | Table;

/** Inline style accumulated while descending strong/em/del wrappers. */
interface InlineStyle {
    bold?: boolean;
    italics?: boolean;
    strike?: boolean;
}

function blocksToDocx(tokens: Token[], quoteDepth: number): Block[] {
    const out: Block[] = [];
    for (const t of tokens) {
        switch (t.type) {
            case 'heading': {
                const h = t as Tokens.Heading;
                out.push(
                    new Paragraph({
                        heading: HEADINGS[Math.min(6, Math.max(1, h.depth)) - 1],
                        children: inlineRuns(h.tokens ?? [], {}),
                        ...quoteProps(quoteDepth),
                    }),
                );
                break;
            }
            case 'paragraph': {
                const p = t as Tokens.Paragraph;
                out.push(
                    new Paragraph({
                        children: inlineRuns(p.tokens ?? [], {}),
                        ...quoteProps(quoteDepth),
                    }),
                );
                break;
            }
            case 'list':
                out.push(...listToDocx(t as Tokens.List, 0, quoteDepth));
                break;
            case 'blockquote': {
                const q = t as Tokens.Blockquote;
                out.push(...blocksToDocx(q.tokens ?? [], quoteDepth + 1));
                break;
            }
            case 'code': {
                const c = t as Tokens.Code;
                for (const line of String(c.text ?? '').split('\n')) {
                    out.push(
                        new Paragraph({
                            children: [
                                new TextRun({ text: line, font: 'Consolas', size: 20 }),
                            ],
                            shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' },
                            ...quoteProps(quoteDepth),
                        }),
                    );
                }
                break;
            }
            case 'table':
                out.push(tableToDocx(t as Tokens.Table));
                break;
            case 'hr':
                out.push(new Paragraph({ thematicBreak: true }));
                break;
            case 'space':
                break;
            default: {
                // Raw HTML blocks and anything unmodelled degrade to their text.
                const text = 'text' in t ? String((t as { text?: unknown }).text ?? '') : '';
                if (text.trim()) {
                    out.push(
                        new Paragraph({
                            children: [new TextRun({ text })],
                            ...quoteProps(quoteDepth),
                        }),
                    );
                }
            }
        }
    }
    return out;
}

const HEADINGS = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
] as const;

/** Blockquote rendering: an indent + a grey left border per nesting level. */
function quoteProps(depth: number): Partial<ConstructorParameters<typeof Paragraph>[0] & object> {
    if (depth <= 0) return {};
    return {
        indent: { left: 360 * depth },
        border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: 'BBBBBB', space: 8 },
        },
    };
}

function listToDocx(list: Tokens.List, level: number, quoteDepth: number): Block[] {
    const out: Block[] = [];
    for (const item of list.items ?? []) {
        for (const sub of item.tokens ?? []) {
            if (sub.type === 'list') {
                out.push(...listToDocx(sub as Tokens.List, level + 1, quoteDepth));
            } else if (sub.type === 'text' || sub.type === 'paragraph') {
                const inline =
                    (sub as Tokens.Text).tokens ?? (sub as Tokens.Paragraph).tokens ?? [];
                out.push(
                    new Paragraph({
                        children: inlineRuns(inline, {}),
                        ...(list.ordered
                            ? { numbering: { reference: NUM_REF, level } }
                            : { bullet: { level } }),
                        ...quoteProps(quoteDepth),
                    }),
                );
            } else {
                out.push(...blocksToDocx([sub], quoteDepth));
            }
        }
    }
    return out;
}

function tableToDocx(t: Tokens.Table): Table {
    const headerRow = new TableRow({
        tableHeader: true,
        children: (t.header ?? []).map(
            (cell) =>
                new TableCell({
                    children: [
                        new Paragraph({ children: inlineRuns(cell.tokens ?? [], { bold: true }) }),
                    ],
                }),
        ),
    });
    const bodyRows = (t.rows ?? []).map(
        (row) =>
            new TableRow({
                children: row.map(
                    (cell) =>
                        new TableCell({
                            children: [
                                new Paragraph({ children: inlineRuns(cell.tokens ?? [], {}) }),
                            ],
                        }),
                ),
            }),
    );
    return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [headerRow, ...bodyRows],
    });
}

type InlineChild = TextRun | ImageRun | ExternalHyperlink;

function inlineRuns(tokens: Token[], style: InlineStyle): InlineChild[] {
    const out: InlineChild[] = [];
    for (const t of tokens) {
        switch (t.type) {
            case 'strong':
                out.push(...inlineRuns((t as Tokens.Strong).tokens ?? [], { ...style, bold: true }));
                break;
            case 'em':
                out.push(...inlineRuns((t as Tokens.Em).tokens ?? [], { ...style, italics: true }));
                break;
            case 'del':
                out.push(...inlineRuns((t as Tokens.Del).tokens ?? [], { ...style, strike: true }));
                break;
            case 'codespan':
                out.push(
                    new TextRun({
                        text: decodeEntities(String((t as Tokens.Codespan).text ?? '')),
                        font: 'Consolas',
                        shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' },
                        ...styleProps(style),
                    }),
                );
                break;
            case 'link': {
                const l = t as Tokens.Link;
                out.push(
                    new ExternalHyperlink({
                        link: l.href ?? '',
                        children: inlineRuns(l.tokens ?? [], style).map((r) =>
                            r instanceof TextRun ? r : r,
                        ),
                    }),
                );
                break;
            }
            case 'image': {
                const img = imageRun(t as Tokens.Image, style);
                if (img) out.push(img);
                break;
            }
            case 'br':
                out.push(new TextRun({ break: 1 }));
                break;
            case 'escape':
                out.push(new TextRun({ text: String((t as Tokens.Escape).text ?? ''), ...styleProps(style) }));
                break;
            case 'text': {
                const txt = t as Tokens.Text;
                if (txt.tokens?.length) out.push(...inlineRuns(txt.tokens, style));
                else out.push(new TextRun({ text: decodeEntities(String(txt.text ?? '')), ...styleProps(style) }));
                break;
            }
            default: {
                const text = 'text' in t ? String((t as { text?: unknown }).text ?? '') : '';
                if (text) out.push(new TextRun({ text: decodeEntities(text), ...styleProps(style) }));
            }
        }
    }
    return out;
}

function styleProps(style: InlineStyle): { bold?: boolean; italics?: boolean; strike?: boolean } {
    return {
        ...(style.bold ? { bold: true } : {}),
        ...(style.italics ? { italics: true } : {}),
        ...(style.strike ? { strike: true } : {}),
    };
}

/** marked leaves basic HTML entities in inline text — decode &amp; LAST. */
function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * An inline image. Data-URL PNG/JPEG (how a docx's own images ride through
 * mammoth) re-embeds with its real dimensions, scaled to fit the page. Any
 * other source degrades to "alt (url)" text — the plugin has no network
 * capability, so remote images are never fetched.
 */
function imageRun(img: Tokens.Image, style: InlineStyle): InlineChild | null {
    const href = String(img.href ?? '');
    const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(href);
    if (!m) {
        const label = [img.text || 'image', href ? `(${href})` : '']
            .filter(Boolean)
            .join(' ');
        return label ? new TextRun({ text: label, ...styleProps(style) }) : null;
    }
    try {
        const type = m[1].toLowerCase() === 'png' ? 'png' : 'jpg';
        const data = new Uint8Array(Buffer.from(m[2], 'base64'));
        const dims =
            (type === 'png' ? pngDimensions(data) : jpegDimensions(data)) ?? {
                width: 480,
                height: 320,
            };
        // Fit within a ~600px content width, preserving the aspect ratio.
        const MAX_W = 600;
        const scale = dims.width > MAX_W ? MAX_W / dims.width : 1;
        return new ImageRun({
            type,
            data,
            transformation: {
                width: Math.max(1, Math.round(dims.width * scale)),
                height: Math.max(1, Math.round(dims.height * scale)),
            },
        });
    } catch {
        return new TextRun({ text: img.text || 'image', ...styleProps(style) });
    }
}

/** PNG IHDR width/height (bytes 16..24 of a valid PNG). */
export function pngDimensions(b: Uint8Array): { width: number; height: number } | null {
    if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** JPEG dimensions from the first SOF0/1/2 marker. */
export function jpegDimensions(b: Uint8Array): { width: number; height: number } | null {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let i = 2;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        const len = dv.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xc2) {
            return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
        }
        i += 2 + len;
    }
    return null;
}

// --- IPC -----------------------------------------------------------------------

export interface DocumentConvertRequest {
    to: 'markdown' | 'docx';
    /** .docx bytes (base64) when to === 'markdown'. */
    base64?: string;
    /** The markdown model when to === 'docx'. */
    markdown?: string;
}

export interface DocumentConvertResult {
    ok: boolean;
    markdown?: string;
    base64?: string;
    error?: string;
}

/** Register the Document plugin's conversion IPC. Call once at app-ready. */
export function registerDocumentConvert(): void {
    ipcMain.handle(
        'plugins:document-convert',
        async (_e, req: DocumentConvertRequest): Promise<DocumentConvertResult> => {
            try {
                if (req?.to === 'markdown') {
                    const bytes = new Uint8Array(Buffer.from(String(req.base64 ?? ''), 'base64'));
                    return { ok: true, markdown: await docxToMarkdown(bytes) };
                }
                if (req?.to === 'docx') {
                    const bytes = await markdownToDocx(String(req.markdown ?? ''));
                    return { ok: true, base64: Buffer.from(bytes).toString('base64') };
                }
                return { ok: false, error: 'Unknown conversion target.' };
            } catch (e) {
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
    );
}
