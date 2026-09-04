/**
 * The watcher's main-side observer seam.
 *
 * `watchWorkspace` existed to keep the Code view's tree fresh, so everything it
 * learned went straight to `webContents.send` and nothing in main could hear it.
 * Genie Wishes need the same events with no window involved at all — a
 * system-triggered Wish runs whether or not anyone has Genie open.
 *
 * Rather than starting a SECOND recursive watcher over the same trees (twice the
 * inotify handles, two answers to "did that file appear"), the existing one
 * grows a listener seam. These tests cover what the seam has to get right: the
 * raw `eventType` survives (the wish source needs it to tell an addition from an
 * edit), the ignore rules still apply, and unwatching really stops it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onFileWatchEvent, stopAllWatchers, watchWorkspace, type FileWatchEvent } from '../watch';

const roots: string[] = [];

function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-watch-'));
    roots.push(root);
    return fs.realpathSync(root);
}

/** Wait until `predicate` holds, or give up. fs.watch delivery is asynchronous. */
async function until(predicate: () => boolean, ms = 5_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
}

afterEach(() => {
    stopAllWatchers();
    for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe('onFileWatchEvent', () => {
    it('reports a newly created file with its raw event type and relative path', async () => {
        const root = tempRoot();
        const seen: FileWatchEvent[] = [];
        const off = onFileWatchEvent((e) => seen.push(e));
        watchWorkspace(root);

        fs.writeFileSync(path.join(root, 'added.bin'), 'x');

        expect(await until(() => seen.some((e) => e.relPath === 'added.bin'))).toBe(true);
        const event = seen.find((e) => e.relPath === 'added.bin');
        expect(event?.workspacePath).toBe(root);
        expect(event?.eventType).toBe('rename');
        off();
    });

    it('drops events inside ignored directories', async () => {
        const root = tempRoot();
        fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
        const seen: FileWatchEvent[] = [];
        const off = onFileWatchEvent((e) => seen.push(e));
        watchWorkspace(root);

        fs.writeFileSync(path.join(root, 'node_modules', 'junk.bin'), 'x');
        // POSITIVE CONTROL: a real file written straight after. Without it, an
        // assertion that the ignored path never appeared would pass just as
        // happily against a watcher that reported nothing at all.
        fs.writeFileSync(path.join(root, 'real.bin'), 'x');

        expect(await until(() => seen.some((e) => e.relPath === 'real.bin'))).toBe(true);
        expect(seen.some((e) => e.relPath.includes('node_modules'))).toBe(false);
        off();
    });

    it('stops delivering once the listener is removed', async () => {
        const root = tempRoot();
        const seen: FileWatchEvent[] = [];
        const off = onFileWatchEvent((e) => seen.push(e));
        watchWorkspace(root);

        fs.writeFileSync(path.join(root, 'first.bin'), 'x');
        expect(await until(() => seen.some((e) => e.relPath === 'first.bin'))).toBe(true);

        off();
        const countAtRemoval = seen.length;
        fs.writeFileSync(path.join(root, 'second.bin'), 'x');
        await new Promise((r) => setTimeout(r, 300));
        expect(seen.length).toBe(countAtRemoval);
    });
});
