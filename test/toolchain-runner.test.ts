import { describe, expect, it } from 'vitest';
import { execFileRunner, probeToolsLive } from '../src/main/toolchain-runner.js';

/**
 * THE REAL COMMAND RUNNER behind the toolchain prober — `execFile`, never a shell, with a timeout,
 * and ENOENT reported as the prober expects. These spawn real processes, which is why they run only
 * on the test machine (WSL distro / Windows VM), never on the owner's desktop. `node` is the one
 * binary every test machine has; it is the positive control for "a tool that answers".
 */

describe('execFileRunner', () => {
    it('runs a binary with arguments and returns its stdout and exit code', async () => {
        const r = await execFileRunner('node', ['--version']);
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toMatch(/^v\d+\.\d+\.\d+$/);
    });

    it('a binary that does not exist rejects with code ENOENT — what the prober reads as not-installed', async () => {
        await expect(execFileRunner('definitely-not-a-binary-zz', ['--version'])).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('a non-zero exit is a RESULT, not a rejection — the exit code is the fact', async () => {
        const r = await execFileRunner('node', ['-e', 'process.stdout.write("partial"); process.exit(3)']);
        expect(r).toEqual({ stdout: 'partial', exitCode: 3 });
    });

    it('arguments are never interpreted by a shell', async () => {
        const r = await execFileRunner('node', ['-e', 'process.stdout.write(process.argv[1])', '--', 'a&echo PWNED']);
        expect(r.stdout).toBe('a&echo PWNED');
    });

    it('a hang is cut at the timeout and reported as a timeout, not awaited forever', async () => {
        await expect(execFileRunner('node', ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });
});

describe('probeToolsLive', () => {
    it('probes every managed tool with the real runner; node is installed here, and nothing throws for the ones that are not', async () => {
        const statuses = await probeToolsLive(async () => null);
        const node = statuses.find((s) => s.tool === 'node')!;
        expect(node.installed).toMatch(/^\d+\.\d+\.\d+$/);
        expect(node.tone).toBe('unknown');
        expect(statuses.length).toBeGreaterThanOrEqual(11);
        // The probe's own bound is 20 s PER TOOL (execFileRunner's DEFAULT_TIMEOUT_MS); a deadline below that measures the
        // machine, not the code — the v2.0.0-beta.5 release run timed this test out at 5 s on a cold Windows runner with
        // php, go, cargo and python all installed, while the same probe passes in 76 ms where nothing but node exists.
    }, 30_000);
});
