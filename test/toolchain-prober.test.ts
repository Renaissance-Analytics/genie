import { describe, expect, it } from 'vitest';
import { probeTools, runUpdate, shouldCheckUpdates, type CommandRunner } from '../src/main/toolchain-prober.js';

/**
 * THE MANAGED TOOLCHAIN (§6.6) — the main-side half, with the process runner INJECTED so the test
 * never spawns anything: probe every tool's version, ask the index for the latest, cache the scan
 * behind a six-hour window (never a poll), and perform an update judged by the version measured
 * AFTER — the core's honest-repair rule, applied.
 */

const runner = (table: Record<string, { stdout: string; exitCode: number } | 'ENOENT'>): CommandRunner => async (binary, args) => {
    const hit = table[`${binary} ${args.join(' ')}`] ?? table[binary];
    if (hit === undefined || hit === 'ENOENT') throw Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' });
    return hit;
};

describe('probing', () => {
    it('reports every managed tool: installed version from its banner, latest from the index, and the honest tone', async () => {
        const run = runner({
            'node --version': { stdout: 'v22.23.2\n', exitCode: 0 },
            'php --version': { stdout: 'PHP 8.4.11 (cli)', exitCode: 0 },
            'git --version': { stdout: 'git version 2.51.0', exitCode: 0 },
        });
        const index = async (tool: string) => (tool === 'node' ? { version: '22.24.0', source: 'nodejs.org index' } : null);
        const statuses = await probeTools(run, index);
        const by = Object.fromEntries(statuses.map((s) => [s.tool, s]));
        expect(by.node).toEqual({ tool: 'node', installed: '22.23.2', latest: '22.24.0', tone: 'update-available', source: 'nodejs.org index' });
        expect(by.php).toMatchObject({ installed: '8.4.11', latest: null, tone: 'unknown' });
        expect(by.git).toMatchObject({ installed: '2.51.0', tone: 'unknown' });
        expect(by.python).toMatchObject({ installed: null, tone: 'not-installed' });
        // COUNTED: every tool in the registry has a row, including the ones that are not installed.
        expect(statuses.length).toBeGreaterThanOrEqual(11);
    });

    it('a probe that throws anything other than ENOENT is still not-installed — never a crash, never a guessed version', async () => {
        const run: CommandRunner = async () => { throw new Error('EACCES'); };
        const statuses = await probeTools(run, async () => null);
        expect(statuses.every((s) => s.tone === 'not-installed')).toBe(true);
    });

    it('an index that throws leaves the tool `unknown`, with the installed version intact', async () => {
        const run = runner({ 'node --version': { stdout: 'v22.23.2', exitCode: 0 } });
        const statuses = await probeTools(run, async () => { throw new Error('offline'); });
        expect(statuses.find((s) => s.tool === 'node')).toMatchObject({ installed: '22.23.2', latest: null, tone: 'unknown' });
    });
});

describe('the six-hour window — not a poll', () => {
    const H = 3_600_000;
    it('never checked → check; checked 5h ago → no; 7h ago → yes; a FUTURE timestamp counts as stale so a bad clock cannot freeze the badge', () => {
        expect(shouldCheckUpdates(null, 100 * H)).toBe(true);
        expect(shouldCheckUpdates(95 * H, 100 * H)).toBe(false);
        expect(shouldCheckUpdates(93 * H, 100 * H)).toBe(true);
        expect(shouldCheckUpdates(101 * H, 100 * H)).toBe(true);
        expect(shouldCheckUpdates(100 * H, 100 * H, true)).toBe(true);
    });
});

describe('an update, judged by the version measured after', () => {
    it('runs the planned command, re-probes, and reports repaired / unchanged honestly', async () => {
        let version = 'v22.23.2';
        const run = runner({});
        const spy: CommandRunner = async (binary, args) => {
            if (binary === 'node') return { stdout: version, exitCode: 0 };
            if (binary === 'winget') { version = 'v22.24.0'; return { stdout: 'Successfully installed', exitCode: 0 }; }
            return run(binary, args);
        };
        const r = await runUpdate('node', { platform: 'win32', packageManager: 'winget' }, spy, '22.24.0');
        expect(r).toEqual({ kind: 'repaired', from: '22.23.2', to: '22.24.0' });

        const lazy: CommandRunner = async (binary) => (binary === 'node' ? { stdout: 'v22.23.2', exitCode: 0 } : { stdout: 'No applicable update found.', exitCode: 0 });
        const u = await runUpdate('node', { platform: 'win32', packageManager: 'winget' }, lazy, '22.24.0');
        expect(u).toMatchObject({ kind: 'unchanged', installed: '22.23.2' });
    });

    it('a tool the planner refuses is refused before anything runs', async () => {
        let ran = 0;
        const counting: CommandRunner = async () => { ran += 1; return { stdout: '', exitCode: 0 }; };
        const r = await runUpdate('frobnicate', { platform: 'linux', packageManager: 'apt' }, counting, null);
        expect(r).toEqual({ kind: 'refused', reason: 'frobnicate is not a tool Genie manages' });
        expect(ran).toBe(0);
    });

    it('the command is run as a binary and arguments, never through a shell', async () => {
        const calls: Array<[string, readonly string[]]> = [];
        const spy: CommandRunner = async (binary, args) => { calls.push([binary, args]); return { stdout: binary === 'git' ? 'git version 2.51.0' : '', exitCode: 0 }; };
        await runUpdate('git', { platform: 'darwin', packageManager: 'brew' }, spy, null);
        expect(calls.find(([b]) => b === 'brew')).toEqual(['brew', ['upgrade', 'git']]);
    });
});
