/**
 * THE CLIPBOARD WIRE (genie#1263 follow-up): a page asks MAIN to put text, and optionally HTML, on the clipboard.
 *
 * Why main: Genie 1 found that `navigator.clipboard` can fail SILENTLY in a sandboxed Electron window (v0.7.0-beta.342,
 * `renderer/components/Terminal/Terminal.tsx`) — the promise resolves, nothing is on the clipboard, and a copy button says
 * "Copied". Electron's `clipboard` in main has no focus or permission to lose. One channel, named here once, imported by
 * main (`main/clipboard-ipc.ts`) and by both preloads that draw rendered Markdown.
 */
export const CLIPBOARD_WRITE_CHANNEL = 'genie:clipboard-write';

/** A copy larger than this is refused: no button in Genie copies anything near it, and main never buffers more. */
export const MAX_CLIPBOARD_CHARS = 5_000_000;

export interface ClipboardWriteRequest {
    readonly text: string;
    readonly html?: string;
}

/** The request as main accepts it — `{ text, html? }`, strings within the cap — or `null`: refused, nothing written. */
export function clipboardWriteRequest(raw: unknown): ClipboardWriteRequest | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const { text, html } = raw as { text?: unknown; html?: unknown };
    if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_CHARS) return null;
    if (html === undefined) return { text };
    if (typeof html !== 'string' || html.length > MAX_CLIPBOARD_CHARS) return null;
    return { text, html };
}
