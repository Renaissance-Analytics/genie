import { describe, expect, it } from 'vitest';
import type { HostToolName } from '../toolchain-detect';
import { DEFAULT_TOOLCHAIN } from '../toolchain-detect';
import { planToolchainInstall } from '../toolchain-plan';
import type { InstallStep } from '../toolchain-plan';
import {
    buildInstallCommand,
    packageManagerRefreshCommand,
} from '../toolchain-adapters';
import type { RunInstallCommand, DownloadInstallCommand } from '../toolchain-adapters';
import { PM_PACKAGES, pmCanInstall } from '../toolchain-packages';
import type { PackageManager } from '../toolchain-packages';

/**
 * Phase 2 (#683) turns the planner's DECISIONS into concrete commands. The value
 * being pinned here is the exact argv / URL per tool × OS — the thing a wrong
 * answer to which silently installs nothing, or the wrong thing — so the tests
 * assert the literal command line, not a shape. Command-building is pure; the
 * `CommandRunner` seam runs it (mocked here, real on CI).
 *
 * The consistency block is the load-bearing one: the planner chooses `pm` iff a
 * package manager can install a tool, and the adapter must then HAVE a package
 * for it. Those two facts come from ONE table ({@link PM_PACKAGES}), and the
 * final test proves a full plan materialises with no gap.
 */

const step = (over: Partial<InstallStep> & Pick<InstallStep, 'tool' | 'method'>): InstallStep => ({
    requiresElevation: false,
    requiresRestart: false,
    dependsOn: [],
    ...over,
});

const asRun = (c: ReturnType<typeof buildInstallCommand>): RunInstallCommand => {
    if (c.via !== 'run') throw new Error(`expected a run command, got ${c.via}`);
    return c;
};
const asDownload = (c: ReturnType<typeof buildInstallCommand>): DownloadInstallCommand => {
    if (c.via !== 'download') throw new Error(`expected a download command, got ${c.via}`);
    return c;
};

describe('buildInstallCommand — winget (Windows)', () => {
    const build = (tool: HostToolName) =>
        asRun(
            buildInstallCommand(step({ tool, method: 'pm', packageManager: 'winget' }), {
                os: 'win32',
            }),
        );

    it('installs git by its winget id, non-interactive', () => {
        expect(build('git')).toMatchObject({
            via: 'run',
            command: 'winget',
            args: [
                'install',
                '--id',
                'Git.Git',
                '-e',
                '--silent',
                '--accept-source-agreements',
                '--accept-package-agreements',
            ],
        });
    });

    it('installs a LANGUAGE through Genie’s engine installer even when the planner said winget', () => {
        // The override is the point of genie#212, not an accident of ordering: a
        // winget-installed node lands in a prefix Genie does not own, so the page
        // can only ever list it as unmanaged and no site can pin a version to it.
        const command = buildInstallCommand(
            step({ tool: 'node', method: 'pm', packageManager: 'winget' }),
            { os: 'win32', arch: 'x64' },
        );
        expect(command.via).toBe('engine');
    });

    it('installs Docker Desktop by id', () => {
        expect(build('docker').args).toContain('Docker.DockerDesktop');
    });
});

describe('buildInstallCommand — brew (macOS)', () => {
    const build = (tool: HostToolName) =>
        asRun(buildInstallCommand(step({ tool, method: 'pm', packageManager: 'brew' }), { os: 'darwin' }));

    it('installs a formula with `brew install <name>`', () => {
        expect(build('git')).toMatchObject({ command: 'brew', args: ['install', 'git'] });
        expect(build('composer').args).toEqual(['install', 'composer']);
    });

    it('installs Docker Desktop as a CASK', () => {
        expect(build('docker').args).toEqual(['install', '--cask', 'docker']);
    });
});

