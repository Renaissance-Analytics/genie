/**
 * ★ THE REFERENCE CASE, END TO END, ON A REAL FILESYSTEM.
 *
 * The owner's own example, which exercises the whole design in one:
 *
 *   > a file added anywhere in a workspace, and if it is over 5 MB it gets moved
 *   > into an untracked folder so the repo does not get heavy
 *
 * An event (file added), a prop (size), a filter (> 5 MB), an action (move).
 * Nothing is mocked below the Flow itself: a real `fs.watch` over a real temp
 * directory, the real producer, the real registry, the real loop guard, the real
 * dispatcher and the real first-party recipe. A real 6 MB file is written and a
 * real move is asserted.
 *
 * ## The Flow deliberately does NOT exclude its own destination
 *
 * It would be easy to write `none: [relPath startsWith .genie/large-files/]` and
 * call the loop solved. That would prove nothing — the destination folder is
 * inside the watched tree, so moving the file there DOES produce a second
 * "file added" over 5 MB, and the only thing standing between that and an
 * infinite move loop is the loop guard. Leaving the filter naive is what makes
 * this a test of the guard rather than of the author's carefulness.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onFileWatchEvent, stopAllWatchers, watchWorkspace } from '../../files/watch';
import { createFlowEventRegistry } from '../events';
import { startFlowFileSource } from '../file-source';
import { FlowLoopGuard } from '../loop';
import {
    RELOCATION_DIR_ARG,
    RELOCATE_FILE_RECIPE_ID,
    relocateFileRecipe,
} from '../builtin-recipes';
import { FlowRuntime, type FlowRunLog } from '../runtime';
import type { Flow } from '../types';

const FIVE_MB = 5 * 1024 * 1024;
const RELOCATION_DIR = '.genie/large-files';

const roots: string[] = [];
const stops: Array<() => void> = [];

function tempWorkspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-flow-'));
    roots.push(root);
    return fs.realpathSync(root);
}

async function until(predicate: () => boolean, ms = 20_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
}

function writeFileOfSize(target: string, bytes: number): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(bytes, 7));
}

/**
 * The file's contents, or `null` while it is not there — or not there YET.
 *
 * The recipe writes with `fsp.writeFile`, which is `open` then `write` then
 * `close` with event-loop turns in between, so there is a real window in which
 * the file EXISTS and holds nothing. A poll on `fs.existsSync` resolves inside
 * that window and hands the next assertion an empty string; measured on this
 * machine, ~4% of observations land there.
 *
 * So nothing below waits on existence. Waiting on the content collapses the
 * window: a file that is not there and a file that is not written yet are the
 * same answer, and the only thing that ends the wait is the thing the test came
 * to check.
 */
