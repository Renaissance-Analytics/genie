/**
 * Markdown <-> DOCX conversion for the bundled Document plugin.
 *
 * A thin adapter over the Fancy suite's dedicated docx package —
 * `@particle-academy/last-word` (the dark-slide / holy-sheet sibling, shipped
 * for Genie's ask in react-fancy#9). Its Agent bridges both ways:
 *
 *   open:  .docx bytes --Agent.read--> Doc --Agent.toMarkdown--> markdown
 *   save:  markdown --Agent.fromMarkdown--> Doc --Agent.toBytes--> .docx bytes
 *
 * The editor's single model stays a MARKDOWN string (react-fancy's Editor is a
 * markdown-out WYSIWYG); conversion stays in MAIN behind one IPC so document
 * libraries never enter the renderer bundle. Fidelity contract
 * (owner-approved): what markdown can express — headings, styled runs, links,
 * nested lists, tables, code blocks, quotes, embedded data-URL images —
 * survives; Word-only features (tracked changes, comments) do not.
 */
import { ipcMain } from 'electron';
import { Agent } from '@particle-academy/last-word';

/** Read .docx bytes into the editor's markdown model. */
export async function docxToMarkdown(bytes: Uint8Array): Promise<string> {
    return Agent.toMarkdown(Agent.read(bytes));
}

/** Serialize the editor's markdown model to .docx bytes. */
export async function markdownToDocx(md: string): Promise<Uint8Array> {
    return Agent.toBytes(Agent.fromMarkdown(md ?? ''));
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
