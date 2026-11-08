import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
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
        const fromWorker = vi.fn(), ready = vi.fn();
        // The real worker, with its batches counted: a watch that ran on this thread instead would report with none. And NO
        // watch on this thread at all (Tynn #539): on Linux starting one scans the whole workspace on genie-host's thread.
        const fallback = vi.fn(() => ({ close: () => {} }));
        const source = workerWatchSource({ fallback, startWorker: (code, data) => { const w = new Worker(code, { eval: true, workerData: data }); w.on('message', (m) => { if (Array.isArray(m)) fromWorker(m); else if (m === 'ready') ready(); }); return w; } });
        const seen: string[] = [];
        const handle = source(root, (rel) => seen.push(rel));
        await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 5_000, interval: 20 }); // the worker's watch is up
        await writeFile(join(root, 'node_modules', 'x', 'index.js'), 'ignored');
        await writeFile(join(root, 'src', 'a.ts'), 'seen');
        await vi.waitFor(() => expect(seen).toContain('src/a.ts'), { timeout: 5_000, interval: 50 });
        // From the worker's batches, and never a watch on this thread.
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

    it('a write the moment the watch is asked for is seen, with no watch on this thread: the worker catches up on its start', async () => {
        root = await mkdtemp(join(tmpdir(), 'genie-watch-worker-'));
        await mkdir(join(root, 'deep', 'er'), { recursive: true });
        const seen: string[] = [];
        const fallback = vi.fn(() => ({ close: () => {} }));
        const handle = workerWatchSource({ fallback })(root, (rel) => seen.push(rel));
        // Before the worker's own watch can be up.
        await writeFile(join(root, 'at-once.txt'), 'seen');
        await writeFile(join(root, 'deep', 'er', 'nested.txt'), 'seen');
        await vi.waitFor(() => { expect(seen).toContain('at-once.txt'); expect(seen).toContain('deep/er/nested.txt'); }, { timeout: 5_000, interval: 50 });
        expect(fallback).not.toHaveBeenCalled();
        handle.close();
    });

    it('the catch-up does not report a file written well before the watch was asked for (files-watch-cdp: one batch per edit)', async () => {
        root = await mkdtemp(join(tmpdir(), 'genie-watch-worker-'));
        // As files-watch-cdp's phases: the last edit 700 ms before the next view's watch; and one stamped by a coarse clock
        // a few ms behind the ask (Linux), which the catch-up must still report.
        await writeFile(join(root, 'earlier.txt'), 'before the ask');
        await writeFile(join(root, 'coarse.txt'), 'at the ask');
        const now = Date.now();
        await utimes(join(root, 'earlier.txt'), new Date(now - 700), new Date(now - 700));
        await utimes(join(root, 'coarse.txt'), new Date(now - 5), new Date(now - 5));
        const seen: string[] = [], ready = vi.fn();
        const handle = workerWatchSource({ fallback: vi.fn(() => ({ close: () => {} })), startWorker: (code, data) => { const w = new Worker(code, { eval: true, workerData: data }); w.on('message', (m) => { if (m === 'ready') ready(); }); return w; } })(root, (rel) => seen.push(rel));
        await vi.waitFor(() => expect(seen).toContain('coarse.txt'), { timeout: 5_000, interval: 20 });
        await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 5_000, interval: 20 });
        await new Promise((r) => setTimeout(r, 300));
        expect(seen).not.toContain('earlier.txt');
        handle.close();
    });

    it('a worker that ends on its own leaves the watch on this thread in place, said once', async () => {
        const log = vi.fn(), closedHere = vi.fn(), fallback = vi.fn(() => ({ close: closedHere }));
        const source = workerWatchSource({ log, fallback, startWorker: () => new Worker('process.exit(3)', { eval: true }) });
        const handle = source('/w', () => {});
        // The worker's end is said once, and the watch on this thread takes over (started once, not restarted).
        await vi.waitFor(() => expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('ended (exit 3)')), { timeout: 5_000, interval: 20 });
        expect(fallback).toHaveBeenCalledOnce();
        expect(closedHere).not.toHaveBeenCalled();
        handle.close();
        expect(closedHere).toHaveBeenCalledOnce();
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
