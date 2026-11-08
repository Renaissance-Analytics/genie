import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerWatchSource } from '../src/main/files-watch-worker.js';

/*
 * THE WATCHER OFF genie-host's THREAD (Tynn #524). genie-host was late up to 399 ms on the Windows runner during a
 * write-heavy build, idle in its profile, its few JS samples in the recursive watcher's change events. The watch and the
 * stat behind each change now run on a worker thread; what counts as a change is still decided on the host's thread.
 */

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

describe('workerWatchSource', () => {
    it('reports a written file from the worker thread, never a file in an ignored folder, and nothing after close', async () => {
        root = await mkdtemp(join(tmpdir(), 'genie-watch-worker-'));
        await mkdir(join(root, 'src'), { recursive: true });
        await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
        const fromWorker = vi.fn();
        // The real worker, with its messages counted: a watch that ran on this thread instead would report with none.
        const fallback = vi.fn(() => ({ close: () => {} }));
        const source = workerWatchSource({ fallback, startWorker: (code, data) => { const w = new Worker(code, { eval: true, workerData: data }); w.on('message', (m) => { if (Array.isArray(m)) fromWorker(m); }); return w; } });
        const seen: string[] = [];
        const handle = source(root, (rel) => seen.push(rel));
        await new Promise((r) => setTimeout(r, 300)); // the worker's watch is up
        await writeFile(join(root, 'node_modules', 'x', 'index.js'), 'ignored');
        await writeFile(join(root, 'src', 'a.ts'), 'seen');
        await vi.waitFor(() => expect(seen).toContain('src/a.ts'), { timeout: 5_000, interval: 50 });
        // From the worker's batches, not a fallback watch on this thread.
        expect(fromWorker).toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
        expect(seen.some((p) => p.startsWith('node_modules/'))).toBe(false);
        handle.close();
        await new Promise((r) => setTimeout(r, 200));
        const before = seen.length;
        await writeFile(join(root, 'src', 'after.ts'), 'not seen');
        await new Promise((r) => setTimeout(r, 500));
        expect(seen.length).toBe(before);
    });

    it('a worker that ends on its own is replaced by the watch on this thread, said once', async () => {
        const log = vi.fn(), fallback = vi.fn(() => ({ close: () => {} }));
        const source = workerWatchSource({ log, fallback, startWorker: () => new Worker('process.exit(3)', { eval: true }) });
        const handle = source('/w', () => {});
        await vi.waitFor(() => expect(fallback).toHaveBeenCalledOnce(), { timeout: 5_000, interval: 20 });
        expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('ended (exit 3)'));
        handle.close();
    });

    it('a worker that cannot start falls back to the watch on this thread, said once', () => {
        const log = vi.fn(), close = vi.fn(), fallback = vi.fn(() => ({ close }));
        const source = workerWatchSource({ log, fallback, startWorker: () => { throw new Error('no workers here'); } });
        const handle = source('/w', () => {});
        expect(fallback).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('no workers here'));
        handle.close();
        expect(close).toHaveBeenCalledOnce();
    });
});
