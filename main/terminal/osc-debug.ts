import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Diagnostic: capture EVERY OSC sequence a pty emits, so we can see EXACTLY what
 * a TUI (e.g. Claude Code) sends when the user copies — an OSC 52 clipboard write
 * (`ESC]52;c;<base64>`), or nothing at all. This is the data that settles whether
 * a copy bug is "the app never emits OSC 52" (a $TERM / terminfo `Ms` gating
 * issue) vs "Genie drops it" (a handler issue).
 *
 * Gated on `GENIE_OSC_DEBUG=1` — a complete no-op (zero overhead) otherwise, so
 * it's safe to leave in. When on, every pty chunk is scanned in main (which sees
 * the RAW bytes before xterm parses them) and matching OSC sequences are appended
 * to `<userData>/logs/osc-debug.log`.
 */

export function oscDebugEnabled(): boolean {
    return process.env.GENIE_OSC_DEBUG === '1';
}

// OSC = ESC ] <body> (BEL | ESC \). Capture the body for logging.
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * Extract the bodies of every OSC sequence in a pty data chunk. Each entry is
 * the text between `ESC]` and its terminator — e.g. `52;c;<base64>` for an OSC 52
 * clipboard write. Pure → unit-testable.
 */
export function extractOscSequences(data: string): string[] {
    const out: string[] = [];
    OSC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = OSC_RE.exec(data)) !== null) out.push(m[1]);
    return out;
}

/** A human-readable one-line summary of an OSC body for the log (truncates long
 *  base64 payloads, tags OSC 52 prominently). Pure → unit-testable. */
export function describeOsc(body: string): string {
    const semi = body.indexOf(';');
    const ident = semi === -1 ? body : body.slice(0, semi);
    const tag = ident === '52' ? 'OSC52(clipboard)' : `OSC${ident}`;
    const shown = body.length > 200 ? `${body.slice(0, 200)}…(${body.length} chars)` : body;
    return `${tag} ${JSON.stringify(shown)}`;
}

/**
 * Append the OSC sequences in `data` (for terminal `id`) to the debug log. No-op
 * unless `GENIE_OSC_DEBUG=1`. Best-effort — never throws into the pty fan-out.
 */
export function logPtyOsc(id: string, data: string): void {
    if (!oscDebugEnabled()) return;
    const seqs = extractOscSequences(data);
    if (seqs.length === 0) return;
    try {
        const dir = path.join(app.getPath('userData'), 'logs');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString();
        const lines = seqs.map((s) => `[${stamp}] term=${id} ${describeOsc(s)}`).join('\n');
        fs.appendFileSync(path.join(dir, 'osc-debug.log'), lines + '\n');
    } catch {
        /* logging is best-effort — never let it break the terminal */
    }
}
