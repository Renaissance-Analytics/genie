import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FileAddedProps } from '../src/core/file-trigger.js';
import { startFileSource, type FileSourceDeps, type RawWatchEvent } from '../src/main/flow-file-source.js';

/**
 * THE FILE SOURCE (genie#1204 item 5): fs.watch events → `FileAddedProps`, the way Genie 1's `startFlowFileSource`
 * (main/flows/file-source.ts) did it, with its lessons kept:
 * - one creation is several `rename`s — collapsed, or a flow that MOVES the file runs again on a path that is gone;
 * - `rename` fires at zero bytes — the size is read once the file stops growing, or "over 5 MB" never fires for the
 *   very files the owner's example is about;
 * - a file that vanishes while settling was not added.
 * And two of Genie 2's: `.git`, `node_modules` and `vendor` are never a person adding a file; and a file the flow ITSELF
 * just moved in (`expectArrival`) is not a new addition — else a "move it to .untracked" flow chases its own tail.
 */

const ROOT = resolve('/', 'work', 'tynn'); // absolute, drive and all on Windows

function harness(over: Partial<FileSourceDeps> = {}) {
    let deliver: ((e: RawWatchEvent) => void) | null = null;
    const emitted: FileAddedProps[] = [];
    const source = startFileSource({
        subscribe: (l) => {
            deliver = l;
            return () => { deliver = null; };
        },
        statFile: () => ({ isFile: true, size: 6_000_000 }),
        emit: (e) => void emitted.push(e),
        settleMs: 0,
        wait: async () => {},
        ...over,
    });
    return {
        source,
        emitted,
        fire: (e: Partial<RawWatchEvent> = {}) => deliver?.({ workspaceId: 'tynn', workspacePath: ROOT, eventType: 'rename', relPath: 'big.bin', ...e }),
    };
}
/** The source settles asynchronously; let its microtasks drain. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the file source', () => {
    it('emits for a file added in a workspace', async () => {
        const h = harness();
        h.fire();
        await flush();
        expect(h.emitted).toEqual([{ workspaceId: 'tynn', path: join(ROOT, 'big.bin'), relPath: 'big.bin', name: 'big.bin', extension: 'bin', sizeBytes: 6_000_000 }]);
        h.source.stop();
    });

    it('waits for a file still being written, so the size it reports is the real one', async () => {
        const sizes = [0, 3_000_000, 6_000_000, 6_000_000];
        let i = 0;
        const h = harness({ statFile: () => ({ isFile: true, size: sizes[Math.min(i, sizes.length - 1)]! }), wait: async () => { i++; } });
        h.fire();
        await flush();
        expect(h.emitted.map((e) => e.sizeBytes)).toEqual([6_000_000]);
        h.source.stop();
    });

    it('a file that vanishes while it is settling was not added', async () => {
        let gone = false;
        const h = harness({ statFile: () => (gone ? null : { isFile: true, size: 10 }), wait: async () => { gone = true; } });
        h.fire();
        await flush();
        expect(h.emitted).toHaveLength(0);
        h.source.stop();
    });

    it('collapses the duplicate events one creation produces — a window, not a permanent mute (CONTROL: past it, it is new)', async () => {
        let now = 0;
        const h = harness({ dedupeMs: 500, now: () => now });
        h.fire();
        h.fire({ eventType: 'change' });
        h.fire();
        await flush();
        expect(h.emitted).toHaveLength(1);
        now += 501;
        h.fire();
        await flush();
        expect(h.emitted).toHaveLength(2);
        h.source.stop();
    });

    it('a late duplicate — after the file was accepted, inside the window — is still the same creation', async () => {
        // The case above is caught while the first report is still SETTLING; this one arrives after it was accepted
        // (a platform's close event, a size update) and only the window stops it.
        let now = 0;
        const h = harness({ dedupeMs: 500, now: () => now });
        h.fire();
        await flush();
        now += 200;
        h.fire();
        await flush();
        expect(h.emitted).toHaveLength(1);
        h.source.stop();
    });

    it('two different files at the same instant are two additions', async () => {
        const h = harness({ dedupeMs: 500, now: () => 0 });
        h.fire({ relPath: 'a.bin' });
        h.fire({ relPath: 'b.bin' });
        await flush();
        expect(h.emitted.map((e) => e.relPath).sort()).toEqual(['a.bin', 'b.bin']);
        h.source.stop();
    });

    it('.git, node_modules and vendor are never additions (CONTROL: the file beside them is)', async () => {
        const h = harness();
        h.fire({ relPath: '.git/objects/ab/cdef' });
        h.fire({ relPath: 'node_modules/x/index.js' });
        h.fire({ relPath: 'vendor/autoload.php' });
        await flush();
        expect(h.emitted).toHaveLength(0);
        h.fire({ relPath: 'uploads/a.png' });
        await flush();
        expect(h.emitted.map((e) => e.relPath)).toEqual(['uploads/a.png']);
        h.source.stop();
    });

    it('a file the flow itself moved in is not a new addition — once; the next file at that path is (CONTROL)', async () => {
        let now = 0;
        const h = harness({ dedupeMs: 500, now: () => now });
        h.source.expectArrival(join(ROOT, '.untracked/big.bin'));
        h.fire({ relPath: '.untracked/big.bin' });
        await flush();
        expect(h.emitted).toHaveLength(0);
        now += 10_000;
        h.fire({ relPath: '.untracked/big.bin' });
        await flush();
        expect(h.emitted.map((e) => e.relPath)).toEqual(['.untracked/big.bin']);
        h.source.stop();
    });

    it('an expected arrival that never comes does not mute that path for ever', async () => {
        let now = 0;
        const h = harness({ dedupeMs: 500, now: () => now });
        h.source.expectArrival(join(ROOT, 'later.bin'));
        now += 60_000;
        h.fire({ relPath: 'later.bin' });
        await flush();
        expect(h.emitted.map((e) => e.relPath)).toEqual(['later.bin']);
        h.source.stop();
    });

    it('an emit that throws does not stop the source (CONTROL: the next file still arrives)', async () => {
        const seen: string[] = [];
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const h = harness({ emit: (e) => { seen.push(e.relPath); if (e.relPath === 'bad.bin') throw new Error('runner down'); } });
        h.fire({ relPath: 'bad.bin' });
        await flush();
        h.fire({ relPath: 'good.bin' });
        await flush();
        expect(seen).toEqual(['bad.bin', 'good.bin']);
        error.mockRestore();
        h.source.stop();
    });

    it('stopping unsubscribes from the watcher', () => {
        const unsubscribe = vi.fn();
        const source = startFileSource({ subscribe: () => unsubscribe, statFile: () => null, emit: () => {} });
        source.stop();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
});
