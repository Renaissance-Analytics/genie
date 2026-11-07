import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemProcessTree, type ProcessInfo, type ProcessTree } from '../src/core/process-tree.js';
import { GIT_READ_LIMIT, GitDidNotAnswer, withinGitLimit } from '../src/main/git-ports.js';
import { winLauncherPath } from '../src/main/win-launcher.js';

/*
 * A READ PAST ITS LIMIT ENDS ITS JOB BEFORE ANYTHING IN IT (Windows; genie-launch.exe's `job`, #1628/#1639).
 *
 * The launcher's job is kill-on-close, but only while git runs: native/win-launcher/genie-launch.c lifts the kill when
 * git ends by itself ("what it started is left as it would be without the job"), then closes the job. So if the limit
 * ends GIT before it ends the LAUNCHER, the launcher wakes, lifts the kill and exits, and everything git and its hook
 * started survives. The walk did exactly that: on Windows its first round ended every known process at once, launcher and
 * git each by its own taskkill. Which landed first was a race. Run 42363613581 lost it twice in 20 jobs: all 230 of
 * test/git-read-limit.test.tsx's forked children were still alive 40 s after the limit (runs 6 and 10).
 *
 * Here the race is not left to chance: the process tree's reap ends everything EXCEPT the launcher first, waits, then
 * ends the launcher. That is the order that lost. Whatever order the walk's reap uses, the read's launcher must already
 * be gone, its job closed with the kill in force, so nothing the hook started survives.
 */
const windows = process.platform === 'win32';
const MARK = `job-first-${process.pid}`;
const node = process.execPath.replace(/\\/g, '/');
let root = '';
let repo = '';
const savedLimit = GIT_READ_LIMIT.ms;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
/** This run's children, by the mark in their command lines: their pids. */
const oursPids = (): number[] => {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'node*' -and $_.CommandLine -and $_.CommandLine -like '*${MARK}*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    return out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
};
const ours = (): number => oursPids().length;

beforeEach(() => {
    if (!windows) return;
    root = mkdtempSync(join(tmpdir(), 'git-job-first-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    // 20 background children through MSYS sh (each from a fork process that exits at once: no walk by parent finds
    // them), each carrying the mark, then a wait, so git never answers by itself.
    const hook = join(root, 'forks.sh');
    writeFileSync(hook, `#!/bin/sh\ni=0\nwhile [ "$i" -lt 20 ]; do "${node}" -e "setInterval(() => {}, 1000)" ${MARK} & i=$((i+1)); done\nwait\n`);
    chmodSync(hook, 0o755);
    git('config', 'core.fsmonitor', hook.replace(/\\/g, '/'));
    GIT_READ_LIMIT.ms = 8_000;
});
afterEach(async () => {
    GIT_READ_LIMIT.ms = savedLimit;
    if (!windows) return;
    try {
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'node*' -and $_.CommandLine -and $_.CommandLine -like '*${MARK}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { timeout: 120_000, windowsHide: true, stdio: 'ignore' });
    } catch { /* none left */ }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

describe.skipIf(!windows)('a read past its limit ends its job before anything in it (Windows)', () => {
    it('with the launcher ended LAST by the reap, still none of what the hook started survives', async () => {
        // On Windows CI the launcher is built (npm run build:main): a missing one is a failure here, never a skip.
        expect(winLauncherPath(), 'genie-launch.exe is built').not.toBeNull();
        const isLauncher = (p: ProcessInfo) => /^genie-launch(\.exe)?$/i.test(p.name);
        // The hook's children are hidden from the walk's readings, as MSYS's are from a real one (its fork parents exit at
        // once: run 42308792264's walk found 31 of 230). Only the JOB can end them, which is the thing under test; with them
        // visible the walk ends them by parent and the job never matters (the first version of this row passed on the
        // unfixed code that way, run 42364937709, job 128380905347).
        const hidden = new Set<number>();
        const launcherEndedLast: ProcessTree = {
            ...systemProcessTree,
            async read() {
                const table = await systemProcessTree.read!();
                return table === null ? null : table.filter((p) => !hidden.has(p.pid));
            },
            async reap(targets, now, limit) {
                const launchers = targets.filter(isLauncher);
                const rest = targets.filter((t) => !isLauncher(t));
                await systemProcessTree.reap!(rest, now, limit);
                // Long enough for a launcher whose git has ended to lift its job's kill and exit by itself.
                await new Promise((r) => setTimeout(r, 1_500));
                return systemProcessTree.reap!(launchers, now, limit);
            },
        };
        const reading = withinGitLimit((limit) => new Promise<void>((resolve, reject) => {
            limit.git(['status', '--porcelain'], { cwd: repo }, (error) => (error ? reject(error) : resolve()));
        }), launcherEndedLast).then(() => 'answered', (error: unknown) => (error instanceof GitDidNotAnswer ? 'did not answer' : String(error)));
        // CONTROL: all 20 are running before the limit.
        await vi.waitFor(() => { expect(ours()).toBe(20); }, { timeout: 7_000, interval: 500 });
        for (const pid of oursPids()) hidden.add(pid);
        expect(hidden.size).toBe(20);
        expect(await reading).toBe('did not answer');
        await vi.waitFor(() => { expect(ours(), 'children of the hook still running after the limit').toBe(0); }, { timeout: 30_000, interval: 1_000 });
    }, 90_000);
});
