import { CLIPBOARD_WRITE_CHANNEL, clipboardWriteRequest } from '../core/clipboard-wire.js';

/**
 * A COPY, WRITTEN BY MAIN (genie#1263 follow-up; core/clipboard-wire.ts says why it is main's).
 *
 * The write goes through Electron's clipboard, and then the text is READ BACK: a write that did not land (on Windows
 * another program can hold the clipboard open) is `false`, which every copy button announces as "Copy failed". Electron's
 * clipboard is reached through a port (`electronClipboardPort`), so the rule is tested without Electron.
 */
export interface ClipboardPort {
    write(data: { text: string; html?: string }): Promise<void>;
    readText(): Promise<string>;
}

/**
 * Electron 45's main-process clipboard: `write([ClipboardItem])` commits every MIME type of the item at once, and
 * `readText()` reads the plain text back — both promises, modelled on the W3C API.
 */
export function electronClipboardPort<Item>(
    clipboard: { write(items: Item[]): Promise<void>; readText(): Promise<string> },
    ClipboardItem: new (items: Record<string, string>) => Item,
): ClipboardPort {
    return {
        write: (data) => clipboard.write([new ClipboardItem(data.html === undefined ? { 'text/plain': data.text } : { 'text/plain': data.text, 'text/html': data.html })]),
        readText: () => clipboard.readText(),
    };
}

/** Windows hands text back with CRLF line ends; that is the same text. */
const sameText = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

export async function writeClipboard(raw: unknown, clipboard: ClipboardPort): Promise<boolean> {
    const request = clipboardWriteRequest(raw);
    if (!request) return false;
    try {
        await clipboard.write(request.html === undefined ? { text: request.text } : { text: request.text, html: request.html });
        return sameText(await clipboard.readText(), request.text);
    } catch {
        return false;
    }
}

/*
 * The page's half is in each preload that needs it (main, question, doctor), written out there: one method,
 * `genieClipboard.write(text, html?)`, nothing of the clipboard to READ. Not imported from here — see those preloads.
 */

export function registerClipboardIpc(
    ipcMain: { handle(channel: string, handler: (event: unknown, raw: unknown) => unknown): void },
    clipboard: ClipboardPort,
): void {
    ipcMain.handle(CLIPBOARD_WRITE_CHANNEL, (_event, raw) => writeClipboard(raw, clipboard));
}
