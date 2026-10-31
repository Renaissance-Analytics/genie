import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FileAddedProps } from '../src/core/file-trigger.js';
import { startFileSource, type FileSourceDeps, type RawWatchEvent } from '../src/main/flow-file-source.js';

/**
 * THE FILE SOURCE (genie#1204 item 5): fs.watch events → `FileAddedProps`, the way Genie 1's `startFlowFileSource`
 * (main/flows/file-source.ts) did it, with its lessons kept:
 * - one creation is several `rename`s — collapsed, or a flow that MOVES the file runs again on a path that is gone;
 * - `rename` fires at zero bytes — the size is read once the file is FINISHED, or "over 5 MB" never fires for the very
 *   files the owner's example is about;
 * - a file that vanishes while settling was not added.
 * And two of Genie 2's: `.git`, `node_modules` and `vendor` are never a person adding a file; and a file the flow ITSELF
 * just moved in (`expectArrival`) is not a new addition — else a "move it to .untracked" flow chases its own tail.
 *
 * "FINISHED" (genie#1361): Genie 1's rule — two equal sizes 250 ms apart — judged a file created empty, or one whose
 * writer paused, finished at 0 bytes or half-written, and never looked again. Finished now means QUIET: no watch event
 * for the path for a quiet window, two readings agreeing on size and mtime, and never 0 bytes.
 *
 * Every case runs on a FAKE CLOCK (`wait` and `now` injected): the writer's timing is the test's, exactly, and no case
 * waits on real time or depends on the machine's load.
 */

const ROOT = resolve('/', 'work', 'tynn'); // absolute, drive and all on Windows

