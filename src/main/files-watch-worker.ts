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

/**
 * The worker's own source, as text, run with `eval`: a literal, never a function's `toString()`, which the bundler
 * rewrites (its `require` becomes a helper of the bundle's that the worker does not have: measured in the built host,
 * the worker started and reported nothing).
 */
export const WATCH_WORKER_SOURCE = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const { watch, stat } = require('node:fs');",
    "const { readdir, stat: statAsync } = require('node:fs/promises');",
    "const { join, sep } = require('node:path');",
    'const { root, ignored, since, limit } = workerData;',
    'const skip = new Set(ignored);',
    'let batch = [], timer = null;',
    'const flush = () => { timer = null; const out = batch; batch = []; if (out.length) parentPort.postMessage(out); };',
    'const watcher = watch(root, { recursive: true }, (_type, filename) => {',
    "    if (typeof filename !== 'string') return;",
    "    const rel = filename.split(sep).join('/');",
    "    if (rel === '' || rel.split('/').some((seg) => skip.has(seg))) return;",
    '    stat(join(root, filename), (error, info) => {',
    '        batch.push(error ? [rel, null, false] : [rel, info.mtimeMs, info.isDirectory()]);',
    '        if (timer === null) timer = setTimeout(flush, 20);',
    '    });',
    '});',
    "watcher.on('error', () => {});",
    "parentPort.on('message', (m) => { if (m === 'close') { watcher.close(); if (timer) clearTimeout(timer); flush(); process.exit(0); } });",
    "parentPort.postMessage('ready');",
    // THE CATCH-UP (Tynn #539): what was written between the watch being asked for and this watch being up, found here,
    // off genie-host's thread: every file (ignored folders skipped) changed since then, as the watch would have said it.
    'const catchUp = async () => {',
    "    const dirs = [''];",
    '    let entries = 0;',
    '    while (dirs.length > 0 && entries < limit) {',
    '        const dir = dirs.pop();',
    '        let list;',
    '        try { list = await readdir(join(root, dir), { withFileTypes: true }); } catch { continue; }',
    '        for (const e of list) {',
    '            if (skip.has(e.name)) continue;',
    "            const rel = dir === '' ? e.name : dir + '/' + e.name;",
    '            entries += 1;',
    '            if (e.isDirectory()) { dirs.push(rel); continue; }',
    '            try {',
    '                const info = await statAsync(join(root, rel));',
    '                if (info.mtimeMs >= since) { batch.push([rel, info.mtimeMs, false]); if (timer === null) timer = setTimeout(flush, 20); }',
    '            } catch { /* gone again: its own event says so */ }',
    '        }',
    '    }',
    '};',
    'void catchUp();',
].join('\n');

/**
 * How far before the watch was asked for the catch-up looks: Linux stamps a file's time from a coarse clock that can lag
 * Date.now() by a tick (4-10 ms), so a write just after the ask could carry an earlier time. Only that far, never seconds:
 * at 2 s the catch-up reported again an edit made 700 ms before the ask, one the views had already been told about, as a
 * change of its own — an extra batch, git run and push (files-watch-cdp, red on both OSes until this was 50).
 */
export const CATCH_UP_SLACK_MS = 50;
/** At most this many entries walked by one catch-up: a bound, never reached by a workspace whose build output is ignored. */
export const CATCH_UP_LIMIT = 100_000;

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
        const onThisThread = () => (options.fallback ?? nodeWatchSource)(root, onPath);
        let closed = false;
        let worker: Pick<Worker, 'on' | 'postMessage' | 'terminate'>;
        /*
         * NO WATCH ON THIS THREAD while the worker starts (Tynn #539): on Linux starting one scans the whole workspace on
         * genie-host's thread, and on Windows it takes a build's change events here until the worker is up. A write the
         * moment the watch is asked for is found by the worker's own catch-up instead. A worker that cannot start, fails,
         * or ends on its own is replaced by the watch on this thread: a watch is never simply lost.
         */
        let here: { close(): void } | null = null;
        let kept = false;
        const fallBack = (why: string) => {
            if (closed || kept) return;
            kept = true;
            options.log?.(`files watch: the watcher's own thread ${why}; watching on genie-host's thread`);
            here ??= onThisThread();
        };
        try {
            const start = options.startWorker ?? ((source, workerData) => new Worker(source, { eval: true, workerData }));
            worker = start(WATCH_WORKER_SOURCE, { root, ignored: [...IGNORED_NAMES], since: Date.now() - CATCH_UP_SLACK_MS, limit: CATCH_UP_LIMIT });
        } catch (error) {
            fallBack(`could not start (${error instanceof Error ? error.message : String(error)})`);
            return { close: () => { closed = true; here?.close(); } };
        }
        worker.on('message', (batch: unknown) => {
            if (closed || kept) return;
            if (batch === 'ready') return;
            if (!Array.isArray(batch)) return;
            for (const [name, mtimeMs, isDirectory] of batch as Array<[string, number | null, boolean]>) {
                const rel = confine(root, name);
                if (rel === null || rel === '') continue;
                if (countsAsDiskChange(mtimeMs === null ? null : { mtimeMs, isDirectory }, since)) onPath(rel);
            }
        });
        worker.on('error', (error) => { fallBack(`failed (${error instanceof Error ? error.message : String(error)})`); });
        worker.on('exit', (code) => { if (!closed) fallBack(`ended (exit ${String(code)})`); });
        return { close: () => {
            if (closed) return; closed = true; here?.close(); here = null;
            try { worker.postMessage('close'); } catch { /* already gone */ }
            setTimeout(() => { void worker.terminate(); }, 1_000).unref?.();
        } };
    };
}
