import { describe, expect, it } from 'vitest';
import { latestIndex, probeTools, runUpdate, shouldCheckUpdates, type CommandRunner } from '../src/main/toolchain-prober.js';

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

    it('on Windows the .cmd/.bat tools (composer, npm, claude, codex) are probed through cmd.exe — execFile alone read every one as not-installed; .exe tools are not', async () => {
        const run = runner({
            'cmd.exe /d /s /c composer --version': { stdout: 'Composer version 2.8.12 2026-09-19 13:41:59', exitCode: 0 },
            'cmd.exe /d /s /c npm --version': { stdout: '11.6.1', exitCode: 0 },
            'node --version': { stdout: 'v22.23.2', exitCode: 0 },
        });
        const by = Object.fromEntries((await probeTools(run, async () => null, 'win32')).map((s) => [s.tool, s]));
        expect(by.composer).toMatchObject({ installed: '2.8.12' });
        expect(by.npm).toMatchObject({ installed: '11.6.1' });
        expect(by.node).toMatchObject({ installed: '22.23.2' });
        // Control: the same table on Linux finds no composer — the shim is Windows-only.
        const linux = Object.fromEntries((await probeTools(run, async () => null, 'linux')).map((s) => [s.tool, s]));
        expect(linux.composer).toMatchObject({ installed: null, tone: 'not-installed' });
        expect(linux.node).toMatchObject({ installed: '22.23.2' });
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

    it('on Windows an npm-distributed update goes through cmd.exe (npm is npm.cmd, which execFile cannot start); elsewhere npm is run directly', async () => {
        const calls: Array<[string, readonly string[]]> = [];
        const spy: CommandRunner = async (binary, args) => { calls.push([binary, args]); return { stdout: '', exitCode: 0 }; };
        await runUpdate('claude-code', { platform: 'win32', packageManager: 'winget' }, spy, null);
        expect(calls.filter(([, a]) => a.includes('install'))).toEqual([['cmd.exe', ['/d', '/s', '/c', 'npm', 'install', '-g', '@anthropic-ai/claude-code@latest']]]);
        // Its probe too: `claude` from npm is claude.cmd.
        expect(calls.filter(([, a]) => a.includes('--version'))).toEqual([['cmd.exe', ['/d', '/s', '/c', 'claude', '--version']], ['cmd.exe', ['/d', '/s', '/c', 'claude', '--version']]]);
        calls.length = 0;
        await runUpdate('claude-code', { platform: 'linux', packageManager: 'apt' }, spy, null);
        expect(calls.filter(([, a]) => a.includes('install'))).toEqual([['npm', ['install', '-g', '@anthropic-ai/claude-code@latest']]]);
    });

    it('the command is run as a binary and arguments, never through a shell', async () => {
        const calls: Array<[string, readonly string[]]> = [];
        const spy: CommandRunner = async (binary, args) => { calls.push([binary, args]); return { stdout: binary === 'git' ? 'git version 2.51.0' : '', exitCode: 0 }; };
        await runUpdate('git', { platform: 'darwin', packageManager: 'brew' }, spy, null);
        expect(calls.find(([b]) => b === 'brew')).toEqual(['brew', ['upgrade', 'git']]);
    });
});

describe('the "latest" lookup (latestIndex) — npm is npm.cmd on Windows', () => {
    const OUTDATED = JSON.stringify({ '@anthropic-ai/claude-code': { current: '2.1.0', wanted: '2.1.0', latest: '2.2.0' }, '@openai/codex': { current: '0.40.0', wanted: '0.40.0', latest: '0.41.0' } });
    const spyRunner = (calls: Array<[string, readonly string[]]>): CommandRunner => async (binary, args) => {
        calls.push([binary, [...args]]);
        // npm outdated exits 1 when something IS outdated; the JSON is the answer either way.
        return { stdout: OUTDATED, exitCode: 1 };
    };
    const noFetch = async (): Promise<unknown> => { throw new Error('no network in this test'); };

    it('on win32, claude-code and codex ask npm THROUGH cmd.exe — exactly one call each, with the exact argv; both read a latest', async () => {
        const calls: Array<[string, readonly string[]]> = [];
        const latest = latestIndex({ run: spyRunner(calls), fetchJson: noFetch, platform: 'win32' });
        expect(await latest('claude-code')).toEqual({ version: '2.2.0', source: 'npm registry' });
        expect(await latest('codex')).toEqual({ version: '0.41.0', source: 'npm registry' });
        expect(calls).toEqual([
            ['cmd.exe', ['/d', '/s', '/c', 'npm', 'outdated', '-g', '--json']],
            ['cmd.exe', ['/d', '/s', '/c', 'npm', 'outdated', '-g', '--json']],
        ]);
        // COUNTED: npm was never handed to execFile bare on Windows (that is the ENOENT that read `unknown` forever).
        expect(calls.filter(([b]) => b === 'npm')).toHaveLength(0);
    });

    it('CONTROL on linux: the same lookups run npm directly, once each', async () => {
        const calls: Array<[string, readonly string[]]> = [];
        const latest = latestIndex({ run: spyRunner(calls), fetchJson: noFetch, platform: 'linux' });
        expect(await latest('claude-code')).toEqual({ version: '2.2.0', source: 'npm registry' });
        expect(await latest('codex')).toEqual({ version: '0.41.0', source: 'npm registry' });
        expect(calls).toEqual([
            ['npm', ['outdated', '-g', '--json']],
            ['npm', ['outdated', '-g', '--json']],
        ]);
    });

    it('winget is a real .exe: on win32 a package-managed tool asks winget directly, not through cmd.exe', async () => {
        const calls: Array<[string, readonly string[]]> = [];
        const run: CommandRunner = async (binary, args) => { calls.push([binary, [...args]]); return { stdout: '', exitCode: 0 }; };
        await latestIndex({ run, fetchJson: noFetch, platform: 'win32' })('git');
        expect(calls).toHaveLength(1);
        expect(calls[0]![0]).toBe('winget');
    });

    it('a runner that throws (npm absent) is the honest null — never a crash', async () => {
        const run: CommandRunner = async () => { throw Object.assign(new Error('spawn cmd.exe ENOENT'), { code: 'ENOENT' }); };
        expect(await latestIndex({ run, fetchJson: noFetch, platform: 'win32' })('claude-code')).toBeNull();
    });
});
