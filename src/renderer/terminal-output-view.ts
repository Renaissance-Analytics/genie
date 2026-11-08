import { flushSync } from 'react-dom';
import { streamAppended, streamReplaced, type OutputStream } from '../core/terminal-output-stream.js';
import { OUTPUT_CAP } from '../core/workspace-view.js';
import type { TerminalObserver } from './local-terminal-client.js';
import { outputBatch } from './terminal-output-batch.js';

/**
 * ONE TERMINAL'S OUTPUT, FOR A VIEW THAT SHOWS ONLY IT (Tynn #544): the Agent view's observed terminal and the Take Over
 * window. Each kept the terminal's whole output in a string that only grew, re-rendered synchronously on every chunk, and
 * handed fancy-term that string to compare with the last one, which read all of it on every chunk. Now as the Workspace
 * does (#525, #542): the chunks a batch holds are applied in one update, the text is kept to the cap, and the stream
 * position goes with it, so the pane writes only what was appended.
 *
 * Output credit: the protocol grants more once the observer returns, so with a batch the credit can run ahead of what is
 * drawn by one batch (at most `cap` held), as in the Workspace since #525. An exit applies what is held first, and a
 * snapshot drops what was held before it (it already holds it).
 */
export interface OutputViewPorts {
    readonly update: (fn: (stream: OutputStream | null) => OutputStream) => void;
    readonly exited: (code: number | null) => void;
    readonly error: (message: string | null) => void;
    /** How much one view keeps: OUTPUT_CAP unless told. */
    readonly cap?: number;
    readonly later?: (fn: () => void, ms: number) => () => void;
}

const ID = 'terminal';

export function outputViewObserver(ports: OutputViewPorts): TerminalObserver & { close(): void } {
    const cap = ports.cap ?? OUTPUT_CAP;
    const batch = outputBatch({
        cap,
        ...(ports.later ? { later: ports.later } : {}),
        apply: (held) => ports.update((stream) => held.reduce((value, [, text]) => streamAppended(value, text, cap), stream ?? streamReplaced(null, ''))),
    });
    return {
        snapshot: (joined) => { batch.drop(ID); flushSync(() => { ports.update((stream) => streamReplaced(stream, joined.scrollback)); ports.error(null); ports.exited(null); }); },
        data: (text) => batch.data(ID, text),
        exit: (code) => flushSync(() => { batch.flush(); ports.exited(code); }),
        error: (error) => ports.error(error.message),
        close: () => batch.close(),
    };
}