describe('buildInstallCommand — apt / dnf (Linux)', () => {
    it('installs with `apt-get install -y <pkg>` using the distro package names', () => {
        const build = (tool: HostToolName) =>
            asRun(buildInstallCommand(step({ tool, method: 'pm', packageManager: 'apt' }), { os: 'linux' }));
        expect(build('git')).toMatchObject({ command: 'apt-get', args: ['install', '-y', 'git'] });
        expect(build('docker').args).toEqual(['install', '-y', 'docker.io']);
        // node and php are NOT here: a language Genie has a recipe for goes
        // through Genie's own per-version installer on every platform, so a
        // Linux user gets a node they can pin a site to rather than the distro's
        // (genie#212). php has no Linux recipe, so it keeps the distro package.
        expect(
            buildInstallCommand(step({ tool: 'node', method: 'pm', packageManager: 'apt' }), {
                os: 'linux',
                arch: 'x64',
            }).via,
        ).toBe('engine');
        expect(build('php').args).toEqual(['install', '-y', 'php-cli']);
    });

    it('installs with `dnf install -y <pkg>`', () => {
        const cmd = asRun(
            buildInstallCommand(step({ tool: 'git', method: 'pm', packageManager: 'dnf' }), {
                os: 'linux',
            }),
        );
        expect(cmd).toMatchObject({ command: 'dnf', args: ['install', '-y', 'git'] });
    });

    it('offers an index-refresh command for apt (which needs it) but not dnf', () => {
        expect(packageManagerRefreshCommand('apt')).toMatchObject({
            command: 'apt-get',
            args: ['update'],
        });
        expect(packageManagerRefreshCommand('dnf')).toBeNull();
        expect(packageManagerRefreshCommand('winget')).toBeNull();
        expect(packageManagerRefreshCommand('brew')).toBeNull();
    });
});

describe('buildInstallCommand — npm-global (agent TUIs)', () => {
    it('installs claude-code from its npm package', () => {
        const cmd = asRun(buildInstallCommand(step({ tool: 'claude-code', method: 'npm-global' }), { os: 'linux' }));
        expect(cmd).toMatchObject({
            command: 'npm',
            args: ['install', '-g', '@anthropic-ai/claude-code'],
        });
    });

    it('installs codex from its npm package', () => {
        const cmd = asRun(buildInstallCommand(step({ tool: 'codex', method: 'npm-global' }), { os: 'darwin' }));
        expect(cmd.args).toEqual(['install', '-g', '@openai/codex']);
    });

    /**
     * The agent CLIs Genie learned to install (genie#313 follow-up). The package
     * names are the ones each project's own npm manifest publishes — checked
     * against the registry rather than recalled, because this ecosystem renames
     * itself and a wrong package name is an install that fails at the user.
     */
    it('installs every catalogued agent CLI from ITS package, not a guessed one', () => {
        const expected: Record<string, string> = {
            'gemini-cli': '@google/gemini-cli',
            opencode: 'opencode-ai',
            'copilot-cli': '@github/copilot',
            crush: '@charmland/crush',
            amp: '@sourcegraph/amp',
        };
        for (const [tool, pkg] of Object.entries(expected)) {
            const cmd = asRun(
                buildInstallCommand(
                    step({ tool: tool as never, method: 'npm-global' }),
                    { os: 'linux' },
                ),
            );
            expect(cmd.args, tool).toEqual(['install', '-g', pkg]);
        }
    });

    /**
     * A tool with no installer must never produce a command. The adapter throwing
     * is the loud version of the drift `toolchain-packages.ts` already guards
     * against: the planner is not supposed to emit an `npm-global` step for a
     * tool with no package, so reaching here means two tables disagreed.
     */
    it('refuses to invent an npm package for a tool that has none', () => {
        expect(() =>
            // `aider`, not `genie`: the Genie TUI gained a real installer once
            // its package went public with the right bin name, so it no longer
            // demonstrates this. Aider is PyPI-only and still has no npm
            // package, which is what this test needs.
            buildInstallCommand(step({ tool: 'aider' as never, method: 'npm-global' }), {
                os: 'win32',
            }),
        ).toThrow(/no npm package/i);
    });

    it('puts a newly catalogued CLI in Genie’s own prefix, so a terminal can find it', () => {
        const cmd = asRun(
            buildInstallCommand(step({ tool: 'gemini-cli' as never, method: 'npm-global' }), {
                os: 'win32',
                genieRoot: 'C:\\g',
            }),
        );
        expect(cmd.args).toEqual([
            'install',
            '-g',
            '--prefix',
            'C:\\g\\npm-global',
            '@google/gemini-cli',
        ]);
        expect(cmd.pathAdd).toBe('C:\\g\\npm-global');
    });
});

