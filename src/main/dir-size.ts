import { Worker } from 'node:worker_threads';

/**
 * HOW BIG A FOLDER IS, OFF GENIE-HOST'S THREAD (Tynn #697). A workspace can hold hundreds of thousands of files; walking
 * them on the host's thread would stall every window it serves. The walk runs in a worker, and is bounded: it stops after
 * `maxEntries` entries or `deadlineMs`, and says so (`truncated`), so a size is never a hang.
 *
 * It NEVER FOLLOWS A LINK: entries are read with `lstat` semantics (`readdir` withFileTypes, then `lstat` for size), and a
 * symlink, which is how Node reports a Windows junction too, is neither entered nor counted. A link to a huge folder outside
 * the workspace adds nothing, and the walk cannot leave the folder it was given.
 */
export interface DirSize { readonly bytes: number; readonly files: number; readonly truncated: boolean; /** Newest file modification time, ms; null when there is no file. */ readonly newest: number | null }

export interface SizeOptions {
    readonly maxEntries?: number;
    readonly deadlineMs?: number;
    /** Tests: how the worker is started (default: an eval worker of {@link SIZE_WORKER_SOURCE}). */
    readonly startWorker?: (source: string, workerData: unknown) => Pick<Worker, 'on' | 'terminate'>;
}

export const SIZE_MAX_ENTRIES = 500_000;
export const SIZE_DEADLINE_MS = 60_000;

/**
 * The worker's source, as text run with `eval`: a literal, never a function's `toString()`, which the bundler rewrites
 * (main/files-watch-worker.ts measured that).
 */
export const SIZE_WORKER_SOURCE = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const { readdir, lstat } = require('node:fs/promises');",
    "const { join } = require('node:path');",
    'const { root, maxEntries, deadline } = workerData;',
    'const walk = async () => {',
    '    let bytes = 0, files = 0, entries = 0, truncated = false, newest = null;',
    '    let top;',
    '    try { top = await lstat(root); } catch { return { bytes, files, truncated, newest }; }',
    '    if (top.isSymbolicLink()) return { bytes, files, truncated, newest };',
    '    if (!top.isDirectory()) return { bytes: top.size, files: 1, truncated, newest: top.mtimeMs };',
    '    const dirs = [root];',
    '    while (dirs.length > 0) {',
    '        if (entries >= maxEntries || Date.now() > deadline) { truncated = true; break; }',
    '        const dir = dirs.pop();',
    '        let list;',
    '        try { list = await readdir(dir, { withFileTypes: true }); } catch { continue; }',
    '        for (const e of list) {',
    '            entries += 1;',
    '            if (entries > maxEntries) { truncated = true; break; }',
    '            if (e.isSymbolicLink()) continue;',
    '            const full = join(dir, e.name);',
    '            if (e.isDirectory()) { dirs.push(full); continue; }',
    '            if (!e.isFile()) continue;',
    '            try { const s = await lstat(full); if (s.isFile()) { bytes += s.size; files += 1; if (newest === null || s.mtimeMs > newest) newest = s.mtimeMs; } } catch { }',
    '        }',
    '    }',
    '    return { bytes, files, truncated, newest };',
    '};',
    "walk().then((r) => parentPort.postMessage(r), (e) => parentPort.postMessage({ error: String(e && e.message || e) }));",
].join('\n');

/** The size of `path` (a folder's files, or a file), walked in a worker; links are never followed. */
export function sizeOf(path: string, options: SizeOptions = {}): Promise<DirSize> {
    const maxEntries = options.maxEntries ?? SIZE_MAX_ENTRIES;
    const deadlineMs = options.deadlineMs ?? SIZE_DEADLINE_MS;
    const start = options.startWorker ?? ((source, workerData) => new Worker(source, { eval: true, workerData }));
    return new Promise((resolve, reject) => {
        let settled = false;
        const worker = start(SIZE_WORKER_SOURCE, { root: path, maxEntries, deadline: Date.now() + deadlineMs });
        const finish = (fn: () => void) => { if (settled) return; settled = true; fn(); void worker.terminate(); };
        // A worker that never answers is ended a little after its own deadline.
        const timer = setTimeout(() => finish(() => resolve({ bytes: 0, files: 0, truncated: true, newest: null })), deadlineMs + 5_000);
        timer.unref?.();
        worker.on('message', (m: unknown) => {
            clearTimeout(timer);
            const r = m as Partial<DirSize> & { error?: string };
            if (typeof r.error === 'string') finish(() => reject(new Error(r.error)));
            else finish(() => resolve({ bytes: Number(r.bytes ?? 0), files: Number(r.files ?? 0), truncated: r.truncated === true, newest: typeof r.newest === 'number' ? r.newest : null }));
        });
        worker.on('error', (e: unknown) => { clearTimeout(timer); finish(() => reject(e instanceof Error ? e : new Error(String(e)))); });
        worker.on('exit', () => { clearTimeout(timer); finish(() => reject(new Error('the size walk ended without an answer'))); });
    });
}
