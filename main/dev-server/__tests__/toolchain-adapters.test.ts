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

    it('installs node by the LTS id', () => {
        expect(build('node').args).toContain('OpenJS.NodeJS.LTS');
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
        expect(build('node').args).toEqual(['install', '-y', 'nodejs']);
        expect(build('php').args).toEqual(['install', '-y', 'php-cli']);
        expect(build('docker').args).toEqual(['install', '-y', 'docker.io']);
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

        const node = asDownload(buildInstallCommand(step({ tool: 'node', method: 'direct' }), { os: 'win32' }));
        expect(node.url).toBeNull();
        expect(node.source).toBe('nodejs-dist');

        const php = asDownload(buildInstallCommand(step({ tool: 'php', method: 'direct' }), { os: 'win32' }));
        expect(php.url).toBeNull();
        expect(php.source).toBe('php-windows');
    });

    it('declares node’s zip as wrapping its contents, and php’s as flat (genie#209)', () => {
        // node-vX.Y.Z-win-<arch>.zip holds one top-level directory and nothing at
        // its root; the php nts zip holds php.exe/php-cgi.exe at its root. The
        // extract step reads this to decide which directory goes on PATH — get it
        // wrong and node "installs" with nothing runnable on PATH.
        const node = asDownload(buildInstallCommand(step({ tool: 'node', method: 'direct' }), { os: 'win32' }));
        expect(node.wrapperDir).toBe('archive-name');

        const php = asDownload(buildInstallCommand(step({ tool: 'php', method: 'direct' }), { os: 'win32' }));
        expect(php.wrapperDir).toBeUndefined();
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
                const cmd = asRun(buildInstallCommand(step({ tool, method: 'pm', packageManager: pm }), { os: 'linux' }));
                expect(cmd.args.join(' ')).toContain(PM_PACKAGES[pm][tool]!.id);
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