describe('buildInstallCommand — direct downloads', () => {
    it('downloads composer as its stable phar, which needs php to run', () => {
        const cmd = asDownload(buildInstallCommand(step({ tool: 'composer', method: 'direct' }), { os: 'win32' }));
        expect(cmd.url).toBe('https://getcomposer.org/composer-stable.phar');
        expect(cmd.artifact).toBe('phar');
        expect(cmd.needs).toBe('php');
    });

    it('downloads the Docker Desktop installer for the machine architecture', () => {
        const amd = asDownload(
            buildInstallCommand(step({ tool: 'docker', method: 'direct', requiresElevation: true, requiresRestart: true }), {
                os: 'win32',
                arch: 'x64',
            }),
        );
        expect(amd.url).toContain('desktop.docker.com/win/main/amd64');
        expect(amd.artifact).toBe('exe');

        const arm = asDownload(
            buildInstallCommand(step({ tool: 'docker', method: 'direct' }), { os: 'win32', arch: 'arm64' }),
        );
        expect(arm.url).toContain('/win/main/arm64/');
    });

    it('downloads the Docker dmg on macOS by architecture', () => {
        const cmd = asDownload(
            buildInstallCommand(step({ tool: 'docker', method: 'direct' }), { os: 'darwin', arch: 'arm64' }),
        );
        expect(cmd.url).toContain('desktop.docker.com/mac/main/arm64/Docker.dmg');
        expect(cmd.artifact).toBe('dmg');
    });

    it('uses the official convenience script for Docker on Linux', () => {
        const cmd = asDownload(buildInstallCommand(step({ tool: 'docker', method: 'direct' }), { os: 'linux' }));
        expect(cmd.url).toBe('https://get.docker.com');
        expect(cmd.artifact).toBe('script');
    });

    it('marks a version-resolved download (git/node/php on Windows) rather than faking a pinned URL', () => {
        const git = asDownload(buildInstallCommand(step({ tool: 'git', method: 'direct' }), { os: 'win32' }));
        expect(git.url).toBeNull();
        expect(git.source).toBe('git-for-windows');

    });

    it('does NOT download a language itself — that is the engine installer’s job (genie#212)', () => {
        // node and php used to resolve a vendor URL here and unpack into
        // `<userData>/tools/<tool>`, which the Toolchain page has never read. The
        // whole reason the page could not see what the wizard installed. They go
        // through Genie's per-version installer now, at a version from the recipe
        // table, into the one root both surfaces agree on.
        for (const tool of ['node', 'php'] as const) {
            const command = buildInstallCommand(step({ tool, method: 'direct' }), {
                os: 'win32',
                arch: 'x64',
            });
            expect(command.via, `${tool} still downloads its own archive`).toBe('engine');
        }
    });
});

/**
 * A step the planner marked as covered by an earlier one materialises into a
 * CONFIRMATION, not a second install of the same package (genie#209).
 */
