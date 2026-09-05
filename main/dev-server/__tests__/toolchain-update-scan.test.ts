import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner, StreamHandle } from '../container-runtime';
import { detectToolchainUpdates } from '../toolchain-setup';

/**
 * `detectToolchainUpdates` is the one call the manager's update scan makes: it
 * composes detection (what's installed) + available-managers (what to query) +
 * the real LatestFor + the pure update fold into a per-tool update report. It's
 * seamed over the runner, so a whole "git has an update, node doesn't" scenario
 * is provable without a machine.
 */

const OK = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const MISSING: CommandResult = { code: null, stdout: '', stderr: 'ENOENT' };
const isServerProbe = (args: string[]) => args.includes('--format');

function runner(handle: (cmd: string, args: string[]) => CommandResult): CommandRunner {
    return {
        async run(cmd, args) {
            return handle(cmd, args);
        },
        stream: (): StreamHandle => {
            throw new Error('unused');
        },
    };
}

const BREW_OUTDATED = JSON.stringify({
    formulae: [{ name: 'git', installed_versions: ['2.42.0'], current_version: '2.45.0' }],
    casks: [],
});

describe('detectToolchainUpdates', () => {
    it('reports installed tools with their update status, using the detected manager', async () => {
        // macOS with brew: git 2.42.0 + node 20.11.0 installed; brew says git → 2.45.0.
        const r = runner((cmd, args) => {
            if (cmd === 'brew' && args[0] === 'outdated') return OK(BREW_OUTDATED);
            if (cmd === 'brew') return OK('Homebrew 4.2.0'); // --version probe
            if (cmd === 'git') return OK('git version 2.42.0');
            if (cmd === 'node') return OK('v20.11.0');
            if (cmd === 'docker') return isServerProbe(args) ? MISSING : MISSING;
            return MISSING;
        });

        const updates = await detectToolchainUpdates({ runner: r, os: 'darwin' });
        const byName = Object.fromEntries(updates.map((u) => [u.name, u]));

        expect(byName.git).toMatchObject({
            installed: '2.42.0',
            latest: '2.45.0',
            updateAvailable: true,
            source: 'package-manager',
        });
        // node is installed but not in brew's outdated list → up to date.
        expect(byName.node).toMatchObject({ updateAvailable: false });
        // A MISSING tool appears too, with no installed version. It used to be
        // dropped ("that's the install wizard's job"), which is what made the
        // Toolchain page's Install button unreachable for everything absent —
        // the row it acts on was never built.
        expect(byName.docker).toMatchObject({ name: 'docker', updateAvailable: false });
        expect(byName.docker!.installed).toBeUndefined();
    });

    it('never throws — a machine with nothing installed scans to all-missing, not an error', async () => {
        const updates = await detectToolchainUpdates({ runner: runner(() => MISSING), os: 'linux' });
        // Every wanted tool, each reported absent. An empty array would be the
        // WRONG answer here: it reads as "nothing to say" when the truth is
        // "nothing is installed, and here is what you could install".
        expect(updates.length).toBeGreaterThan(0);
        expect(updates.every((u) => u.installed === undefined)).toBe(true);
        expect(updates.every((u) => u.updateAvailable === false)).toBe(true);
    });
});
