import { ChildProcess, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemProcessTree, type ProcessInfo, type ProcessTree } from '../src/core/process-tree.js';
import { setGitExecRoute } from '../src/main/git-exec.js';
import { GIT_READ_LIMIT, GitDidNotAnswer, gitFileStatus, gitLogSince, gitShowHead, gitTreeStatus, withinGitLimit } from '../src/main/git-ports.js';
import { repoStatus } from '../src/main/repo-git.js';
import { startSpawnHost, type SpawnHostClient } from '../src/main/spawn-host-client.js';
import { winLauncherPath } from '../src/main/win-launcher.js';

/*
 * genie-host's GIT, CREATED BY ITS SPAWN-HOST CHILD (Tynn #532). Windows creates a process synchronously on the calling
 * thread: one git read held genie-host 295 ms in the UI-lag row. So the host routes git's processes to the child
 * (git-exec.ts). What decides stays the host's — the read limit, the job a read runs in, and the walk that ends a read's
 * tree — and each must still hold with the processes created over there. The same reads as test/git-read-limit*.test.ts,
 * through a real spawn-host child; and this process creates none of them.
 */

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
let client: SpawnHostClient;
let root = '';
let repo = '';
const savedLimit = GIT_READ_LIMIT.ms;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

/** Every process this test's own process creates while `run` runs (where every spawn, execFile and fork passes). */
async function createdHere<T>(run: () => Promise<T>): Promise<{ value: T; created: string[] }> {
    const created: string[] = [];
    // `spawn` is on the prototype at run time though not in its typings: every spawn, execFile and fork passes it.
    const proto = ChildProcess.prototype as unknown as { spawn: (this: ChildProcess, options: { file?: string }) => unknown };
    const original = proto.spawn;
    proto.spawn = function (options) { created.push(String(options?.file ?? '?')); return original.call(this, options); };
    try { return { value: await run(), created }; } finally { proto.spawn = original; }
}

beforeAll(async () => {
    client = startSpawnHost({ entry: fixture('git-spawn-host.ts'), execArgv: ['--import', 'tsx'] });
    // Warm: the child compiles its fixture once, cold (as spawn-host-client.test.ts does).
    await client.exec(process.execPath, ['-e', '0'], { env: { ELECTRON_RUN_AS_NODE: '1' } });
}, 60_000);
afterAll(async () => { setGitExecRoute(null); await client.stop(); });

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'git-through-child-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
});
afterEach(async () => {
    setGitExecRoute(null);
    GIT_READ_LIMIT.ms = savedLimit;
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

describe('a read through the child answers as a read here does', () => {
    it('the same answers, and this process creates none of their processes', async () => {
        const reads = async () => [await gitTreeStatus(repo), await gitFileStatus(repo, 'a.txt'), await gitShowHead(repo, 'a.txt'), (await gitLogSince(repo, 0)).map((c) => c.subject)];
        // CONTROL: here, the reads create their processes in this one (the gauge can see them).
        const here = await createdHere(reads);
        expect(here.created.length).toBeGreaterThan(0);
        setGitExecRoute(client.gitExec);
        const there = await createdHere(reads);
        expect(there.value).toEqual(here.value);
        expect(there.value[0]).toMatchObject({ 'a.txt': 'modified' });
        expect(there.created).toEqual([]);
    });

    it('what a read writes to git\'s stdin reaches the git the child made', async () => {
        const hash = () => withinGitLimit((limit) => new Promise<string>((resolve, reject) => {
            const child = limit.git(['hash-object', '--stdin'], { cwd: repo }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())));
            child?.stdin?.end('through the child\n');
        }));
        const here = await hash();
        expect(here).toMatch(/^[0-9a-f]{40}$/);
        setGitExecRoute(client.gitExec);
        expect(await hash()).toBe(here);
    });

    it('a git that fails says so in its own words, as here', async () => {
        const plain = join(root, 'plain');
        mkdirSync(plain);
        const here = await repoStatus(plain, '.');
        setGitExecRoute(client.gitExec);
        expect(await repoStatus(plain, '.')).toEqual(here);
        expect(here.ok).toBe(false);
    });
});

