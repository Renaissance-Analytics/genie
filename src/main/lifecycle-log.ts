import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * THE LIFECYCLE LOG — `~/.genie/runtime/lifecycle.log` (hosting plan 1.6; lifecycle review F10, 2026-10-20).
 *
 * One line per spawn, kill, verified exit, refusal and sweep. The installed app wrote no log file: the sweep and the
 * refused reaps went to `console.log`, which nobody sees, so the owner's question — did the restart leave the old Claude
 * running? — could not be settled from evidence. One line per event, and rotated: past `maxBytes` the file becomes
 * `lifecycle.log.1`.
 *
 * Written synchronously by default (the window). `async` (genie-host's, Tynn #548): a line is queued and the call returns
 * at once — on genie#1709's Windows run one host gap of 537.8 ms was 546 ms inside appendFileSync here. Queued lines are
 * written in order, one batch at a time, a rotation included; `flush()` resolves once every line so far is written; an
 * exit (process.exit, an uncaught error, the end of the loop) writes every line still queued, synchronously, before the
 * process goes. A process killed outright loses at most what was queued, never a line in the middle: each batch is whole
 * lines. The queue is bounded: past `maxQueuedBytes` the oldest queued lines are dropped and the next batch says how many.
 *
 * Never throws into its caller: a stop must not fail because its log could not be written.
 */
/** One write's worth of whole lines: small enough to be a single write, so a kill never tears a line. */
const BATCH_BYTES = 32 * 1024;

export type LifecycleLog =((line: string) => void) & { flush(): Promise<void> };

export function openLifecycleLog(dir: string, options: { now?: () => number; maxBytes?: number; async?: boolean; maxQueuedBytes?: number } = {}): LifecycleLog {
    const file = join(dir, 'lifecycle.log');
    const now = options.now ?? Date.now;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const stamp = (line: string): string => `${new Date(now()).toISOString()} ${line.replace(/[\r\n]+/g, ' ')}\n`;
    let size: number | null = null;

    if (options.async !== true) {
        const log = (line: string): void => {
            try {
                const text = stamp(line);
                if (size === null) {
                    mkdirSync(dir, { recursive: true });
                    size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
                }
                if (size + Buffer.byteLength(text) > maxBytes && size > 0) {
                    renameSync(file, `${file}.1`);
                    size = 0;
                }
                appendFileSync(file, text, 'utf8');
                size += Buffer.byteLength(text);
            } catch {
                // Not written. The event itself already happened; nothing here may undo or interrupt it.
                size = null;
            }
        };
        return Object.assign(log, { flush: () => Promise.resolve() });
    }

    const maxQueued = options.maxQueuedBytes ?? 4 * 1024 * 1024;
    let queue: string[] = [];
    let queuedBytes = 0;
    let dropped = 0;
    /** The batch being written now, until its write has landed (an exit writes it again rather than lose it). */
    let writing: string | null = null;
    let running: Promise<void> | null = null;
    let exited = false;

    /**
     * The next batch: whole lines, at most `BATCH_BYTES` (one write, so a process killed outright never leaves half a line),
     * or `all` of them for the exit's last write.
     */
    const take = (all = false): string => {
        let batch = dropped > 0 ? stamp(`lifecycle log: ${dropped} line(s) dropped, the queue was full`) : '';
        dropped = 0;
        let n = 0;
        while (n < queue.length && (all || n === 0 || Buffer.byteLength(batch) + Buffer.byteLength(queue[n]!) <= BATCH_BYTES)) batch += queue[n++]!;
        queuedBytes -= Buffer.byteLength(queue.slice(0, n).join(''));
        queue = queue.slice(n);
        return batch;
    };

    /** The rotation, decided before a batch is written: the batch never straddles two files. */
    const rotateFor = (bytes: number): boolean => size !== null && size > 0 && size + bytes > maxBytes;

    const pump = async (): Promise<void> => {
        while (queue.length > 0 || dropped > 0) {
            const batch = take();
            writing = batch;
            const bytes = Buffer.byteLength(batch);
            try {
                if (size === null) {
                    await mkdir(dir, { recursive: true });
                    size = (await stat(file).catch(() => null))?.size ?? 0;
                }
                if (rotateFor(bytes)) {
                    await rename(file, `${file}.1`);
                    size = 0;
                }
                if (exited) return;
                await appendFile(file, batch, 'utf8');
                size = (size ?? 0) + bytes;
            } catch {
                size = null;
            } finally {
                writing = null;
            }
        }
    };

    const start = (): void => {
        if (running || exited) return;
        running = pump().finally(() => { running = null; if (queue.length > 0 || dropped > 0) start(); });
    };

    // An exit writes what is left, synchronously: the batch in flight (if its write has not landed) and the queue.
    const onExit = (): void => {
        if (exited) return;
        const rest = (writing ?? '') + take(true);
        exited = true;
        if (rest === '') return;
        try {
            mkdirSync(dir, { recursive: true });
            const current = size ?? statSync(file, { throwIfNoEntry: false })?.size ?? 0;
            if (current > 0 && current + Buffer.byteLength(rest) > maxBytes) renameSync(file, `${file}.1`);
            appendFileSync(file, rest, 'utf8');
        } catch { /* the process is going; nothing more can be done */ }
    };
    process.once('exit', onExit);

    const log = (line: string): void => {
        if (exited) return;
        const text = stamp(line);
        queue.push(text);
        queuedBytes += Buffer.byteLength(text);
        while (queuedBytes > maxQueued && queue.length > 1) {
            queuedBytes -= Buffer.byteLength(queue.shift()!);
            dropped += 1;
        }
        start();
    };
    const flush = async (): Promise<void> => {
        while (running || queue.length > 0) {
            start();
            await running;
        }
    };
    return Object.assign(log, { flush });
}
