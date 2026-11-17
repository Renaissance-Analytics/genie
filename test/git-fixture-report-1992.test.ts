import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand, type CommandFailure } from './helpers/command-report.js';

/**
 * A fixture's command that fails says WHY (genie#1992): the exit code, the signal, whether the timeout ended it, stdout and stderr.
 * The storage fixture's `git worktree add` failed on Windows with only "Command failed", and nothing said whether git refused,
 * was killed or ran out of time.
 */
const failure = async (file: string, args: string[], timeoutMs?: number): Promise<CommandFailure> => {
    try { await runCommand(file, args, timeoutMs === undefined ? {} : { timeoutMs }); } catch (e) { return e as CommandFailure; }
    throw new Error('the command was expected to fail');
};

describe('a failing command reports what it did', () => {
    it('git refusing: the exit code and what it said on stderr', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie-report-'));
        try {
            const e = await failure('git', ['-C', dir, 'worktree', 'add', join(dir, 'x')]);
            expect(e.code).toBe(128);
            expect(e.message).toContain('exit code: 128');
            expect(e.message).toContain('timed out: no');
            expect(e.stderr).toMatch(/not a git repository/i);
            expect(e.message).toMatch(/stderr: ".*not a git repository/i);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });

    it('a child that exits with nothing on either stream says both are empty, not nothing at all', async () => {
        const e = await failure(process.execPath, ['-e', 'process.exit(3)']);
        expect(e.code).toBe(3);
        expect(e.message).toContain('exit code: 3');
        expect(e.message).toContain('stdout: (empty)');
        expect(e.message).toContain('stderr: (empty)');
    });

    it('a child that runs out of time says the timeout ended it, and its signal or kill', async () => {
        const e = await failure(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 300);
        expect(e.timedOut).toBe(true);
        expect(e.message).toContain('timed out: yes, after 300 ms');
    });

    it('CONTROL: a command that finishes in time is not a failure, and its output comes back', async () => {
        const ok = await runCommand(process.execPath, ['-e', 'console.log("fine")'], { timeoutMs: 20_000 });
        expect(ok.stdout.trim()).toBe('fine');
    });

    it('CONTROL: a child that fails fast under a generous timeout is not reported as a timeout', async () => {
        const e = await failure(process.execPath, ['-e', 'process.exit(5)'], 20_000);
        expect(e.timedOut).toBe(false);
        expect(e.message).toContain('timed out: no');
    });
});