/** The source's time: `wait` resolves only when the test advances past it, in order. */
class FakeClock {
    t = 0;
    readonly #waiters: Array<{ at: number; resolve: () => void }> = [];
    readonly now = () => this.t;
    readonly wait = (ms: number) => new Promise<void>((r) => { this.#waiters.push({ at: this.t + ms, resolve: r }); });
    /** Move time forward by `ms`, waking each wait at its own instant and letting the source run in between. */
    async advance(ms: number): Promise<void> {
        const end = this.t + ms;
        for (;;) {
            await drain();
            this.#waiters.sort((a, b) => a.at - b.at);
            const next = this.#waiters[0];
            if (!next || next.at > end) break;
            this.#waiters.shift();
            this.t = Math.max(this.t, next.at);
            next.resolve();
        }
        this.t = end;
        await drain();
    }
}
/** Let the source's promise chains settle (it awaits only the injected `wait`). */
const drain = () => new Promise((r) => setTimeout(r, 0));

/** One file on a fake disk: what `statFile` reads. */
class FakeFile {
    size: number;
    mtimeMs: number;
    exists = true;
    constructor(size: number, at: number) { this.size = size; this.mtimeMs = at; }
}

const TICK = 250;
const QUIET = 1000;

function harness(over: Partial<FileSourceDeps> & { size?: number } = {}) {
    const clock = new FakeClock();
    const files = new Map<string, FakeFile>();
    let deliver: ((e: RawWatchEvent) => void) | null = null;
    const emitted: FileAddedProps[] = [];
    const { size = 6_000_000, ...deps } = over;
    const source = startFileSource({
        subscribe: (l) => {
            deliver = l;
            return () => { deliver = null; };
        },
        statFile: (abs) => {
            const f = files.get(abs);
            return f && f.exists ? { isFile: true, size: f.size, mtimeMs: f.mtimeMs } : null;
        },
        emit: (e) => void emitted.push(e),
        tickMs: TICK,
        quietMs: QUIET,
        wait: clock.wait,
        now: clock.now,
        ...deps,
    });
    const fire = (e: Partial<RawWatchEvent> = {}) => deliver?.({ workspaceId: 'tynn', workspacePath: ROOT, eventType: 'rename', relPath: 'big.bin', ...e });
    const file = (relPath = 'big.bin') => {
        const abs = join(ROOT, relPath);
        let f = files.get(abs);
        if (!f) { f = new FakeFile(0, clock.t); files.set(abs, f); }
        return f;
    };
    return {
        source,
        clock,
        emitted,
        fire,
        file,
        /** A file appears at `relPath` with `bytes` in it: the watcher's `rename`. */
        create(relPath = 'big.bin', bytes = size) {
            const f = file(relPath);
            f.exists = true;
            f.size = bytes;
            f.mtimeMs = clock.t;
            fire({ relPath, eventType: 'rename' });
        },
        /** The writer writes: the size and mtime move, and the watcher reports a `change`. */
        write(relPath: string, bytes: number) {
            const f = file(relPath);
            f.size = bytes;
            f.mtimeMs = clock.t;
            fire({ relPath, eventType: 'change' });
        },
        sizes: () => emitted.map((e) => e.sizeBytes),
    };
}
/** Advance a reading at a time until `n` additions are out (bounded): the instant of acceptance, whatever the rule's timing. */
async function untilEmitted(h: ReturnType<typeof harness>, n: number): Promise<void> {
    for (let i = 0; i < 100 && h.emitted.length < n; i++) await h.clock.advance(TICK);
    expect(h.emitted).toHaveLength(n);
}
/** Long enough for any settle in these cases to finish: the quiet window, a reading either side, and some. */
const SETTLED = QUIET + 3 * TICK;

describe('the file source', () => {
    it('emits for a file added in a workspace', async () => {
        const h = harness();
        h.create();
        await h.clock.advance(SETTLED);
        expect(h.emitted).toEqual([{ workspaceId: 'tynn', path: join(ROOT, 'big.bin'), relPath: 'big.bin', name: 'big.bin', extension: 'bin', sizeBytes: 6_000_000 }]);
        h.source.stop();
    });

    it('waits for a file still being written, so the size it reports is the real one', async () => {
        const h = harness();
        h.create('big.bin', 0);
        for (const bytes of [3_000_000, 6_000_000]) {
            await h.clock.advance(100);
            h.write('big.bin', bytes);
        }
        await h.clock.advance(SETTLED);
        expect(h.sizes()).toEqual([6_000_000]);
        h.source.stop();
    });

    it('a file that vanishes while it is settling was not added', async () => {
        const h = harness();
        h.create('big.bin', 10);
        h.file().exists = false;
        h.fire({ eventType: 'rename' });
        await h.clock.advance(SETTLED);
        expect(h.emitted).toHaveLength(0);
        h.source.stop();
    });

    it('collapses the duplicate events one creation produces — a window, not a permanent mute (CONTROL: past it, it is new)', async () => {
        const h = harness({ dedupeMs: 500 });
        h.create();
        h.fire({ eventType: 'change' });
        h.fire();
        await h.clock.advance(SETTLED);
        expect(h.emitted).toHaveLength(1);
        await h.clock.advance(501);
        h.create();
        await h.clock.advance(SETTLED);
        expect(h.emitted).toHaveLength(2);
        h.source.stop();
    });

    it('a late duplicate — after the file was accepted, inside the window — is still the same creation', async () => {
        // The case above is caught while the first report is still SETTLING; this one arrives after it was accepted
        // (a platform's close event, a size update) and only the window stops it.
        const h = harness({ dedupeMs: 500 });
        h.create();
        await untilEmitted(h, 1);
        await h.clock.advance(200);
        h.fire();
        await h.clock.advance(SETTLED);
        expect(h.emitted).toHaveLength(1);
        h.source.stop();
    });

    it('two different files at the same instant are two additions', async () => {
        const h = harness({ dedupeMs: 500 });
        h.create('a.bin');
        h.create('b.bin');
        await h.clock.advance(SETTLED);
        expect(h.emitted.map((e) => e.relPath).sort()).toEqual(['a.bin', 'b.bin']);
        h.source.stop();
    });

    it('.git, node_modules and vendor are never additions (CONTROL: the file beside them is)', async () => {
        const h = harness();
        h.create('.git/objects/ab/cdef');
        h.create('node_modules/x/index.js');
        h.create('vendor/autoload.php');
        await h.clock.advance(SETTLED);
        expect(h.emitted).toHaveLength(0);
        h.create('uploads/a.png');
        await h.clock.advance(SETTLED);
        expect(h.emitted.map((e) => e.relPath)).toEqual(['uploads/a.png']);
        h.source.stop();
    });

    it('a file the flow itself moved in is not a new addition — once; the next file at that path is (CONTROL)', async () => {
        const h = harness({ dedupeMs: 500 });
        h.source.expectArrival(join(ROOT, '.untracked/big.bin'));
        h.create('.untracked/big.bin');
        await h.clock.advance(SETTLED);
        expect(h.emitted).toHaveLength(0);
        await h.clock.advance(10_000);
        h.create('.untracked/big.bin');
        await h.clock.advance(SETTLED);
        expect(h.emitted.map((e) => e.relPath)).toEqual(['.untracked/big.bin']);
        h.source.stop();
    });

    it('an expected arrival that never comes does not mute that path for ever', async () => {
        const h = harness({ dedupeMs: 500 });
        h.source.expectArrival(join(ROOT, 'later.bin'));
        await h.clock.advance(60_000);
        h.create('later.bin');
        await h.clock.advance(SETTLED);
        expect(h.emitted.map((e) => e.relPath)).toEqual(['later.bin']);
        h.source.stop();
    });

    it('an emit that throws does not stop the source (CONTROL: the next file still arrives)', async () => {
        const seen: string[] = [];
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const h = harness({ emit: (e) => { seen.push(e.relPath); if (e.relPath === 'bad.bin') throw new Error('runner down'); } });
        h.create('bad.bin');
        await h.clock.advance(SETTLED);
        h.create('good.bin');
        await h.clock.advance(SETTLED);
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

/**
 * genie#1361 — "A file is added" decided a file was finished while it was still being written. Each case is a writer
 * Genie 1's two-equal-readings rule got wrong, reproduced on the fake clock; the last is the control that a normal write
 * is still reported promptly.
 */
describe('the file source decides a file is finished only once it is quiet (genie#1361)', () => {
    it('a file CREATED EMPTY and written after a pause longer than a reading is reported once, at its full size', async () => {
        // `touch` then write; an app that opens the file and then fetches the content; a network copy.
        const h = harness();
        h.create('big.bin', 0);
        await h.clock.advance(2_000);
        expect(h.emitted).toEqual([]);
        h.write('big.bin', 2_000);
        await h.clock.advance(SETTLED);
        expect(h.sizes()).toEqual([2_000]);
        await h.clock.advance(60_000);
        expect(h.sizes()).toEqual([2_000]);
        h.source.stop();
    });

    it('a writer that PAUSES mid-file for longer than a reading is reported once, at the full size — never the partial one', async () => {
        // A copy over the network, a phone upload, a download that stalls.
        const h = harness();
        h.create('big.bin', 0);
        await h.clock.advance(50);
        h.write('big.bin', 1_000);
        await h.clock.advance(600);
        h.write('big.bin', 2_000);
        await h.clock.advance(SETTLED);
        expect(h.sizes()).toEqual([2_000]);
        h.source.stop();
    });

    it('a pause mid-file longer than a reading but inside the quiet window — the quiet window is what decides (CONTROL: equal sizes alone do not)', async () => {
        const h = harness();
        h.create('big.bin', 500);
        await h.clock.advance(QUIET - 100);
        expect(h.emitted).toEqual([]);
        h.write('big.bin', 900);
        await h.clock.advance(SETTLED);
        expect(h.sizes()).toEqual([900]);
        h.source.stop();
    });

    it('a 0-byte file is never reported as finished, however long it stays empty', async () => {
        const h = harness();
        h.create('empty.txt', 0);
        await h.clock.advance(10 * 60_000);
        expect(h.emitted).toEqual([]);
        h.source.stop();
    });

    it('a file that settled BELOW the size a flow wants, then grows past it, starts that flow once', async () => {
        // The emit answers whether any flow took the file (the scheduler: an armed trigger it matched).
        const offered: number[] = [];
        const h = harness({ emit: (e) => { offered.push(e.sizeBytes); return e.sizeBytes >= 1_000; } });
        h.create('grow.bin', 10);
        await h.clock.advance(SETTLED);
        expect(offered).toEqual([10]);
        await h.clock.advance(2_000);
        h.write('grow.bin', 2_000);
        await h.clock.advance(SETTLED);
        expect(offered).toEqual([10, 2_000]);
        // Taken: later writes to it are content changes, not additions.
        await h.clock.advance(1_000);
        h.write('grow.bin', 3_000);
        await h.clock.advance(SETTLED);
        expect(offered).toEqual([10, 2_000]);
        h.source.stop();
    });

    it('a file nobody took is not watched for ever: past the grace period its writes are content changes (CONTROL: inside it, they count)', async () => {
        const offered: number[] = [];
        const h = harness({ graceMs: 60_000, emit: (e) => { offered.push(e.sizeBytes); return false; } });
        h.create('small.bin', 10);
        await h.clock.advance(SETTLED);
        h.write('small.bin', 20);
        await h.clock.advance(SETTLED);
        expect(offered).toEqual([10, 20]);
        await h.clock.advance(60_000);
        h.write('small.bin', 30);
        await h.clock.advance(SETTLED);
        expect(offered).toEqual([10, 20]);
        h.source.stop();
    });

    it('a file STILL GROWING when the settle limit runs out is not reported at the size so far; it is reported once it goes quiet', async () => {
        const h = harness({ maxSettleMs: 2_000 });
        h.create('big.bin', 0);
        let bytes = 0;
        for (let t = 0; t < 8_000; t += 200) {
            await h.clock.advance(200);
            bytes += 100;
            h.write('big.bin', bytes);
            expect(h.emitted, `at ${h.clock.t} ms, still being written`).toEqual([]);
        }
        await h.clock.advance(SETTLED);
        expect(h.sizes()).toEqual([bytes]);
        h.source.stop();
    });

    it('CONTROL: a file written in one go is still reported promptly — within the quiet window and a reading', async () => {
        const h = harness();
        h.create('fast.bin', 4_096);
        h.write('fast.bin', 4_096);
        await h.clock.advance(QUIET + TICK);
        expect(h.sizes()).toEqual([4_096]);
        h.source.stop();
    });
});