describe('buildInstallCommand — a covered step', () => {
    it('emits a verify command naming the install that covers it', () => {
        const cmd = buildInstallCommand(
            step({ tool: 'npm', method: 'pm', packageManager: 'winget', coveredBy: 'node' }),
            { os: 'win32' },
        );
        expect(cmd.via).toBe('verify');
        if (cmd.via === 'verify') expect(cmd.coveredBy).toBe('node');
        expect(cmd.label).toContain('node');
    });

    it('does not emit a package-manager argv for it', () => {
        const cmd = buildInstallCommand(
            step({ tool: 'npm', method: 'pm', packageManager: 'winget', coveredBy: 'node' }),
            { os: 'win32' },
        );
        expect('command' in cmd).toBe(false);
    });
});

describe('buildInstallCommand — cost carried from the plan', () => {
    it('propagates the step’s elevation and restart flags onto the command', () => {
        const cmd = buildInstallCommand(
            step({ tool: 'docker', method: 'pm', packageManager: 'winget', requiresElevation: true, requiresRestart: true }),
            { os: 'win32' },
        );
        expect(cmd.requiresElevation).toBe(true);
        expect(cmd.requiresRestart).toBe(true);
    });

    it('gives every command a human label for the consent list', () => {
        const cmd = buildInstallCommand(step({ tool: 'git', method: 'pm', packageManager: 'brew' }), {
            os: 'darwin',
        });
        expect(cmd.label.toLowerCase()).toContain('git');
    });
});

describe('buildInstallCommand — guards', () => {
    it('refuses a pm step whose package manager cannot install the tool', () => {
        // The planner never emits this (it only picks pm when a package exists),
        // but the adapter refuses loudly rather than inventing a fake id.
        expect(() =>
            buildInstallCommand(step({ tool: 'composer', method: 'pm', packageManager: 'winget' }), {
                os: 'win32',
            }),
        ).toThrow();
    });
});

describe('planner ↔ adapter consistency (single source of truth)', () => {
    const PMS: PackageManager[] = ['winget', 'brew', 'apt', 'dnf'];

    it('every pm-installable tool has a package the adapter can build', () => {
        for (const pm of PMS) {
            for (const tool of DEFAULT_TOOLCHAIN) {
                if (!pmCanInstall(pm, tool)) continue;
                expect(PM_PACKAGES[pm][tool]).toBeDefined();
                const built = buildInstallCommand(
                    step({ tool, method: 'pm', packageManager: pm }),
                    { os: 'linux', arch: 'x64' },
                );
                // A language Genie has a recipe for overrides the manager
                // entirely (genie#212) — it still has to have a package, which
                // the assertion above proves, but it will not be used here.
                if (built.via === 'engine') continue;
                expect(asRun(built).args.join(' ')).toContain(PM_PACKAGES[pm][tool]!.id);
            }
        }
    });

    it('materialises a whole fresh-machine plan with no unbuildable step', () => {
        const detected = {
            platform: 'linux',
            probes: DEFAULT_TOOLCHAIN.map((name) => ({ name, installed: false })),
            present: [] as HostToolName[],
            missing: [...DEFAULT_TOOLCHAIN],
        };
        const steps = planToolchainInstall({ detected, os: 'linux', pmChoice: 'apt' });
        for (const s of steps) {
            const cmd = buildInstallCommand(s, { os: 'linux' });
            expect(cmd.tool).toBe(s.tool);
        }
    });

    it('confirms winget cannot do php or composer, so the planner routes them direct', () => {
        expect(pmCanInstall('winget', 'php')).toBe(false);
        expect(pmCanInstall('winget', 'composer')).toBe(false);
        const steps = planToolchainInstall({
            detected: {
                platform: 'win32',
                probes: [],
                present: ['git', 'node', 'npm', 'docker', 'claude-code', 'codex'],
                missing: ['php', 'composer'],
            },
            os: 'win32',
            pmChoice: 'winget',
        });
        expect(steps.map((s) => [s.tool, s.method])).toEqual([
            ['php', 'direct'],
            ['composer', 'direct'],
        ]);
    });
});

