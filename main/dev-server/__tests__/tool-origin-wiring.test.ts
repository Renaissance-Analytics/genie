import { describe, expect, it } from 'vitest';
import { probeHostTool, type HostToolSpec } from '../toolchain-detect';
import { detectToolUpdates } from '../toolchain-updates';

/**
 * Carrying a tool's ORIGIN from the probe to the update row (genie#213).
 *
 * `toolInstallOrigin` decides what a resolved path means; these prove the two
 * seams that get a path to it and the answer out to the page, because a
 * classifier nothing calls is worth nothing.
 *
 * The resolver is INJECTED, like every other seam in detection: a machine where
 * `where`/`which` is missing or slow must still produce a report, so a resolver
 * that fails is "no origin known" and never a throw. That is the same contract
 * detection already keeps for versions.
 */

const gitSpec: HostToolSpec = { name: 'git', bin: 'git', versionArgv: ['--version'] };

const runner = (out: string, code = 0) => ({
    run: async () => ({ code, stdout: out, stderr: '' }),
    stream: () => {
        throw new Error('unused');
    },
});

const originCtx = {
    platform: 'win32',
    home: 'C:\\Users\\dev',
    genieRoot: 'C:\\Users\\dev\\AppData\\Roaming\\genie\\toolchain',
};

describe('probing a tool', () => {
    it('records WHERE the binary that answered lives', async () => {
        const probe = await probeHostTool(gitSpec, runner('git version 2.42.0'), 'git', {
            resolvePath: async () => 'C:\\Program Files\\Git\\cmd\\git.exe',
        });

        expect(probe.installed).toBe(true);
        expect(probe.path).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    });

    it('does not resolve a path for a tool that is not installed', async () => {
        // Nothing answered, so there is nothing to locate — and asking anyway
        // spends a process per missing tool on the slowest machines.
        let asked = false;
        const probe = await probeHostTool(gitSpec, runner('', 1), 'git', {
            resolvePath: async () => {
                asked = true;
                return 'never';
            },
        });

        expect(probe.installed).toBe(false);
        expect(probe.path).toBeUndefined();
        expect(asked).toBe(false);
    });

    it('survives a resolver that throws, and reports the tool anyway', async () => {
        // The version is the load-bearing fact; the path is a nicety. A `where`
        // that blows up must not take the row down with it.
        const probe = await probeHostTool(gitSpec, runner('git version 2.42.0'), 'git', {
            resolvePath: async () => {
                throw new Error('where.exe missing');
            },
        });

        expect(probe.installed).toBe(true);
        expect(probe.version).toBe('2.42.0');
        expect(probe.path).toBeUndefined();
    });

    it('still probes when no resolver is supplied at all', async () => {
        const probe = await probeHostTool(gitSpec, runner('git version 2.42.0'));
        expect(probe.installed).toBe(true);
        expect(probe.path).toBeUndefined();
    });
});

describe('folding the probe into an update row', () => {
    const report = (path?: string) => ({
        platform: 'win32',
        probes: [{ name: 'git' as const, installed: true, version: '2.42.0', ...(path ? { path } : {}) }],
        present: ['git' as const],
        missing: [],
    });

    it('carries the origin through, so the page can say who owns the tool', async () => {
        const [row] = await detectToolUpdates(
            report('C:\\Users\\dev\\AppData\\Roaming\\genie\\toolchain\\git\\bin\\git.exe'),
            async () => null,
            originCtx,
        );

        expect(row!.origin).toEqual({
            managedByGenie: true,
            source: 'genie',
            directory: 'C:\\Users\\dev\\AppData\\Roaming\\genie\\toolchain\\git\\bin',
        });
    });

    it('marks a winget install as NOT managed by Genie', async () => {
        // The distinction the issue is about: Genie must not offer to update a
        // Docker that winget owns, and must not list it as though it were its own.
        const [row] = await detectToolUpdates(
            report('C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\docker.exe'),
            async () => null,
            originCtx,
        );

        expect(row!.origin?.managedByGenie).toBe(false);
        expect(row!.origin?.source).toBe('winget');
    });

    it('leaves origin absent when the path was never resolved', async () => {
        // Absent, not a fabricated 'unknown' directory: the row simply says less.
        const [row] = await detectToolUpdates(report(), async () => null, originCtx);
        expect(row!.origin).toBeUndefined();
    });

    it('works with no origin context at all — the update report is unchanged', async () => {
        // Back-compat: every existing caller passes two arguments.
        const [row] = await detectToolUpdates(report('/usr/bin/git'), async () => null);
        expect(row!.name).toBe('git');
        expect(row!.origin).toBeUndefined();
    });
});
