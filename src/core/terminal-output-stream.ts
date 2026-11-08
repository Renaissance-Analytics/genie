/**
 * WHAT A TERMINAL PANE WRITES (Tynn #542). The view keeps each terminal's newest `OUTPUT_CAP` characters, trimmed from the
 * front. fancy-term's controlled `output` prop decides what to write by comparing the new string with the one it wrote:
 * an extension writes its tail, anything else resets the terminal and writes it all. Past the cap every batch is trimmed,
 * so no batch is an extension: the terminal was reset and given all 2 MB again, about every 33 ms, for as long as it
 * streamed. Below the cap the comparison itself read up to the whole kept string on every batch.
 *
 * Now the view says where the stream is: `epoch` (a new one each time the output is REPLACED, by an open or a snapshot)
 * and `end` (every character appended in this epoch, the trimmed ones included). What was appended is then known from
 * the numbers alone, and only it is written. Without them (a pane fed a plain string), the old comparison.
 */
export interface OutputView {
    readonly text: string;
    /** Characters appended in this epoch, counting those since trimmed from the front of `text`. */
    readonly end?: number;
    /** Which stream: a replaced output is a new one. */
    readonly epoch?: number;
}

export interface OutputStep {
    /** Clear the terminal first: what it shows is not the start of this text. */
    readonly reset: boolean;
    readonly write: string;
}

/** What to write to go from showing `prev` to showing `next`; `null` = nothing. */
export function outputStep(prev: OutputView | null, next: OutputView): OutputStep | null {
    if (prev === null) return next.text === '' ? null : { reset: false, write: next.text };
    if (prev.end !== undefined && next.end !== undefined && prev.epoch !== undefined && prev.epoch === next.epoch) {
        const appended = next.end - prev.end;
        if (appended === 0) return null;
        // Within what is kept: only the new tail, never a read of the rest.
        if (appended > 0 && appended <= next.text.length) return { reset: false, write: next.text.slice(next.text.length - appended) };
        // More arrived between two renders than is kept (or the count went back): the kept text, from a clean terminal.
        return { reset: true, write: next.text };
    }
    if (prev.end !== undefined && next.end !== undefined) return { reset: true, write: next.text }; // a new epoch
    if (next.text === prev.text) return null;
    if (next.text.startsWith(prev.text)) return { reset: false, write: next.text.slice(prev.text.length) };
    return { reset: true, write: next.text };
}

/**
 * A TERMINAL'S OUTPUT AS A VIEW KEEPS IT (Tynn #544): the kept text (its newest `cap` characters), and its position. The
 * Workspace keeps the same per terminal in its own state (`outputAt`, #542); the Agent view and the Take Over window keep
 * one of these each.
 */
export interface OutputStream {
    readonly text: string;
    readonly end: number;
    readonly epoch: number;
}

/** The output REPLACED (a snapshot on attach): a new epoch, which the pane starts from a clean terminal. */
export function streamReplaced(prev: OutputStream | null, text: string): OutputStream {
    return { text, end: text.length, epoch: (prev?.epoch ?? 0) + 1 };
}

/** Output appended: counted in full, kept to `cap` from the front. */
export function streamAppended(prev: OutputStream, data: string, cap: number): OutputStream {
    const joined = prev.text + data;
    return { text: joined.length > cap ? joined.slice(joined.length - cap) : joined, end: prev.end + data.length, epoch: prev.epoch };
}