/**
 * The Toolchain Manager's per-tool UPDATE (#242 P2). An update targets a tool
 * that is ALREADY installed, so a package manager must UPGRADE it, not `install`
 * (winget/brew `install` on a present package is a no-op or a re-pin). npm-global
 * and direct downloads already fetch the latest, so their update IS their install.
 */
describe('buildInstallCommand — update intent', () => {
    it('winget upgrades by id, keeping the non-interactive flags', () => {
        expect(
            asRun(
                buildInstallCommand(
                    step({ tool: 'git', method: 'pm', packageManager: 'winget' }),
                    { os: 'win32' },
                    'update',
                ),
            ).args,
        ).toEqual([
            'upgrade',
            '--id',
            'Git.Git',
            '-e',
            '--silent',
            '--accept-source-agreements',
            '--accept-package-agreements',
        ]);
    });

    it('brew upgrades a formula', () => {
        expect(
            asRun(
                buildInstallCommand(
                    step({ tool: 'git', method: 'pm', packageManager: 'brew' }),
                    { os: 'darwin' },
                    'update',
                ),
            ).args,
        ).toEqual(['upgrade', 'git']);
    });

    it('brew upgrades a cask', () => {
        expect(
            asRun(
                buildInstallCommand(
                    step({ tool: 'docker', method: 'pm', packageManager: 'brew' }),
                    { os: 'darwin' },
                    'update',
                ),
            ).args,
        ).toEqual(['upgrade', '--cask', 'docker']);
    });

    it('apt upgrades ONLY an installed package — never re-adds a removed one', () => {
        expect(
            asRun(
                buildInstallCommand(
                    step({ tool: 'git', method: 'pm', packageManager: 'apt' }),
                    { os: 'linux' },
                    'update',
                ),
            ).args,
        ).toEqual(['install', '-y', '--only-upgrade', 'git']);
    });

    it('npm-global update is identical to its install (npm i -g fetches latest)', () => {
        const asStep = step({ tool: 'claude-code', method: 'npm-global' });
        expect(buildInstallCommand(asStep, { os: 'linux' }, 'update')).toEqual(
            buildInstallCommand(asStep, { os: 'linux' }, 'install'),
        );
    });

    it('defaults to install when no intent is given (back-compat)', () => {
        const asStep = step({ tool: 'git', method: 'pm', packageManager: 'winget' });
        expect(buildInstallCommand(asStep, { os: 'win32' })).toEqual(
            buildInstallCommand(asStep, { os: 'win32' }, 'install'),
        );
    });
});

/**
 * The Visual C++ runtime, both ways (genie#209). Genie installs it rather than
 * telling the user to go and fetch it — through winget where that exists, and
 * from Microsoft's own permanent short link where it does not (the same
 * no-winget Windows path php already needed).
 */
describe('buildInstallCommand — the VC++ runtime', () => {
    it('uses the winget package when a manager is available', () => {
        const cmd = buildInstallCommand(
            step({ tool: 'vcredist', method: 'pm', packageManager: 'winget' }),
            { os: 'win32' },
        );
        expect(cmd.via).toBe('run');
        if (cmd.via === 'run') {
            expect(cmd.command).toBe('winget');
            expect(cmd.args).toContain('Microsoft.VCRedist.2015+.x64');
        }
    });

    it('falls back to Microsoft’s permanent redirect, installed silently', () => {
        const cmd = asDownload(
            buildInstallCommand(step({ tool: 'vcredist', method: 'direct' }), { os: 'win32' }),
        );
        // aka.ms/vs/17/... is a stable Microsoft short link, so there is no
        // version to resolve and nothing that rots.
        expect(cmd.url).toBe('https://aka.ms/vs/17/release/vc_redist.x64.exe');
        expect(cmd.artifact).toBe('exe');
        expect(cmd.run?.args).toEqual(['/install', '/quiet', '/norestart']);
    });
});
