import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesHost } from '../src/main/files-host.js';

/**
 * A WRITE RIGHT AFTER watch() IS A CHANGE. Linux stamps file times from a coarse clock that lags Date.now(), so a
 * write made just after watch() can carry an earlier time; the host dropped it as "from before the watcher" (the
 * WSL suite timed out on it in 2 runs of 5). That filter is for macOS FSEvents replaying old writes, and applies
 * there only.
 */
let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-live-'));
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    await writeFile(join(root, 'src', 'deep', 'a.ts'), 'a\n');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('FilesHost.watch', () => {
    let host: FilesHost;
    beforeEach(() => { host = new FilesHost({ workspace: (id) => (id === 'tynn' ? { id: 'tynn', path: root } : null), agentsOf: () => [], eventsOf: () => [] }); });
    afterEach(async () => { await host.close(); });

    it('sees an edit to an existing nested file made right after watch() returns, within one second', async () => {
        await host.watch('tynn');
        await writeFile(join(root, 'src', 'deep', 'a.ts'), 'b\n');
        await vi.waitFor(async () => { expect((await host.state('tynn'))!.unreported).toEqual(['src/deep/a.ts']); }, { timeout: 1_000, interval: 20 });
    });

    it.runIf(process.platform === 'linux')('counts a change whose file time is earlier than the watcher start (the coarse clock, made certain)', async () => {
        const t0 = Date.now();
        await host.watch('tynn');
        const lagging = new Date(t0 - 5);
        await utimes(join(root, 'src', 'deep', 'a.ts'), lagging, lagging);
        await vi.waitFor(async () => { expect((await host.state('tynn'))!.unreported).toEqual(['src/deep/a.ts']); }, { timeout: 1_000, interval: 20 });
    });

    it('watches a folder made after the start: a file written in it is seen', async () => {
        await host.watch('tynn');
        await mkdir(join(root, 'later'));
        await new Promise((r) => setTimeout(r, 0));
        await vi.waitFor(async () => {
            await writeFile(join(root, 'later', 'b.ts'), `${Date.now()}\n`);
            expect((await host.state('tynn'))!.unreported).toContain('later/b.ts');
        }, { timeout: 1_000, interval: 50 });
    });
});
