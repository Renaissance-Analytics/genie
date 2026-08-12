import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner, StreamHandle } from '../container-runtime';
import { createLatestFor } from '../toolchain-latest';

/**
 * `createLatestFor` is the real {@link LatestFor} behind P0's update check
 * (#242 P1): it runs a package manager's outdated command ONCE, parses it, and
 * maps a tool to its package to read the latest. The routing (which command per
 * tool, the package lookup, the run-once cache) is what's tested here with a fake
 * runner; the parsing is already covered in toolchain-outdated. Never throws — a
 * failed command is "no update known".
 */

const OK = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const FAIL: CommandResult = { code: 1, stdout: '', stderr: 'boom' };

function runner(handle: (cmd: string, args: string[]) => CommandResult) {
    const run = vi.fn(async (cmd: string, args: string[]) => handle(cmd, args));
    const r: CommandRunner = {
        run,
        stream: (): StreamHandle => {
            throw new Error('unused');
        },
    };
    return { runner: r, run };
}

const BREW_OUTDATED = JSON.stringify({
    formulae: [{ name: 'git', installed_versions: ['2.42.0'], current_version: '2.45.0' }],
    casks: [],
});
const NPM_OUTDATED = JSON.stringify({
    '@openai/codex': { current: '0.4.0', wanted: '0.5.0', latest: '0.5.0' },
});

describe('createLatestFor', () => {
    it('reads a pm-managed tool from the chosen manager’s outdated list', async () => {
        const { runner: r } = runner((cmd) => (cmd === 'brew' ? OK(BREW_OUTDATED) : OK('')));
        const latestFor = createLatestFor({ runner: r, pm: 'brew' });
        expect(await latestFor('git')).toEqual({ version: '2.45.0', source: 'package-manager' });
    });

    it('reads an agent TUI from `npm outdated -g`, mapping tool→package', async () => {
        const { runner: r } = runner((cmd) => (cmd === 'npm' ? OK(NPM_OUTDATED) : OK('')));
        const latestFor = createLatestFor({ runner: r, pm: 'brew' });
        expect(await latestFor('codex')).toEqual({ version: '0.5.0', source: 'npm-global' });
    });

    it('returns null when the tool is not in the outdated list (already current)', async () => {
        const { runner: r } = runner((cmd) => (cmd === 'brew' ? OK(BREW_OUTDATED) : OK('')));
        const latestFor = createLatestFor({ runner: r, pm: 'brew' });
        // node isn't in BREW_OUTDATED → up to date → no candidate.
        expect(await latestFor('node')).toBeNull();
    });

    it('runs each outdated command at most ONCE across many tools (cached)', async () => {
        const { runner: r, run } = runner((cmd) => (cmd === 'brew' ? OK(BREW_OUTDATED) : OK(NPM_OUTDATED)));
        const latestFor = createLatestFor({ runner: r, pm: 'brew' });
        await latestFor('git');
        await latestFor('node');
        await latestFor('php');
        await latestFor('codex');
        await latestFor('claude-code');
        const brewCalls = run.mock.calls.filter((c) => c[0] === 'brew').length;
        const npmCalls = run.mock.calls.filter((c) => c[0] === 'npm').length;
        expect(brewCalls).toBe(1);
        expect(npmCalls).toBe(1);
    });

    it('returns null for a pm-managed tool when no package manager is set', async () => {
        const { runner: r, run } = runner(() => OK(''));
        const latestFor = createLatestFor({ runner: r }); // pm omitted
        expect(await latestFor('git')).toBeNull();
        // Agent TUIs still resolve via npm even without a system PM.
        expect(run.mock.calls.some((c) => c[0] === 'brew')).toBe(false);
    });

    it('never throws when the outdated command fails', async () => {
        const { runner: r } = runner(() => FAIL);
        const latestFor = createLatestFor({ runner: r, pm: 'apt' });
        expect(await latestFor('git')).toBeNull();
    });

    it('queries winget/apt with their real outdated argv', async () => {
        const { runner: r, run } = runner(() => OK(''));
        await createLatestFor({ runner: r, pm: 'winget' })('git');
        expect(run).toHaveBeenCalledWith('winget', ['upgrade']);

        const apt = runner(() => OK(''));
        await createLatestFor({ runner: apt.runner, pm: 'apt' })('git');
        expect(apt.run).toHaveBeenCalledWith('apt', ['list', '--upgradable']);
    });
});
