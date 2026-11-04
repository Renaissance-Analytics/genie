import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustWatch } from '../src/main/trust-watch.js';

/**
 * WHAT MOVES A WORKSPACE'S VERDICT WHEN NOBODY ASKS: a pull changes a file the verdict reads, and a gate that does not
 * notice is no gate. Small, because a workstation may hold many workspaces: a few folders watched, one reading per file,
 * and no git at all (it has no way to run one). The verdict is read again only when one of those files really changed.
 * Files are a map; the real watcher and a real pull are in workspace-trust-wiring.test.ts.
 */

const W = join('/ws', 'acme');
const R = join(W, 'repos', 'one');

function rig(start: Record<string, string> = {}, options: { unwatchable?: boolean } = {}) {
    const files = new Map(Object.entries(start));
    const listeners = new Map<string, () => void>();
    const refreshed: string[] = [];
    const reads: string[] = [];
    const watch = new TrustWatch({
        workspaces: () => [{ id: 'acme', path: W }],
        readText: async (p) => files.get(p) ?? null,
        fingerprint: async (p) => { reads.push(p); const text = files.get(p); return text === undefined ? null : `stamp-${text}`; },
        watchFolder: (folder, changed) => {
            if (options.unwatchable) return null;
            listeners.set(folder, changed);
            return () => listeners.delete(folder);
        },
        refresh: (id) => refreshed.push(id),
        settleMs: 100,
    });
    return { watch, files, listeners, refreshed, reads };
}
const SETTINGS = join(W, '.claude', 'settings.json');

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('a pass', () => {
    it('the first only takes the readings; one with nothing changed reads the verdict no more', async () => {
        const t = rig({ [SETTINGS]: 'one' });
        await t.watch.pass();
        await t.watch.pass();
        expect(t.refreshed).toEqual([]);
    });

    it.each([
        ['a hook file', SETTINGS],
        ['the local one', join(W, '.claude', 'settings.local.json')],
        ['a server file', join(W, '.mcp.json')],
        ["Codex's", join(W, '.codex', 'config.toml')],
        ['the manifest', join(W, 'project.json')],
        ['a named script', join(W, 'package.json')],
        ['the git config', join(W, '.git', 'config')],
        ['the worktree git config', join(W, '.git', 'config.worktree')],
    ])('%s changed: once, and not again until it changes again', async (_name, file) => {
        const t = rig({ [file]: 'one' });
        await t.watch.pass();
        t.files.set(file, 'two');
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme']);
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme']);
    });

    it('a file added and a file removed both count', async () => {
        const t = rig({ [SETTINGS]: 'one' });
        await t.watch.pass();
        t.files.delete(SETTINGS);
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme']);
        t.files.set(join(W, '.mcp.json'), 'new');
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme', 'acme']);
    });

    it("a repo the manifest lists: its files count too, a submodule's git config where its .git file points", async () => {
        const gitdir = join(W, '.git', 'modules', 'one');
        const t = rig({
            [join(W, 'project.json')]: JSON.stringify({ repos: [{ name: 'one', path: 'repos/one' }] }),
            [join(R, '.claude', 'settings.json')]: 'one',
            [join(R, '.git')]: 'gitdir: ../../.git/modules/one\n',
            [join(gitdir, 'config')]: 'one',
        });
        await t.watch.pass();
        t.files.set(join(R, '.claude', 'settings.json'), 'two');
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme']);
        t.files.set(join(gitdir, 'config'), 'two');
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme', 'acme']);
    });

    it('reads a small fixed number of files for a workspace: not the tree', async () => {
        const t = rig({ [SETTINGS]: 'one' });
        await t.watch.pass();
        expect(t.reads.length).toBeLessThanOrEqual(10);
        expect(t.reads.length).toBeGreaterThan(0);
    });
});

describe('watching', () => {
    it('the folders those files are in, each alone: not the tree', async () => {
        const t = rig({ [SETTINGS]: 'one', [join(W, '.git', 'config')]: 'x' });
        await t.watch.pass();
        expect([...t.watch.watching].sort()).toEqual([W, join(W, '.claude'), join(W, '.git')].sort());
    });

    it('a change a watcher reports is read after it settles, and a burst is one reading of the verdict', async () => {
        const t = rig({ [SETTINGS]: 'one' });
        await t.watch.pass();
        t.files.set(SETTINGS, 'two');
        t.listeners.get(join(W, '.claude'))!();
        t.listeners.get(join(W, '.claude'))!();
        expect(t.refreshed).toEqual([]);
        await vi.advanceTimersByTimeAsync(100);
        expect(t.refreshed).toEqual(['acme']);
    });

    it("something else in the folder changed: a reading of the files, and the verdict is not read", async () => {
        const t = rig({ [SETTINGS]: 'one' });
        await t.watch.pass();
        t.listeners.get(W)!();
        await vi.advanceTimersByTimeAsync(100);
        expect(t.refreshed).toEqual([]);
    });

    it('a folder that appears is watched from then: the first hook file in a workspace that had none', async () => {
        const t = rig({ [join(W, 'project.json')]: '{}' });
        await t.watch.pass();
        expect(t.watch.watching).not.toContain(join(W, '.claude'));
        t.files.set(SETTINGS, 'one');
        t.listeners.get(W)!();
        await vi.advanceTimersByTimeAsync(100);
        expect(t.refreshed).toEqual(['acme']);
        expect(t.watch.watching).toContain(join(W, '.claude'));
    });

    it('where a folder cannot be watched, the slow pass still sees it', async () => {
        const t = rig({ [SETTINGS]: 'one' }, { unwatchable: true });
        await t.watch.pass();
        expect(t.watch.watching).toEqual([]);
        t.files.set(SETTINGS, 'two');
        await t.watch.pass();
        expect(t.refreshed).toEqual(['acme']);
    });

    it('stopped: no watcher left, a settling change is dropped, and a pass does nothing', async () => {
        const t = rig({ [SETTINGS]: 'one' });
        await t.watch.pass();
        t.files.set(SETTINGS, 'two');
        t.listeners.get(join(W, '.claude'))!();
        t.watch.stop();
        expect(t.listeners.size).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        await t.watch.pass();
        expect(t.refreshed).toEqual([]);
    });
});
