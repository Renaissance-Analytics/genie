/**
 * Pure byte-construction for sending input to a pty — the part of the agent-
 * control MCP tools (`runAgent` / `manageTerminals` write/send) that decides
 * EXACTLY what bytes hit the terminal. Kept dependency-free (no pty, no
 * electron) so the wire format is unit-tested directly; ipc.ts does the actual
 * `terminalManager().write`.
 *
 * Why this exists (the beta.37 multi-line submit bug): a TUI agent like Claude
 * Code reads its input through bracketed paste. If we deliver `text + "\n"` as
 * one chunk, a MULTI-LINE body is captured as a single bracketed paste —
 * including the trailing newline — so it loads into the prompt buffer as
 * "[Pasted text +N lines]" and just SITS there, never submitted. Short single-
 * line bodies happen to submit only because the TUI treats the lone newline as
 * Enter. The fix: wrap a multi-line body in explicit bracketed-paste markers and
 * then deliver a SEPARATE carriage return OUTSIDE the markers, so the TUI sees a
 * distinct Enter and submits the paste.
 */

/** Bracketed-paste markers. The TUI treats everything between them as pasted
 *  literal text (no per-line Enter), so a multi-line body lands as one block. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** A carriage return — what a real Enter keypress sends to a pty (NOT "\n"). */
export const CR = '\r';

/**
 * Named single keypresses an agent can deliver on their own (the `key` escape-
 * hatch), so a bare Enter can submit/clear a stuck buffer, Escape can dismiss a
 * mode, and Ctrl-C can interrupt — without smuggling them inside a text body.
 * A small, deliberate allow-list (no arbitrary control bytes from the wire).
 */
export const KEY_SEQUENCES = {
    enter: '\r',
    escape: '\x1b',
    'ctrl-c': '\x03',
} as const;

export type TerminalKey = keyof typeof KEY_SEQUENCES;

/** True for one of the allow-listed key names. */
export function isTerminalKey(key: string): key is TerminalKey {
    return Object.prototype.hasOwnProperty.call(KEY_SEQUENCES, key);
}

/** The bytes for a single named keypress (Enter = "\r", Escape, Ctrl-C). */
export function keyBytes(key: TerminalKey): string {
    return KEY_SEQUENCES[key];
}

/** A body counts as multi-line if it contains any newline (after we ignore a
 *  single trailing one — a lone "foo\n" is still a single-line submit). */
function isMultiLine(text: string): boolean {
    return text.replace(/\r?\n$/, '').includes('\n');
}

/**
 * Build the bytes to deliver a text body to a TUI/shell, optionally submitting it.
 *
 *   - submit + MULTI-LINE → `ESC[200~<text>ESC[201~` then a SEPARATE `\r`
 *     (paste wrapped; Enter OUTSIDE the markers so the TUI submits it).
 *   - submit + SINGLE-LINE → `<text>\r` (no paste wrapper needed).
 *   - no submit → the body only, with NO trailing Enter.
 *
 * Any trailing newline already in `text` is stripped first, so the only submit
 * is the explicit `\r` we add — we never leave a "\n" inside the paste acting as
 * a phantom (and unreliable) submit.
 */
export function buildSubmitBytes(text: string, submit: boolean): string {
    // Drop a trailing newline the caller may have included out of habit; the
    // submit is the explicit CR below, never an in-band newline.
    const body = text.replace(/\r?\n$/, '');
    if (!submit) return body;
    if (isMultiLine(body)) {
        return PASTE_START + body + PASTE_END + CR;
    }
    return body + CR;
}

/**
 * Resolve a write/send request into the exact bytes to deliver to the pty, plus
 * a short human preview for the approval modal. The pure decision shared by
 * manageTerminals.write and runAgent.send (the I/O — gating + the actual write —
 * stays in background.ts).
 *
 *  - `key` (allow-listed: enter/escape/ctrl-c) → that single keypress only; any
 *    text is ignored. Lets a bare Enter submit/clear a stuck buffer.
 *  - otherwise → the text body via buildSubmitBytes (SUBMITTED by default).
 *
 * Returns `{ error }` when there is genuinely nothing to do (no text, no submit,
 * no key) or the key name is unknown — so empty input is STILL rejected unless it
 * carries a submit or a keypress.
 */
export function resolveTerminalInput(
    text: string | undefined,
    opts: { submit?: boolean; key?: string },
): { bytes: string; preview: string } | { error: string } {
    if (opts.key !== undefined) {
        if (!isTerminalKey(opts.key)) {
            return { error: `Unknown key "${opts.key}". Allowed: enter, escape, ctrl-c.` };
        }
        return { bytes: keyBytes(opts.key), preview: `<key: ${opts.key}>` };
    }
    const body = typeof text === 'string' ? text : '';
    const submit = opts.submit !== false; // default true
    if (body.length === 0 && !submit) {
        return { error: 'nothing to send — provide text, `submit`, or a `key`.' };
    }
    const bytes = buildSubmitBytes(body, submit);
    const visible = body.length === 0 ? '<enter>' : body;
    const preview = visible.length > 200 ? visible.slice(0, 200) + '…' : visible;
    return { bytes, preview };
}

/**
 * Strip ANSI / terminal escape sequences from buffered pty output so a `read`
 * can return readable plain text instead of raw redraw frames. Removes:
 *   - CSI sequences (`ESC[ … final-byte`) — colours, cursor moves, erases,
 *     bracketed-paste markers, etc.
 *   - OSC sequences (`ESC] … BEL` or `ESC] … ESC\`) — window titles, hyperlinks.
 *   - other two-byte ESC sequences (`ESC` + a single byte, e.g. `ESC c`).
 *   - stray carriage returns and the BEL byte.
 *
 * Best-effort and lossy by design (a redraw-heavy TUI frame won't reconstruct
 * perfectly), but it turns an unreadable wall of escapes into legible text.
 */
export function stripAnsi(input: string): string {
    return (
        input
            // OSC: ESC ] ... (BEL | ESC \)
            .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
            // CSI: ESC [ ... final byte in @-~
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
            // Other single-char ESC sequences (ESC c, ESC (B, ...). The char
            // class covers the common intermediates/finals; lone ESC is dropped.
            .replace(/\x1b[@-Z\\-_]/g, '')
            .replace(/\x1b[ -/]*[0-~]/g, '')
            // Bare BEL.
            .replace(/\x07/g, '')
            // Carriage returns used for in-place redraws (keep newlines).
            .replace(/\r/g, '')
    );
}
