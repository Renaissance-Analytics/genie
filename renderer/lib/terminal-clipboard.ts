import type {
    TerminalContextMenuConfig,
    TerminalContextMenuContext,
    TerminalContextMenuItem,
} from '@particle-academy/fancy-term';

export interface ClipboardMenuHandlers {
    /** Write the current selection to the SYSTEM clipboard (Electron-main IPC). */
    copy: (selection: string) => void;
    /** Read the system clipboard and paste it into the terminal. */
    paste: () => void;
    /**
     * Resolve the effective selection from the menu's context selection. Lets the
     * host substitute a selection it captured at right-click time — a right-click
     * (especially over a mouse-reporting TUI) can clear xterm's LIVE selection
     * before the menu reads it, leaving Copy disabled. Defaults to ctx.selection.
     */
    resolveSelection?: (ctxSelection: string) => string;
}

/**
 * Build the terminal's right-click menu with Copy/Paste routed through the host's
 * Electron-main clipboard (via IPC) instead of fancy-term's `navigator.clipboard`
 * defaults — which fail SILENTLY in a sandboxed Electron window (no permission /
 * lost user-gesture), so terminal copy never reached the OS clipboard. The
 * package's other built-in items (Select all / Clear) are preserved.
 *
 * Pure (no React / no Electron) → unit-testable.
 */
export function buildClipboardMenu(
    handlers: ClipboardMenuHandlers,
): TerminalContextMenuConfig {
    return (
        ctx: TerminalContextMenuContext,
        defaults: TerminalContextMenuItem[],
    ): TerminalContextMenuItem[] => {
        const selection = handlers.resolveSelection
            ? handlers.resolveSelection(ctx.selection)
            : ctx.selection;
        // Drop the package's navigator.clipboard Copy/Paste; keep the rest.
        const rest = defaults.filter((d) => d.id !== 'copy' && d.id !== 'paste');
        return [
            {
                id: 'copy',
                label: 'Copy',
                disabled: !selection,
                onSelect: () => handlers.copy(selection),
            },
            {
                id: 'paste',
                label: 'Paste',
                disabled: ctx.readOnly,
                onSelect: () => handlers.paste(),
            },
            ...rest,
        ];
    };
}

// --- OSC 52 (the clipboard escape sequence TUIs copy with) -----------------
// A modern TUI (Claude Code, tmux, vim, neovim…) copies its OWN selection by
// emitting `ESC ] 52 ; <Pc> ; <Pd> BEL` — the base64 selection. xterm.js does
// NOT honour OSC 52 by default, so without a handler the sequence is silently
// DROPPED: the app shows its "copied" feedback but nothing ever reaches the
// system clipboard. These route OSC 52 to the host (Electron-main) clipboard.

/** Decode an OSC 52 base64 payload to a UTF-8 string. */
export function decodeOsc52Base64(b64: string): string {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/** Encode a UTF-8 string as an OSC 52 base64 payload. */
export function encodeOsc52Base64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

export interface Osc52Host {
    /** Write copied text to the system clipboard (Electron main via IPC). */
    write: (text: string) => void;
    /** Read the system clipboard (for an OSC 52 read request). */
    read: () => Promise<string>;
    /** Send an OSC 52 reply to the app on the pty's INPUT stream. The arg is the
     *  OSC body without the `ESC]` prefix / terminator, e.g. `52;c;<base64>`. */
    respond: (oscBody: string) => void;
}

/**
 * Handle one OSC 52 payload — the part AFTER `ESC ] 52 ;`, i.e. `<Pc>;<Pd>`.
 *   - `<Pd>` base64  → decode + WRITE to the system clipboard (the TUI's copy).
 *   - `<Pd>` === '?' → READ the clipboard and reply with a base64 OSC 52 on the
 *                      app's input stream (so a paste-from-clipboard request works).
 *   - empty `<Pd>`   → a clear/no-op; leave the system clipboard untouched.
 * Always returns true (the sequence is consumed). Pure but for the injected host
 * callbacks → unit-testable.
 */
export function handleOsc52(data: string, host: Osc52Host): boolean {
    const semi = data.indexOf(';');
    const pc = (semi === -1 ? '' : data.slice(0, semi)) || 'c';
    const pd = semi === -1 ? '' : data.slice(semi + 1);
    if (pd === '?') {
        void host
            .read()
            .then((text) => host.respond(`52;${pc};${encodeOsc52Base64(text)}`))
            .catch(() => {});
        return true;
    }
    if (pd === '') return true; // empty/clear — don't wipe the system clipboard
    try {
        const text = decodeOsc52Base64(pd);
        if (text) host.write(text);
    } catch {
        /* malformed base64 — ignore */
    }
    return true;
}
