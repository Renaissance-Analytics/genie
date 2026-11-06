import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyseFolder } from '../src/main/envelope-fs.js';
import { GIT_READ_LIMIT, GitDidNotAnswer, gitFileStatus, gitLogSince, gitShowHead, gitTreeStatus } from '../src/main/git-ports.js';
import { repoDiff, repoStatus } from '../src/main/repo-git.js';
import { GitReadProblem } from '../src/renderer/components/GitReadProblem.js';

/**
 * A GIT READ THAT DOES NOT ANSWER IS SAID, NOT SHOWN AS NOTHING. A read has a limit a slow real repository won't reach; one that reaches it is a failure the person sees, with a Retry, and never an empty list that reads as "nothing changed". A real git, whose configured hook never exits.
 */
let root: string;
let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const savedLimit = GIT_READ_LIMIT.ms;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'git-limit-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
});
afterEach(async () => {
    GIT_READ_LIMIT.ms = savedLimit;
    // The promise form: it retries a busy folder (the hook's child, which the limit does not end, still has it open). rmSync's retries do not cover EBUSY on a directory.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

describe('the limit', () => {
    it('is one a slow real repository will not reach', () => {
        expect(GIT_READ_LIMIT.ms).toBeGreaterThanOrEqual(120_000);
    });

    it('a read within it answers as ever', async () => {
        expect(await gitTreeStatus(repo)).toMatchObject({ 'a.txt': 'modified' });
        expect(await gitFileStatus(repo, 'a.txt')).toBe('modified');
        expect(await gitShowHead(repo, 'a.txt')).toBe('one\n');
        expect((await gitLogSince(repo, 0)).map((c) => c.subject)).toEqual(['first']);
    });

    it('a folder that is no repository is still nothing to show, not a failure', async () => {
        const plain = join(root, 'plain');
        mkdirSync(plain);
        expect(await gitTreeStatus(plain)).toEqual({});
        expect(await gitLogSince(plain, 0)).toEqual([]);
    });
});

// A pipe for a config file: every git in this repository waits on it for ever. Git cannot check one out, so this is a way to make a read hang, and Windows has none: the limit under it is the one the rows below prove there.
describe.skipIf(process.platform === 'win32')("the wizard's read of a folder has the limit too", () => {
    let config: string;
    beforeEach(() => {
        config = join(repo, '.git', 'config');
        rmSync(config);
        execFileSync('mkfifo', [config]);
        GIT_READ_LIMIT.ms = 500;
    });
    // Whatever is still waiting on the pipe sees its end.
    afterEach(() => { closeSync(openSync(config, constants.O_RDWR | constants.O_NONBLOCK)); });

    it('it fails in words, which the wizard shows, and does not wait for ever', async () => {
        await expect(analyseFolder(repo)).rejects.toThrow(/did not answer/);
    }, 15_000);
});

/**
 * WHO STILL HOLDS A FOLDER, said only when it cannot be removed (unit (windows) failed here twice on 2026-11-06 with EBUSY
 * after the hook's child was gone). Linux: every process whose working directory is in it. Windows: git, sh, bash and
 * conhost with their parents and start times, any process whose command line names it, and handle64's answer when the
 * machine has it. A diagnostic: the assertion it sits beside is unchanged.
 */
function holders(dir: string): string[] {
    try {
        if (process.platform !== 'win32') {
            return readdirSync('/proc').filter((p) => /^\d+$/.test(p)).flatMap((pid) => {
                try { const cwd = readlinkSync(`/proc/${pid}/cwd`); return cwd.startsWith(dir) ? [`${pid} cwd=${cwd} ${readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').slice(0, 200)}`] : []; } catch { return []; }
            });
        }
        const like = dir.replace(/'/g, "''");
        const table = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            `Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('git.exe','sh.exe','bash.exe','conhost.exe','git-remote-https.exe') -or ($_.CommandLine -and $_.CommandLine -like '*${like}*') } | ForEach-Object { "$($_.ProcessId) parent=$($_.ParentProcessId) $($_.Name) started=$($_.CreationDate.ToString('HH:mm:ss.fff')) $($_.CommandLine)" }`],
            { encoding: 'utf8', timeout: 60_000, windowsHide: true }).split(/\r?\n/).filter(Boolean).map((l) => l.slice(0, 300));
        let handles: string[] = [];
        try { handles = execFileSync('handle64', ['-accepteula', '-nobanner', dir], { encoding: 'utf8', timeout: 60_000, windowsHide: true }).split(/\r?\n/).filter(Boolean).map((l) => `handle64: ${l.slice(0, 200)}`); } catch { handles = ['handle64: not on this machine']; }
        return [...table, ...handles];
    } catch (error) {
        return [`(the table could not be read: ${error instanceof Error ? error.message : String(error)})`];
    }
}

describe('past it, what the read started is ended', () => {
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
    let mark: string;
    let child = 0;

    beforeEach(() => {
        mark = join(root, 'child.pid');
        child = 0;
        // Its own real pid on every system, its folder the repository's. It ends itself in time, so a red run leaves nothing behind.
        const script = join(root, 'child.cjs');
        writeFileSync(script, 'require("fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 90000);\n');
        const hook = join(root, 'starts-a-child.sh');
        const slashes = (p: string) => p.replace(/\\/g, '/');
        writeFileSync(hook, `#!/bin/sh\n"${slashes(process.execPath)}" "${slashes(script)}" "${slashes(mark)}"\n`);
        chmodSync(hook, 0o755);
        git('config', 'core.fsmonitor', slashes(hook));
        GIT_READ_LIMIT.ms = 6000;
    });
    afterEach(() => { if (child !== 0 && alive(child)) process.kill(child); });

    it.each([
        ['gitTreeStatus', () => gitTreeStatus(repo).then(() => 'answered', (error: Error) => error.message)],
        ['repoStatus', () => repoStatus(repo, '.').then((r) => (r.ok ? 'answered' : r.error))],
    ])('%s: the hook\'s child is running at the limit, is gone after it, and the folder can be removed', async (_name, read) => {
        const reading = read();
        await vi.waitFor(() => { expect(existsSync(mark) && readFileSync(mark, 'utf8') !== '').toBe(true); }, { timeout: 5500, interval: 50 });
        child = Number(readFileSync(mark, 'utf8'));
        expect(alive(child)).toBe(true);
        expect(await reading).toMatch(/did not answer/);
        await vi.waitFor(() => { expect(alive(child)).toBe(false); }, { timeout: 40_000, interval: 200 });
        try {
            await vi.waitFor(() => { rmSync(repo, { recursive: true, force: true }); expect(existsSync(repo)).toBe(false); }, { timeout: 5000, interval: 200 });
        } catch (error) {
            console.log(`GIT_LIMIT_HOLDERS of ${repo} (the hook's child ${child} is gone):\n  ${holders(root).join('\n  ')}`);
            throw error;
        }
    }, 70_000);
});

/*
 * NOTHING THE READ STARTED ESCAPES THE LIMIT, EVEN WHAT IT STARTS WHILE IT IS BEING ENDED (the line's run after #1637, job
 * 128179635631: git gone, and its hook's sh chain — "starts-a-child.sh 1", git's second call of the hook — still running in
 * the repository). One reading of the table, then the kill, left a window: whatever git or a hook started between the two
 * was in no reading, and outlived the read. Here the hook starts a new child every 300 ms for as long as it runs, so that
 * window is always there; each child writes its own pid. After the limit, every child ends, and no new one comes.
 */
describe('past it, a hook that keeps starting children is ended with all of them', () => {
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
    let marks: string;
    const started = (): number[] => (existsSync(marks) ? readdirSync(marks).map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

    beforeEach(() => {
        marks = join(root, 'marks');
        mkdirSync(marks);
        const slashes = (p: string) => p.replace(/\\/g, '/');
        // Each child: its own real pid as a file name, its folder the repository's; it ends itself in time, so a red run
        // leaves nothing behind for long.
        const script = join(root, 'child.cjs');
        writeFileSync(script, 'require("fs").writeFileSync(require("path").join(process.argv[2], String(process.pid)), ""); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 45000);\n');
        const hook = join(root, 'keeps-starting.sh');
        writeFileSync(hook, `#!/bin/sh\nwhile true; do "${slashes(process.execPath)}" "${slashes(script)}" "${slashes(marks)}" & sleep 0.3; done\n`);
        chmodSync(hook, 0o755);
        git('config', 'core.fsmonitor', slashes(hook));
        GIT_READ_LIMIT.ms = 4000;
    });
    afterEach(() => { for (const pid of started()) if (alive(pid)) { try { process.kill(pid); } catch { /* gone */ } } });

    it('gitTreeStatus: at the limit every child the hook started is ended, and none is started after', async () => {
        const reading = gitTreeStatus(repo).then(() => 'answered', (error: Error) => error.message);
        await vi.waitFor(() => { expect(started().length).toBeGreaterThan(2); }, { timeout: 10_000, interval: 50 });
        expect(await reading).toMatch(/did not answer/);
        // Every child ended (the limit's kill runs after the answer)...
        await vi.waitFor(() => { expect(started().filter(alive)).toEqual([]); }, { timeout: 40_000, interval: 250 });
        // ...and the loop that started them is gone too: no child is started from here on.
        const count = started().length;
        await new Promise((r) => setTimeout(r, 2_000));
        expect(started().length, 'a child started after the limit ended the read').toBe(count);
        await vi.waitFor(() => { rmSync(repo, { recursive: true, force: true }); expect(existsSync(repo)).toBe(false); }, { timeout: 10_000, interval: 250 });
    }, 90_000);
});

/*
 * A BIG TREE IS STILL OURS (#1638's review): every process the walk finds is a descendant of our git by pid, start time and
 * name, so however many a hook forks, all of them end. A cap on how many are ended would be an escape hatch: a hook that
 * forks past it keeps running in the repository. Here the hook forks 230 sleeps at once; each carries a mark of this run in
 * its command line, so the machine's table says which are ours.
 */
describe('past it, a hook that forks hundreds of children is ended with all of them', () => {
    const MARK = `45.${String(process.pid).padStart(6, '0').slice(-6)}`;
    const ours = (): number => {
        try {
            if (process.platform === 'win32') {
                const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*sleep* ${MARK}*' }).Count`], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
                return Number(out.trim() || 0);
            }
            return execFileSync('pgrep', ['-fc', `sleep ${MARK}`], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)[0] ?? 0;
        } catch { return 0; }
    };

    beforeEach(() => {
        const hook = join(root, 'forks-hundreds.sh');
        writeFileSync(hook, `#!/bin/sh\ni=0\nwhile [ "$i" -lt 230 ]; do sleep ${MARK} & i=$((i+1)); done\nwait\n`);
        chmodSync(hook, 0o755);
        git('config', 'core.fsmonitor', hook.replace(/\\/g, '/'));
        GIT_READ_LIMIT.ms = 25_000;
    });
    afterEach(() => {
        try { if (process.platform !== 'win32') execFileSync('pkill', ['-f', `sleep ${MARK}`]); } catch { /* none left */ }
    });

    it('gitTreeStatus: more than 200 of them, and at the limit none survives', async () => {
        const reading = gitTreeStatus(repo).then(() => 'answered', (error: Error) => error.message);
        // CONTROL: the table sees them, past the old cap of 200, before the limit comes.
        await vi.waitFor(() => { expect(ours()).toBeGreaterThan(200); }, { timeout: 24_000, interval: 1_000 });
        expect(await reading).toMatch(/did not answer/);
        await vi.waitFor(() => { expect(ours()).toBe(0); }, { timeout: 60_000, interval: 1_000 });
        await vi.waitFor(() => { rmSync(repo, { recursive: true, force: true }); expect(existsSync(repo)).toBe(false); }, { timeout: 10_000, interval: 250 });
    }, 150_000);
});

describe('past it', () => {
    beforeEach(() => {
        const hook = join(root, 'never.sh');
        // Node by its whole path, not `sleep`: MinGit, as on the Windows VM, runs the hook but has no sleep, so git would carry on and answer.
        writeFileSync(hook, `#!/bin/sh\n"${process.execPath.replace(/\\/g, '/')}" -e "setTimeout(() => {}, 30000)"\n`);
        chmodSync(hook, 0o755);
        git('config', 'core.fsmonitor', hook.replace(/\\/g, '/'));
        GIT_READ_LIMIT.ms = 500;
    });

    it('gitTreeStatus fails, in words, and not as an empty list', async () => {
        await expect(gitTreeStatus(repo)).rejects.toBeInstanceOf(GitDidNotAnswer);
        await expect(gitTreeStatus(repo)).rejects.toThrow(/did not answer/);
    });

    it('gitFileStatus: the same', async () => { await expect(gitFileStatus(repo, 'a.txt')).rejects.toBeInstanceOf(GitDidNotAnswer); });

    it('repoStatus says so, as its own failure', async () => {
        const r = await repoStatus(repo, '.');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/did not answer/);
    });

    it('repoDiff says so too', async () => {
        const r = await repoDiff(repo, '.', 'a.txt', false);
        expect(r.ok).toBe(false);
    }, 15_000);
});

describe('what a person sees', () => {
    it('the words, and a Retry that is a real button', () => {
        const html = renderToStaticMarkup(<GitReadProblem reason="git did not answer within 2 minutes" onRetry={() => {}} />);
        expect(html).toContain('git did not answer within 2 minutes');
        expect(html).toMatch(/<button[^>]*data-git-read-retry/);
    });

    it('the Files panel and an agent\'s commits both show it, and neither swallows the failure', () => {
        const files = readFileSync('src/renderer/components/FilesPanelContainer.tsx', 'utf8');
        expect(files).toContain('<GitReadProblem');
        expect(files).not.toMatch(/gitStatus\(workspace\.id\)\.then\(setGit, \(\) => \{\}\)/);
        const agent = readFileSync('src/renderer/components/AgentView.tsx', 'utf8');
        expect(agent).toContain('<GitReadProblem');
        expect(readFileSync('src/renderer/App.tsx', 'utf8')).not.toMatch(/commitsSince\(workspaceId, since\)\.then\(\(r\) => \(r\.ok \? r\.commits : \[\]\)\)/);
    });
});
