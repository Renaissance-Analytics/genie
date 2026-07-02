/**
 * Terminal image-paste helpers — the pure decision logic behind pasting a copied
 * IMAGE into a terminal (Claude Code & friends).
 *
 * WHY this exists: a copied image can't ride the stdin/keystroke path the way text
 * does. Claude Code (and other CLIs) read a pasted image from the OS clipboard of
 * the machine they run ON. Locally that's the same clipboard the user copied into;
 * over Genie's remote bridge the CLI runs on the HOST, whose clipboard is empty.
 * So the terminal paste path first checks for a LOCAL clipboard image, syncs it to
 * the clipboard of the machine the terminal runs on, then delivers the paste
 * trigger to the pty so the CLI reads it exactly like a native local paste.
 *
 * This module is intentionally free of React / Electron so the parse + decision is
 * unit-testable in isolation; the Terminal component wires it to the IPC bridge.
 */

/**
 * The byte Ctrl+V sends to a pty (ASCII SYN, 0x16). Claude Code reads the OS
 * clipboard when it receives this, so it doubles as the "paste an image" trigger:
 * after the image is on the target clipboard, we send this to the pty and the CLI
 * inlines the image exactly like a native local paste.
 */
export const PASTE_TRIGGER_CTRL_V = '\x16';

/**
 * The bytes an Alt/Meta+V keystroke sends to a pty: ESC + 'v' (xterm encodes
 * Alt+<key> as the meta prefix `\x1b` followed by the key). This is the image-paste
 * gesture Claude Code reads in the owner's build — it reads the OS clipboard of the
 * machine it runs on when it sees Meta+V. We forward these bytes AFTER syncing the
 * image to the (host) clipboard so the CLI's own Meta+V handler reads the populated
 * clipboard, exactly like a native local paste. Ordering is load-bearing: the host
 * clipboard write must land before this trigger reaches the pty.
 */
export const PASTE_TRIGGER_ALT_V = '\x1bv';

/** A parsed image clipboard payload: the mime type + the raw base64 (no data-URL
 *  prefix, whitespace stripped), ready to ship to a clipboard writer. */
export interface ParsedClipboardImage {
    mime: string;
    /** base64 with the `data:...;base64,` prefix removed and whitespace stripped. */
    base64: string;
}

/**
 * Parse a clipboard-image data-URL (what Electron's `nativeImage.toDataURL()`
 * produces, e.g. `data:image/png;base64,iVBOR…`) into `{ mime, base64 }`, or null
 * when there is no usable image. Returning null is the "handle this paste as TEXT"
 * signal — the caller falls through to the existing text paste unchanged.
 *
 * Null for: a null/empty/non-string input, a non-`image/*` data-URL, a non-base64
 * data-URL, or an empty payload. Whitespace inside the base64 (line wraps) is
 * tolerated and stripped.
 */
export function parseImageDataUrl(
    dataUrl: string | null | undefined,
): ParsedClipboardImage | null {
    if (typeof dataUrl !== 'string') return null;
    const trimmed = dataUrl.trim();
    if (!trimmed) return null;
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
    if (!m) return null;
    const base64 = m[2].replace(/\s+/g, '');
    if (!base64) return null;
    return { mime: m[1].toLowerCase(), base64 };
}
