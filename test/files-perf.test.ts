import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadsOpenFile } from '../src/core/files-panel.js';
import { FilesHost, IGNORED_NAMES, TREE_BUDGET, TREE_MAX_DEPTH, WATCH_BATCH_MS } from '../src/main/files-host.js';
import type { TreeNode } from '../src/core/files-panel.js';

/**
 * THE FILE BROWSER MUST NOT BOG THE MACHINE DOWN (genie#921, Tynn #803). The owner, 2026-10-17: "very slow and once open
 * it bogs down the whole machine … hard to switch screens"; Genie 1's was "clean and fast, had live updates and was
 * stable". Genie 2 walked the WHOLE workspace on every call and broadcast EVERY watcher event, and the panel re-walked on
 * each — an agent's build is thousands of events, so thousands of full walks.
 *
 * Genie 1's design, ported (v0.7.0-beta.342 main/files/ipc.ts, watch.ts, workspace/ignore.ts):
 *  - the tree is a BREADTH-FIRST walk with a shared entry budget and a depth cap — the root always lists all of its own
 *    children — and skips the ignore sets (`.git`, `node_modules`, `vendor`, `dist`, `build`, `.next`, …);
 *  - a change inside an ignored directory is not a change;
 *  - changes are coalesced into ONE notification per batch, carrying the paths that changed;
 *  - the open file is re-read only when it is one of them.
 */
let root: string;
let host: FilesHost;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-files-perf-'));
    host = new FilesHost({ workspace: (id) => (id === 'w' ? { id: 'w', path: root } : null), agentsOf: () => [], eventsOf: () => [] });
});
afterEach(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
});

const ids = (nodes: readonly TreeNode[]): string[] => nodes.flatMap((n) => [n.id, ...ids(n.children ?? [])]);

describe('the tree', () => {
    it('skips Genie 1’s ignore sets — dependency and build output — at any depth; CONTROL: real source is listed', async () => {
        expect([...IGNORED_NAMES].sort()).toEqual(['.cache', '.DS_Store', '.git', '.idea', '.next', '.nuxt', '.turbo', '.venv', '.vscode', 'Thumbs.db', '__pycache__', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target', 'vendor', 'venv'].sort());
        for (const dir of ['vendor/laravel', 'dist', 'build', '.next/cache', 'app/vendor/x', 'app/src']) await mkdir(join(root, dir), { recursive: true });
        for (const file of ['vendor/laravel/a.php', 'dist/app.js', 'build/x.o', '.next/cache/y', 'app/vendor/x/z.php', 'app/src/main.ts']) await writeFile(join(root, file), 'x');
        const all = ids((await host.tree('w'))!);
        expect(all).toContain('app/src/main.ts');
        expect(all.filter((id) => /(^|\/)(vendor|dist|build|\.next)(\/|$)/.test(id))).toEqual([]);
    });

    // The budget is INJECTED here (Genie's default stays TREE_BUDGET = 5000): writing 5,500 files took longer than the test's
    // 5 s on the Windows test VM (beta.30's check, 2026-10-17) — the fixture's cost, not the listing's. The same rule,
    // proven with a small budget, runs in milliseconds everywhere.
    it('a big workspace is capped by the budget, breadth-first: a huge folder never hides the root’s other entries', async () => {
        expect(TREE_BUDGET).toBe(5000);
        expect(TREE_MAX_DEPTH).toBe(6);
        const budget = 50;
        host = new FilesHost({ workspace: (id) => (id === 'w' ? { id: 'w', path: root } : null), agentsOf: () => [], eventsOf: () => [], treeBudget: budget });
        await mkdir(join(root, 'aaa-huge'), { recursive: true });
        await Promise.all(Array.from({ length: budget + 30 }, (_, i) => writeFile(join(root, 'aaa-huge', `f${i}.txt`), '')));
        await writeFile(join(root, 'zzz-readme.md'), '# hi');
        const all = ids((await host.tree('w'))!);
        expect(all.length).toBeLessThanOrEqual(budget);
        // CONTROL: the budget is what cut it — Genie's default budget lists every entry of the same folder (82).
        const unbounded = new FilesHost({ workspace: (id) => (id === 'w' ? { id: 'w', path: root } : null), agentsOf: () => [], eventsOf: () => [] });
        expect(ids((await unbounded.tree('w'))!)).toHaveLength(budget + 30 + 2);
        await unbounded.close();
        // The root's own children are listed before any folder's contents spend the budget.
        expect(all).toContain('zzz-readme.md');
        expect(all).toContain('aaa-huge');
    });

    it('the depth cap: a path deeper than it is not walked; CONTROL: one at the cap is', async () => {
        const deep = Array.from({ length: TREE_MAX_DEPTH + 2 }, (_, i) => `d${i}`).join('/');
        await mkdir(join(root, deep), { recursive: true });
        await writeFile(join(root, deep, 'too-deep.txt'), 'x');
        const atCap = Array.from({ length: TREE_MAX_DEPTH }, (_, i) => `d${i}`).join('/');
        await writeFile(join(root, atCap, 'at-cap.txt'), 'x');
        const all = ids((await host.tree('w'))!);
        expect(all).toContain(`${atCap}/at-cap.txt`);
        expect(all.some((id) => id.endsWith('too-deep.txt'))).toBe(false);
    });
});

describe('live updates, coalesced', () => {
    it('a burst of writes is ONE notification carrying every changed path (COUNTED), not one per event', async () => {
        expect(WATCH_BATCH_MS).toBe(250);
        const heard: Array<{ ws: string; paths: readonly string[] }> = [];
        host.onChange((ws, paths) => { heard.push({ ws, paths }); });
        await host.watch('w');
        await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(join(root, `burst${i}.ts`), `export const n = ${i};\n`)));
        await vi.waitFor(() => { expect(heard.flatMap((h) => h.paths).filter((p) => p.startsWith('burst')).length).toBeGreaterThanOrEqual(40); }, { timeout: 5_000, interval: 50 });
        // Every path, in as few notifications as the batch window allows — a 40-file burst is not 40 re-walks.
        expect(new Set(heard.flatMap((h) => h.paths).filter((p) => p.startsWith('burst'))).size).toBe(40);
        expect(heard.length).toBeLessThanOrEqual(3);
    });

    it('a change inside an ignored directory is not a change at all; CONTROL: one beside it is', async () => {
        await mkdir(join(root, 'vendor', 'pkg'), { recursive: true });
        await mkdir(join(root, 'dist'), { recursive: true });
        const heard: string[] = [];
        host.onChange((_ws, paths) => { heard.push(...paths); });
        await host.watch('w');
        await writeFile(join(root, 'vendor', 'pkg', 'a.php'), 'x');
        await writeFile(join(root, 'dist', 'app.js'), 'x');
        await writeFile(join(root, 'real.ts'), 'x');
        await vi.waitFor(() => { expect(heard).toContain('real.ts'); }, { timeout: 5_000, interval: 50 });
        expect(heard.filter((p) => p.startsWith('vendor/') || p.startsWith('dist/'))).toEqual([]);
        expect((await host.state('w'))!.unreported).toEqual(['real.ts']);
    });
});

describe('the open file', () => {
    it('is re-read only when it is among the changed paths; a notification without paths (an older host) re-reads it', () => {
        expect(reloadsOpenFile('src/a.ts', ['src/a.ts', 'b.ts'])).toBe(true);
        expect(reloadsOpenFile('src/a.ts', ['b.ts'])).toBe(false);
        expect(reloadsOpenFile('src/a.ts', undefined)).toBe(true);
    });
});
