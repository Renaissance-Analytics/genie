import { Worker } from 'node:worker_threads';
import { confine, countsAsDiskChange } from '../core/files-panel.js';
import { IGNORED_NAMES } from './files-host.js';
import { nodeWatchSource, type WatchSource } from './files-watch-hub.js';

/**
 * THE WATCHER OFF genie-host's THREAD (Tynn #524, UI lag L4). Measured in the real app during a write-heavy build on the
 * Windows runner (scripts/ui-lag-cdp.mjs): genie-host late up to 399 ms, 46 gaps over 50 ms in 12 s, and its profile
 * idle through them, its few JS samples in the watcher's change events. A recursive `fs.watch` delivers each change on
 * the thread that holds it, and on Windows libuv does native work per changed file (its name resolved on disk) before
 * any JS runs, so thousands of writes a second hold genie-host's own loop, which also serves the agents, the terminals
 * and every window.
 *
 * Here the watch and the `stat` behind each change run on a worker thread of their own, its own event loop. The worker
 * is a pipe: it reports each changed name it did not skip with what `stat` said; what COUNTS (`confine`,
 * `countsAsDiskChange`) is decided here, as in `nodeWatchSource`. A worker that cannot start falls back to the watch on
 * this thread, said once.
 */

/** Runs in the worker, from its source text: everything it uses it requires itself. */
function watchInWorker(): void {
    const { parentPort, workerData } = require('node:worker_threads') as typeof import('node:worker_threads');
    const { watch, stat } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const { root, ignored } = workerData as { root: string; ignored: string[] };
    const skip = new Set(ignored);
    let batch: Array<[string, number | null, boolean]> = [], timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => { timer = null; const out = batch; batch = []; if (out.length) parentPort!.postMessage(out); };
    const watcher = watch(root, { recursive: true }, (_type, filename) => {
        if (typeof filename !== 'string') return;
        const rel = filename.replace(/\\/g, '/');
        if (rel === '' || rel.split('/').some((seg) => skip.has(seg))) return;
        stat(join(root, filename), (error, info) => {
            batch.push(error ? [rel, null, false] : [rel, info.mtimeMs, info.isDirectory()]);
            timer ??= setTimeout(flush, 20);
        });
    });
    watcher.on('error', () => { /* a lost watcher means no new marks; the tree still opens */ });
    parentPort!.on('message', (m) => { if (m === 'close') { watcher.close(); if (timer) clearTimeout(timer); flush(); process.exit(0); } });
}

export interface WorkerWatchOptions {
    /** Told once when the worker could not start and the watch runs on this thread instead. */
    readonly log?: (line: string) => void;
    /** For a test: the fallback when the worker cannot start. */
    readonly fallback?: WatchSource;
    /** For a test: how to start the worker. */
    readonly startWorker?: (source: string, workerData: unknown) => Pick<Worker, 'on' | 'postMessage' | 'terminate'>;
}

export function workerWatchSource(options: WorkerWatchOptions = {}): WatchSource {
    return (root, onPath) => {
        // As nodeWatchSource: on macOS only what changes after this moment counts (FSEvents replays earlier writes).
        const since = process.platform === 'darwin' ? Date.now() : Number.NEGATIVE_INFINITY;
        let closed = false;
        let worker: Pick<Worker, 'on' | 'postMessage' | 'terminate'>;
        try {
            const start = options.startWorker ?? ((source, workerData) => new Worker(source, { eval: true, workerData }));
            worker = start(`(${watchInWorker.toString()})()`, { root, ignored: [...IGNORED_NAMES] });
        } catch (error) {
            options.log?.(`files watch: the watcher's own thread could not start (${error instanceof Error ? error.message : String(error)}); watching on genie-host's thread`);
            return (options.fallback ?? nodeWatchSource)(root, onPath);
        }
        worker.on('message', (batch: Array<[string, number | null, boolean]>) => {
            if (closed || !Array.isArray(batch)) return;
            for (const [name, mtimeMs, isDirectory] of batch) {
                const rel = confine(root, name);
                if (rel === null || rel === '') continue;
                if (countsAsDiskChange(mtimeMs === null ? null : { mtimeMs, isDirectory }, since)) onPath(rel);
            }
        });
        worker.on('error', (error) => { options.log?.(`files watch: the watcher's thread failed: ${error instanceof Error ? error.message : String(error)}`); });
        return { close: () => { if (closed) return; closed = true; try { worker.postMessage('close'); } catch { /* already gone */ } setTimeout(() => { void worker.terminate(); }, 1_000).unref?.(); } };
    };
}