describe('past the limit, what a read through the child started is ended', () => {
    let mark = '';
    let child = 0;
    beforeEach(() => {
        mark = join(root, 'child.pid');
        child = 0;
        const script = join(root, 'child.cjs');
        writeFileSync(script, 'require("fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 90000);\n');
        const hook = join(root, 'starts-a-child.sh');
        const slashes = (p: string) => p.replace(/\\/g, '/');
        writeFileSync(hook, `#!/bin/sh\n"${slashes(process.execPath)}" "${slashes(script)}" "${slashes(mark)}"\n`);
        chmodSync(hook, 0o755);
        git('config', 'core.fsmonitor', slashes(hook));
        GIT_READ_LIMIT.ms = 6000;
        setGitExecRoute(client.gitExec);
    });
    afterEach(() => { if (child !== 0 && alive(child)) process.kill(child); });

    it.each([
        ['gitTreeStatus', () => gitTreeStatus(repo).then(() => 'answered', (error: Error) => error.message)],
        ['repoStatus', () => repoStatus(repo, '.').then((r) => (r.ok ? 'answered' : r.error))],
    ])('%s: the hook\'s child is running at the limit, and gone after it', async (_name, read) => {
        const reading = read();
        await vi.waitFor(() => { expect(existsSync(mark) && readFileSync(mark, 'utf8') !== '').toBe(true); }, { timeout: 5500, interval: 50 });
        child = Number(readFileSync(mark, 'utf8'));
        expect(alive(child)).toBe(true);
        expect(await reading).toMatch(/did not answer/);
        await vi.waitFor(() => { expect(alive(child)).toBe(false); }, { timeout: 40_000, interval: 200 });
    }, 70_000);
});

const windows = process.platform === 'win32';
describe.skipIf(!windows)('through the child, a read past its limit still ends its job before anything in it (Windows)', () => {
    const MARK = `job-through-child-${process.pid}`;
    const node = process.execPath.replace(/\\/g, '/');
    const oursPids = (): number[] => {
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'node*' -and $_.CommandLine -and $_.CommandLine -like '*${MARK}*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
        return out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
    };
    beforeEach(() => {
        const hook = join(root, 'forks.sh');
        writeFileSync(hook, `#!/bin/sh\ni=0\nwhile [ "$i" -lt 20 ]; do "${node}" -e "setInterval(() => {}, 1000)" ${MARK} & i=$((i+1)); done\nwait\n`);
        chmodSync(hook, 0o755);
        git('config', 'core.fsmonitor', hook.replace(/\\/g, '/'));
        GIT_READ_LIMIT.ms = 8_000;
        setGitExecRoute(client.gitExec);
    });
    afterEach(() => {
        try {
            execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'node*' -and $_.CommandLine -and $_.CommandLine -like '*${MARK}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { timeout: 120_000, windowsHide: true, stdio: 'ignore' });
        } catch { /* none left */ }
    });

    it('with the launcher ended LAST by the reap, still none of what the hook started survives', async () => {
        expect(winLauncherPath(), 'genie-launch.exe is built').not.toBeNull();
        const isLauncher = (p: ProcessInfo) => /^genie-launch(\.exe)?$/i.test(p.name);
        const hidden = new Set<number>();
        const launcherEndedLast: ProcessTree = {
            ...systemProcessTree,
            async read() { const table = await systemProcessTree.read!(); return table === null ? null : table.filter((p) => !hidden.has(p.pid)); },
            async reap(targets, now, limit) {
                await systemProcessTree.reap!(targets.filter((t) => !isLauncher(t)), now, limit);
                await new Promise((r) => setTimeout(r, 1_500));
                return systemProcessTree.reap!(targets.filter(isLauncher), now, limit);
            },
        };
        const reading = withinGitLimit((limit) => new Promise<void>((resolve, reject) => {
            limit.git(['status', '--porcelain'], { cwd: repo }, (error) => (error ? reject(error) : resolve()));
        }), launcherEndedLast).then(() => 'answered', (error: unknown) => (error instanceof GitDidNotAnswer ? 'did not answer' : String(error)));
        await vi.waitFor(() => { expect(oursPids().length).toBe(20); }, { timeout: 7_000, interval: 500 });
        for (const pid of oursPids()) hidden.add(pid);
        expect(await reading).toBe('did not answer');
        await vi.waitFor(() => { expect(oursPids().length, 'children of the hook still running after the limit').toBe(0); }, { timeout: 30_000, interval: 1_000 });
    }, 90_000);
});
