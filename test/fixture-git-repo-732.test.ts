import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initFixtureRepo } from '../scripts/fixture-git-repo.mjs';
import { windowsFunction, windowsPs1 } from './helpers/ci-scripts.js';

/**
 * THE FILES-WATCH FIXTURE'S GIT ON A FRESH WINDOWS VM (Tynn #732). The row failed on `spawnSync git ETIMEDOUT` (15 s) at
 * the fixture's own `git init` / `git add` / `git commit`. Measured in the row on Azure (queue items 1119-173835-3a5952,
 * 1119-180221-2b163b): the FIRST git calls on a VM are slow with the CPU and disk idle (init up to 15.4 s, add 2.3 s,
 * commit 1.2-7.6 s), every later one 60-130 ms; no earlier row left anything running, and Defender is kept out of both
 * the tree and git. The commit's share is git's own auto-maintenance child (`git maintenance run --auto --detach`), a
 * separate, never-run executable whose first start took up to 4.8 s before its main().
 *
 * Two fixes, at their causes: the fixture's repos are the test's own, so git's auto-maintenance (and auto-gc), which
 * plays no part in what files-watch checks, is off in them; and the Windows job warms git once before any row runs,
 * saying how long that took, so the VM's first-run cost is paid and seen outside a timed row.
 */

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A fresh workspace with one file, and a git runner that records git's trace2 events (child processes included). */
function workspace() {
    const root = mkdtempSync(join(tmpdir(), 'fixture-git-732-'));
    roots.push(root);
    const ws = join(root, 'ws');
    mkdirSync(ws);
    writeFileSync(join(ws, 'watched.txt'), 'baseline');
    const trace = join(root, 'trace2.txt');
    const git = (args: readonly string[]) => execFileSync('git', ['-c', 'user.name=Watch fixture', '-c', 'user.email=watch@example.test', ...args],
        { cwd: ws, encoding: 'utf8', stdio: 'pipe', timeout: 60_000, env: { ...process.env, GIT_TRACE2_EVENT: trace } });
    const children = () => { try { return readFileSync(trace, 'utf8').split('\n').filter((l) => l.includes('"event":"child_start"')); } catch { return []; } };
    return { ws, git, children };
}

describe("the files-watch fixture's repo (Tynn #732)", () => {
    it("CONTROL: a plain init, add and commit starts git's auto-maintenance child, so the gauge below can see one", () => {
        const { git, children } = workspace();
        git(['init']); git(['add', '.']); git(['commit', '-m', 'watch baseline']);
        expect(children().some((l) => l.includes('maintenance'))).toBe(true);
    });

    it('the fixture repo is made, committed, with auto-maintenance and auto-gc off, and its commit starts no child process', () => {
        const { git, children } = workspace();
        initFixtureRepo(git, 'watch baseline');
        expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe('1');
        expect(git(['config', '--get', 'maintenance.auto']).trim()).toBe('false');
        expect(git(['config', '--get', 'gc.auto']).trim()).toBe('0');
        expect(children()).toEqual([]);
    });

    it('files-watch makes its repo with it', () => {
        const src = readFileSync(new URL('../scripts/files-watch-cdp.mjs', import.meta.url), 'utf8');
        expect(src).toMatch(/import \{ initFixtureRepo \} from '\.\/fixture-git-repo\.mjs'/);
        expect(src).toMatch(/initFixtureRepo\(git, 'watch baseline'\)/);
    });
});

describe('the Windows job warms git before any row (Tynn #732)', () => {
    it('Warm-Git makes a throwaway repo with a commit (its maintenance child too) and prints how long each step took', () => {
        const warm = windowsFunction('Warm-Git');
        expect(warm).toMatch(/git init/);
        expect(warm).toMatch(/git .*add/);
        expect(warm).toMatch(/git .*commit/);
        expect(warm).toMatch(/--- git warmed/);
    });

    it('it runs once, before the row loop', () => {
        const call = windowsPs1.search(/^Warm-Git\b/m);
        const loop = windowsPs1.indexOf('$script:RowResults = [ordered]@{}');
        expect(call).toBeGreaterThan(-1);
        expect(call).toBeLessThan(loop);
    });
});
