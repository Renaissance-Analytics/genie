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

    /**
     * `npm outdated` EXITS 1 when it finds something outdated. That is its
     * documented contract, not a failure — and it is the only case where the
     * command has anything to say.
     *
     * The gate here read `code === 0 ? parse : {}`, so npm's answer was thrown
     * away exactly when there was one: no agent CLI could ever show an update.
     * Every fixture in this file used exit 0, which is a state the real command
     * reaches only when it has nothing to report.
     *
     * From the owner's own machine, `%LOCALAPPDATA%/npm-cache/_logs`:
     *
     *     6 verbose title npm outdated
     *     7 verbose argv "outdated" "--global" "--json"
     *     20 verbose exit 1
     */
    it('reads npm’s answer even though `npm outdated` exits 1 — that IS a hit', async () => {
        const { runner: r } = runner((cmd) =>
            cmd === 'npm' ? { code: 1, stdout: NPM_OUTDATED, stderr: '' } : OK(''),
        );
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

/**
 * TWO npm prefixes, because a real machine has two (genie#470).
 *
 * Genie INSTALLS agent CLIs into its own prefix — `npm install -g --prefix
 * <userData>/toolchain/npm-global` — and CHECKED for updates with a bare `npm
 * outdated -g`, which reads npm's *configured* prefix. Different directories, so
 * the check read a location the installer never writes to. Measured on the
 * owner's machine while writing this:
 *
 *     npm outdated -g --json
 *       -> { "@openai/codex": { current 0.151.0, latest 0.153.4 }, corepack, npm }
 *     npm outdated -g --prefix <userData>/toolchain/npm-global --json
 *       -> {}
 *
 * So the bare run covers what the USER installed and is blind to everything
 * GENIE installed — which, since the Genie TUI became installable, includes the
 * one CLI Genie ships itself.
 *
 * ## Why merging two lists needs no winner rule
 *
 * The issue worried that a tool present in both prefixes is ambiguous. It is
 * not, and the reason is worth stating because it is what makes this a read
 * widening rather than a policy:
 *
 *   - the update decision is `isUpdateAvailable(probe.version, latest)`;
 *   - `probe.version` comes from running THE BINARY PATH RESOLVES, so "which of
 *     the two installs is this?" is already answered by evidence, not by this
 *     map;
 *   - `latest` is a property of the package ON THE REGISTRY, identical whichever
 *     prefix reported it;
 *   - `current` from the outdated output is never read.
 *
 * Two entries for one package therefore agree on the only field that is used.
 * The merge is still deterministic — first answer wins — so the behaviour cannot
 * depend on which subprocess returned first.
 */
describe('createLatestFor across more than one npm prefix', () => {
    it('asks npm’s configured prefix, exactly as before, when no extra is given', async () => {
        const { runner: r, run } = runner(() => OK(NPM_OUTDATED));
        const latestFor = createLatestFor({ runner: r });

        await latestFor('codex');

        expect(run.mock.calls.filter((c) => c[0] === 'npm')).toHaveLength(1);
        expect(run.mock.calls[0]?.[1]).toEqual(['outdated', '-g', '--json']);
    });

    it('also asks each EXTRA prefix, with --prefix', async () => {
        const { runner: r, run } = runner(() => OK('{}'));
        const latestFor = createLatestFor({ runner: r, npmPrefixes: ['C:/g/toolchain/npm-global'] });

        await latestFor('codex');

        const npmCalls = run.mock.calls.filter((c) => c[0] === 'npm').map((c) => c[1]);
        expect(npmCalls).toHaveLength(2);
        expect(npmCalls).toContainEqual(['outdated', '-g', '--json']);
        expect(npmCalls).toContainEqual([
            'outdated',
            '-g',
            '--prefix',
            'C:/g/toolchain/npm-global',
            '--json',
        ]);
    });

    it('finds a tool that ONLY the extra prefix knows about — the whole point', async () => {
        // The bare run answers empty (the user installed nothing there); the
        // Genie prefix is where Genie put it. Before this, that tool could never
        // report an update.
        const { runner: r } = runner((cmd, args) =>
            cmd === 'npm' && args.includes('--prefix')
                ? OK(JSON.stringify({ '@openai/codex': { latest: '0.153.4' } }))
                : OK('{}'),
        );
        const latestFor = createLatestFor({ runner: r, npmPrefixes: ['C:/g/toolchain/npm-global'] });

        expect(await latestFor('codex')).toEqual({ version: '0.153.4', source: 'npm-global' });
    });

    it('still runs each prefix at most ONCE across many tools', async () => {
        const { runner: r, run } = runner(() => OK(NPM_OUTDATED));
        const latestFor = createLatestFor({ runner: r, npmPrefixes: ['C:/a', 'C:/b'] });

        await latestFor('codex');
        await latestFor('claude-code');
        await latestFor('gemini-cli');

        expect(run.mock.calls.filter((c) => c[0] === 'npm')).toHaveLength(3);
    });

    it('is deterministic when both prefixes name the same package', async () => {
        // They can only disagree if a publish lands between two subprocess calls
        // seconds apart, in which case either answer is a correct reading of
        // "latest" for the moment it was taken. First one wins, so the result
        // does not depend on which subprocess returned first.
        const { runner: r } = runner((cmd, args) =>
            cmd === 'npm' && args.includes('--prefix')
                ? OK(JSON.stringify({ '@openai/codex': { latest: '9.9.9' } }))
                : OK(JSON.stringify({ '@openai/codex': { latest: '0.153.4' } })),
        );
        const latestFor = createLatestFor({ runner: r, npmPrefixes: ['C:/g'] });

        expect(await latestFor('codex')).toEqual({ version: '0.153.4', source: 'npm-global' });
    });

    it('does not look a URL up as a package name', async () => {
        // `install.package` holds a release-tarball URL for the Genie TUI, and
        // `npm outdated` keys by REGISTRY NAME. Asking for the URL is a category
        // error that happens to miss; a URL that ever collided with a real
        // package name would answer about somebody else's package.
        const { runner: r } = runner(() =>
            OK(
                JSON.stringify({
                    'https://github.com/Renaissance-Analytics/genie-tui/releases/download/v0.1.0/genie-tui-0.1.0.tgz':
                        { latest: '9.9.9' },
                }),
            ),
        );
        const latestFor = createLatestFor({ runner: r });

        expect(await latestFor('genie')).toBeNull();
    });
});