function readIfPresent(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/** The file's size, or `null` while it is not there. Never throws. */
function sizeIfPresent(file: string): number | null {
    try {
        return fs.statSync(file).size;
    } catch {
        return null;
    }
}

afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    stopAllWatchers();
    for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function startGenie(root: string) {
    const workspaceId = 'ws-reference';

    /**
     * The Flow, exactly as the owner described it. `all` is the whole filter —
     * see the note at the top of this file about why it does not exclude the
     * destination.
     */
    const flow: Flow = {
        id: 'flow-keep-repo-light',
        title: 'Keep the repo light',
        purpose: 'Files',
        scope: { kind: 'workspace', workspaceId },
        enabled: true,
        triggers: [
            { kind: 'manual' },
            {
                kind: 'event',
                event: 'files:added',
                filter: { all: [{ prop: 'sizeBytes', op: 'gt', value: FIVE_MB }] },
            },
        ],
        recipe: {
            kind: 'builtin',
            recipeId: RELOCATE_FILE_RECIPE_ID,
            args: { [RELOCATION_DIR_ARG]: RELOCATION_DIR },
        },
    };

    const logs: FlowRunLog[] = [];
    const runtime = new FlowRuntime({
        registry: createFlowEventRegistry(),
        guard: new FlowLoopGuard(),
        listFlows: () => [flow],
        resolveRecipe: (ref) =>
            ref.recipeId === RELOCATE_FILE_RECIPE_ID ? relocateFileRecipe : null,
        onLog: (log) => void logs.push(log),
    });

    const stopSource = startFlowFileSource({
        subscribe: onFileWatchEvent,
        statFile: (absPath) => {
            try {
                const s = fs.statSync(absPath);
                return { isFile: s.isFile(), size: s.size };
            } catch {
                return null;
            }
        },
        workspaceIdFor: (p) => (p === root ? workspaceId : undefined),
        emit: (event) => runtime.emit(event).then(() => undefined),
        settleMs: 40,
    });
    stops.push(stopSource);

    watchWorkspace(root);
    return { logs, runtime, flow };
}

/**
 * ★ THE INSTRUMENT, CHECKED BEFORE IT IS TRUSTED.
 *
 * Everything below waits for the filesystem to catch up, and what it waits FOR
 * decides what it can prove. `fs.existsSync` answers "was this created", which
 * is not the question any of these tests are actually asking.
 */
describe('waiting for a file', () => {
    it('tells a file that was CREATED from one that was WRITTEN', async () => {
        const root = tempWorkspace();
        const target = path.join(root, 'ignore-like.txt');

        // The window `fsp.writeFile` opens: open() has returned, write() has
        // not. The file is there and holds nothing.
        fs.writeFileSync(target, '');

        expect(
            await until(() => fs.existsSync(target), 150),
            'the file is there, so a poll must not still be waiting for it',
        ).toBe(true);
        expect(
            await until(() => readIfPresent(target)?.includes('*') === true, 150),
            'but being there is not being written — an empty file must not satisfy this',
        ).toBe(false);

        fs.writeFileSync(target, '# a comment\n*\n');

        expect(
            await until(() => readIfPresent(target)?.includes('*') === true, 2_000),
            'and once the content lands, it must',
        ).toBe(true);
    });
});

describe('the 5 MB reference case', () => {
    it('moves a large file into the untracked folder, and leaves a small one alone', async () => {
        const root = tempWorkspace();
        // Created BEFORE the watcher starts. A recursive watcher registers a
        // newly created subdirectory asynchronously on Linux, so a file written
        // in the same breath as its parent directory can be missed — an OS
        // behaviour, not a property of this feature, and not something a test of
        // this feature should be racing.
        fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
        const genie = startGenie(root);

        const big = path.join(root, 'assets', 'big.bin');
        const small = path.join(root, 'assets', 'small.bin');
        writeFileOfSize(big, 6 * 1024 * 1024);
        writeFileOfSize(small, 1024 * 1024);

        // Waits for the whole 6 MB, not for the name to appear. `move` renames
        // when it can, which is atomic — but its EXDEV fallback is copy+unlink,
        // and a copy in flight is a destination that exists and is short. The
        // assertion below is about the SIZE, so the wait is too.
        const relocated = path.join(root, RELOCATION_DIR, 'big.bin');
        expect(
            await until(() => sizeIfPresent(relocated) === 6 * 1024 * 1024),
            'the >5MB file should have been relocated, whole',
        ).toBe(true);

        expect(fs.existsSync(big), 'the original should be gone').toBe(false);
        expect(fs.statSync(relocated).size).toBe(6 * 1024 * 1024);

        // NEGATIVE CONTROL, with the positive one above: the 1 MB file was seen
        // by the same watcher, the same producer and the same Flow — and the
        // filter excluded it. Without the assertion above this would pass
        // against a Flow that never ran at all.
        expect(fs.existsSync(small), 'the small file should be untouched').toBe(true);
        expect(fs.existsSync(path.join(root, RELOCATION_DIR, 'small.bin'))).toBe(false);
    });

    it('makes the destination untracked, rather than trusting somebody to gitignore it', async () => {
        const root = tempWorkspace();
        startGenie(root);
        writeFileOfSize(path.join(root, 'big.bin'), 6 * 1024 * 1024);

        // Waits for the CONTENT, never for the file. `fsp.writeFile` creates it
        // empty first, and a poll on existence resolves in that window and then
        // reads nothing — see `readIfPresent` and the test above it.
        const ignore = path.join(root, RELOCATION_DIR, '.gitignore');
        expect(
            await until(() => readIfPresent(ignore)?.includes('*') === true),
            'the destination should have been made self-ignoring',
        ).toBe(true);
        // A self-ignoring folder: nothing in it is ever staged, and the user's
        // own root .gitignore is not edited behind their back.
        expect(fs.readFileSync(ignore, 'utf8')).toContain('*');
    });

    it('does not move the file it just moved — and still fires for the next one', async () => {
        const root = tempWorkspace();
        // The destination exists BEFORE the watcher starts, so the echo of the
        // move is guaranteed to be reported on every platform. Without this the
        // test could pass on Linux for the wrong reason — a recursive watcher
        // registers a new subdirectory asynchronously, so "no second move" could
        // mean "the guard worked" or "the event never arrived", and those two
        // are indistinguishable from the assertion.
        fs.mkdirSync(path.join(root, RELOCATION_DIR), { recursive: true });
        const genie = startGenie(root);

        writeFileOfSize(path.join(root, 'first.bin'), 6 * 1024 * 1024);
        const firstRelocated = path.join(root, RELOCATION_DIR, 'first.bin');
        expect(await until(() => fs.existsSync(firstRelocated))).toBe(true);

        // Long enough for the echo to have arrived and been judged. If the guard
        // were absent, the relocated file would be moved into
        // `.genie/large-files/.genie/large-files/` and on down.
        await new Promise((r) => setTimeout(r, 1_500));

        expect(fs.existsSync(firstRelocated), 'the relocated file stayed put').toBe(true);
        expect(
            fs.existsSync(path.join(root, RELOCATION_DIR, RELOCATION_DIR, 'first.bin')),
            'nothing was moved a second time',
        ).toBe(false);
        expect(
            genie.logs.filter((l) => l.outcome === 'ran'),
            'exactly one run for one file',
        ).toHaveLength(1);

        // ★ POSITIVE CONTROL. A guard that blocks everything passes every
        // assertion above while being useless. A genuinely new large file, added
        // after the echo, must still fire.
        writeFileOfSize(path.join(root, 'second.bin'), 6 * 1024 * 1024);
        const secondRelocated = path.join(root, RELOCATION_DIR, 'second.bin');
        expect(
            await until(() => fs.existsSync(secondRelocated)),
            'the loop guard must not be a blanket mute',
        ).toBe(true);
        expect(genie.logs.filter((l) => l.outcome === 'ran')).toHaveLength(2);
    });

    it('does not clobber a file already sitting in the destination', async () => {
        const root = tempWorkspace();
        const genie = startGenie(root);

        const parked = path.join(root, RELOCATION_DIR, 'big.bin');
        writeFileOfSize(parked, 16);
        await new Promise((r) => setTimeout(r, 300));

        writeFileOfSize(path.join(root, 'big.bin'), 6 * 1024 * 1024);
        expect(
            await until(() => {
                const entries = fs.existsSync(path.join(root, RELOCATION_DIR))
                    ? fs.readdirSync(path.join(root, RELOCATION_DIR))
                    : [];
                return entries.some((e) => e !== 'big.bin' && e.endsWith('.bin'));
            }),
        ).toBe(true);

        expect(fs.statSync(parked).size, 'the parked file was not overwritten').toBe(16);
    });
});
