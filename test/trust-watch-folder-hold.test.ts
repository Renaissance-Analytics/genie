import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, watch as watchFolderForReal, writeFileSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrustWatch, watchOneFolder } from '../src/main/trust-watch.js';

/**
 * A FOLDER A PERSON CAN'T RENAME BECAUSE GENIE IS WATCHING IT IS A BUG. With the real watchers on a workspace, its parent
 * can be renamed, and the workspace moved and deleted. What each attempt answered is in the assertion. Measured on a
 * Windows runner: with a watcher there, renaming either is EPERM (deleting is not stopped). So Windows does not watch them.
 */

let root: string;
let parent: string;
let workspace: string;
let watch: TrustWatch;
let list: Array<{ id: string; path: string }>;

/** 'ok', or what the system said. */
const attempt = (act: () => void): string => {
    try { act(); return 'ok'; } catch (error) { return (error as NodeJS.ErrnoException).code ?? String(error); }
};

beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'trust-hold-'));
    parent = join(root, 'parent');
    workspace = join(parent, 'acme');
    mkdirSync(join(workspace, '.claude'), { recursive: true });
    mkdirSync(join(workspace, '.git'), { recursive: true });
    writeFileSync(join(workspace, '.claude', 'settings.json'), '{}');
    writeFileSync(join(workspace, '.git', 'config'), '');
    list = [{ id: 'acme', path: workspace }];
    watch = new TrustWatch({
        workspaces: () => list,
        readText: (p) => readFile(p, 'utf8').catch(() => null),
        fingerprint: (p) => stat(p).then((i) => `${i.mtimeMs}:${i.size}`, () => null),
        watchFolder: watchOneFolder,
        refresh: () => {},
        settleMs: 50,
    });
    await watch.pass();
    expect(watch.watching.length).toBe(process.platform === 'win32' ? 0 : 3);
});
afterEach(async () => {
    watch.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

describe('with the watchers on', () => {
    it("the workspace's parent can be renamed", () => {
        expect(attempt(() => renameSync(parent, join(root, 'moved')))).toBe('ok');
    });

    it('the workspace can be moved', () => {
        expect(attempt(() => renameSync(workspace, join(root, 'acme-moved')))).toBe('ok');
    });

    it('the workspace can be deleted, and its name used again at once', () => {
        expect(attempt(() => rmSync(workspace, { recursive: true, force: true }))).toBe('ok');
        expect(existsSync(workspace)).toBe(false);
        expect(attempt(() => mkdirSync(workspace))).toBe('ok');
    });

    it.runIf(process.platform === 'win32')('CONTROL: why Windows has no watchers. One on the workspace holds its parent', () => {
        const watcher = watchFolderForReal(workspace, () => {});
        try {
            expect(attempt(() => renameSync(parent, join(root, 'moved')))).not.toBe('ok');
        } finally {
            watcher.close();
        }
    });

    it.runIf(process.platform === 'win32')('CONTROL: what these rows can see. A process with its folder there does hold the parent', async () => {
        const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: workspace, stdio: 'ignore', windowsHide: true });
        await new Promise((r) => holder.once('spawn', r));
        const gone = new Promise((r) => holder.once('exit', r));
        try {
            expect(attempt(() => renameSync(parent, join(root, 'moved')))).not.toBe('ok');
        } finally {
            holder.kill();
            await gone;
        }
    }, 20_000);
});

describe('Genie lets go', () => {
    it('a workspace removed: its watchers are gone at the next pass, and its folder moves', async () => {
        list = [];
        await watch.pass();
        expect(watch.watching).toEqual([]);
        expect(attempt(() => renameSync(parent, join(root, 'moved')))).toBe('ok');
    });

    it('at quit', () => {
        watch.stop();
        expect(watch.watching).toEqual([]);
        expect(attempt(() => renameSync(parent, join(root, 'moved')))).toBe('ok');
    });
});
