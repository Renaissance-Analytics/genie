/**
 * A BACKGROUND PROCESS'S OUTPUT, KEPT PAST ITS END (§6.6, the hosting ship line P1).
 *
 * The pty's own scrollback dies with the pty: a process that crashed took the one record of WHY with it, and the
 * Processes tab and the agents' `processes logs` had nothing to show at exactly the moment it mattered. Genie 1 kept a
 * tail per process (256 000 characters, `PROC_LOG_CAP`); this is that tail, bounded twice — by lines, so a chatty
 * worker cannot push a crash off the screen in one burst of short lines, and by characters, so one enormous line
 * without a newline cannot grow it without end. What the bound cuts is COUNTED (`dropped`), never silently gone.
 *
 * Raw pty output is kept; control sequences are stripped when it is READ, so a sequence split across two chunks is
 * whole again by then. A carriage return inside a line is a progress bar redrawing itself: the reader sees the last
 * drawing, as a terminal would.
 */

export const LOG_MAX_LINES = 2_000;
export const LOG_MAX_CHARS = 256_000;

/** What a reader gets: the text, how many lines it is, and how many earlier lines the bound has cut. */
export interface ProcessLog {
    readonly text: string;
    readonly lines: number;
    /** Lines cut by the bound since this process was first started — the log is a tail, and says so. */
    readonly dropped: number;
}

// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function readable(raw: string): string {
    const cr = raw.lastIndexOf('\r');
    const drawn = cr >= 0 ? raw.slice(cr + 1) : raw;
    return drawn.replace(OSC_RE, '').replace(CSI_RE, '').replace(CTRL_RE, '');
}

export class OutputTail {
    readonly #maxLines: number;
    readonly #maxChars: number;
    #lines: string[] = [];
    /** The line still being written (no newline yet). */
    #partial = '';
    #chars = 0;
    #dropped = 0;

    constructor(maxLines: number = LOG_MAX_LINES, maxChars: number = LOG_MAX_CHARS) {
        this.#maxLines = Math.max(1, maxLines);
        this.#maxChars = Math.max(1, maxChars);
    }

    append(data: string): void {
        if (data === '') return;
        const parts = (this.#partial + data).split('\n');
        this.#partial = parts.pop() ?? '';
        for (const p of parts) {
            const line = p.endsWith('\r') ? p.slice(0, -1) : p;
            this.#lines.push(line);
            this.#chars += line.length + 1;
        }
        // One line with no newline is bounded too: its oldest characters go, and that is a cut.
        if (this.#partial.length > this.#maxChars) {
            this.#partial = this.#partial.slice(-this.#maxChars);
            this.#dropped += 1;
        }
        const partialLines = this.#partial === '' ? 0 : 1;
        let cut = 0;
        while (cut < this.#lines.length && (this.#lines.length - cut + partialLines > this.#maxLines || this.#chars + this.#partial.length > this.#maxChars)) {
            this.#chars -= this.#lines[cut]!.length + 1;
            cut += 1;
        }
        if (cut > 0) {
            this.#lines = this.#lines.slice(cut);
            this.#dropped += cut;
        }
    }

    /** A line of Genie's own (`[genie] …`), always on a line of its own — never glued to a half-written one. */
    note(text: string): void {
        if (this.#partial !== '') this.append('\n');
        this.append(`[genie] ${text}\n`);
    }

    /** The last `lines` lines (all of them when absent), control sequences stripped. */
    read(lines?: number): ProcessLog {
        const all = this.#partial === '' ? this.#lines : [...this.#lines, this.#partial];
        const take = lines === undefined ? all : all.slice(Math.max(0, all.length - Math.max(0, Math.floor(lines))));
        return { text: take.map(readable).join('\n'), lines: take.length, dropped: this.#dropped };
    }
}
