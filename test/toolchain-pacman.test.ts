import { describe, expect, it } from 'vitest';
import { HOST_TOOLS, pacmanInstalls, planInstall, planUpdate, pacmanSteps } from '../src/core/toolchain.js';
import { pacmanVersion, parsePacmanQ, parsePacmanSi, parsePacmanTargets, upgradedByInstall } from '../src/core/pacman.js';
import type { ElevatedBatch as ElevateBatch, ElevatedResult as ElevateResult } from '../src/core/elevation.js';
import { detectPackageManager, installTool, type ToolchainOpsPorts } from '../src/main/toolchain-ops.js';
import { pacmanSync, withPacmanLatest } from '../src/main/pacman.js';
import { runUpdate, type CommandRunner } from '../src/main/toolchain-prober.js';

/**
 * PACMAN ON ARCH / OMARCHY (Tynn #968). Measured on omarchy-genie (jobs 1125-191309-39cf81, 1125-191913-5de173): pacman
 * and yay are on the machine, the image has NO sync databases (only `offline.db`), `pacman -Sy` needs root, and
 * `checkupdates` (pacman-contrib) refreshes its OWN copy of the sync databases without root. So:
 *   - detection: `pacman --version` answers;
 *   - what is installed and its version: `pacman -Q`; what the repositories have: `pacman -Si --dbpath <Genie's copy>`
 *     after `checkupdates` refreshed that copy, without root;
 *   - THE SYNC RULE, no partial upgrade: an install goes ahead only when `pacman -Sp` against that fresh copy says it
 *     adds packages and upgrades NONE already installed (an update may upgrade only the tool's own package); otherwise it
 *     is refused by name. Then ONE elevated batch: `pacman -Sy`, `pacman -S --needed --noconfirm <pkg>`;
 *   - official repositories only (core, extra, multilib): a package they do not have is refused by name, never handed
 *     to yay.
 * The runner and the elevation are fakes; every test counts what ran.
 */

const PACMAN_IDS = { php: 'php', composer: 'composer', node: 'nodejs', python: 'python', go: 'go', git: 'git', docker: 'docker' } as const;
/**
 * What pacman installs for a tool: its package, and for PHP also `php-cgi`. Arch splits it out, and php-cgi is what Genie
 * runs a site with and how it finds the system PHP (main/php-versions.ts asks `php-cgi -v`). The toolchain row
 * 1125-195556-df6ca9 installed `php` alone: `php --version` answered, the card still read "not here".
 */
const pkgsOf = (tool: string, pkg: string): string[] => (tool === 'php' ? ['php', 'php-cgi'] : [pkg]);

describe('the pacman table and plans, per tool', () => {
    it('maps every tool Arch packages to its official package, and only those', () => {
        const ids = Object.fromEntries(HOST_TOOLS.filter((t) => t.packages.pacman).map((t) => [t.name, t.packages.pacman]));
        expect(ids).toEqual(PACMAN_IDS);
    });

    for (const [tool, pkg] of Object.entries(PACMAN_IDS)) {
        it(`${tool}: install is ONE elevated batch, sync then \`pacman -S --needed --noconfirm ${pkgsOf(tool, pkg).join(' ')}\`, with no pkexec or sudo`, () => {
            const plan = planInstall({ tool, platform: 'linux', packageManager: 'pacman' });
            const pkgs = pkgsOf(tool, pkg);
            expect(plan).toEqual({
                label: `pacman -S --needed --noconfirm ${pkgs.join(' ')} (as administrator)`,
                manager: 'pacman',
                elevated: true,
                items: pkgs,
                steps: [{ command: 'pacman', args: ['-Sy'] }, { command: 'pacman', args: ['-S', '--needed', '--noconfirm', ...pkgs] }],
            });
        });
    }

    it('update: git and docker through the same batch; tools with their own updater keep it', () => {
        for (const [tool, pkg] of [['git', 'git'], ['docker', 'docker'], ['php', 'php'], ['node', 'nodejs'], ['python', 'python'], ['go', 'go']] as const) {
            const pkgs = pkgsOf(tool, pkg);
            expect(planUpdate({ tool, platform: 'linux', packageManager: 'pacman' })).toEqual({
                command: `pacman -S --needed --noconfirm ${pkgs.join(' ')}`,
                manager: 'pacman',
                elevated: true,
                items: pkgs,
                steps: [{ command: 'pacman', args: ['-Sy'] }, { command: 'pacman', args: ['-S', '--needed', '--noconfirm', ...pkgs] }],
            });
        }
        expect(planUpdate({ tool: 'composer', platform: 'linux', packageManager: 'pacman' })).toEqual({ command: 'composer self-update', manager: 'composer' });
        expect(planUpdate({ tool: 'rustc', platform: 'linux', packageManager: 'pacman' })).toEqual({ command: 'rustup update stable', manager: 'rustup' });
    });

    it('tools pacman does not carry are refused by name; nothing says "no package manager found"', () => {
        expect(planInstall({ tool: 'npm', platform: 'linux', packageManager: 'pacman' })).toEqual({ refused: 'npm comes with Node; install node and it is there' });
        for (const tool of HOST_TOOLS.map((t) => t.name)) {
            const p = planInstall({ tool, platform: 'linux', packageManager: 'pacman' });
            if ('refused' in p) expect(p.refused).not.toMatch(/no package manager/i);
        }
    });

    it('a package name reaches a step only when it is an Arch package name: no option, no shell, no path', () => {
        expect(pacmanSteps(['git'])).toEqual({ steps: [{ command: 'pacman', args: ['-Sy'] }, { command: 'pacman', args: ['-S', '--needed', '--noconfirm', 'git'] }] });
        expect(pacmanSteps(['python-pip', 'lib32-glibc', 'gtk+3', 'perl-io-socket-ssl', 'r9.g5@x_y'])).toHaveProperty('steps');
        for (const bad of ['-Syu', '--overwrite=*', 'git;rm -rf /', 'Git', '', '../x', 'a b', '.hidden', 'x'.repeat(200), 'git\n']) {
            expect(pacmanSteps([bad])).toEqual({ refused: `${JSON.stringify(bad)} is not an Arch package name Genie will hand to pacman` });
        }
        expect(pacmanSteps([])).toEqual({ refused: 'nothing to install' });
    });

    it('what a batch installs is read from its own pacman -S steps, never from the prompt\'s items (which may name actions)', () => {
        expect(pacmanInstalls([{ command: 'pacman', args: ['-Sy'] }, { command: 'pacman', args: ['-S', '--needed', '--noconfirm', 'php', 'php-cgi'] }, { command: 'systemctl', args: ['enable', '--now', 'docker.socket'] }])).toEqual(['php', 'php-cgi']);
        expect(pacmanInstalls([{ command: 'systemctl', args: ['start', 'x'] }])).toEqual([]);
    });
});

// --- the parsers, over output captured on omarchy-genie -------------------------------------------------------------

const Q_OUT = 'git 2.56.0-1\ndocker 1:29.9.2-1\npython 3.14.8-1\npacman 7.1.0.r9.g54d9411-3\n';
const SI_OUT = `Repository      : extra
Name            : git
Version         : 2.56.0-1
Description     : the fast distributed version control system
Depends On      : curl  expat  perl-error

Repository      : extra
Name            : docker
Version         : 1:29.9.2-1

Repository      : omarchy
Name            : yay
Version         : 13.0.1-1
`;

describe('pacman output, parsed', () => {
    it('pacman -Q: name and full version per line; anything else is skipped', () => {
        expect(parsePacmanQ(`warning: database file for 'core' does not exist (use '-Sy' to download)\n${Q_OUT}error: package 'php' was not found\n`)).toEqual(
            new Map([['git', '2.56.0-1'], ['docker', '1:29.9.2-1'], ['python', '3.14.8-1'], ['pacman', '7.1.0.r9.g54d9411-3']]),
        );
        expect(parsePacmanQ('')).toEqual(new Map());
    });

    it('a pacman version as the tool says it: no epoch, no pkgrel', () => {
        expect(pacmanVersion('2.56.0-1')).toBe('2.56.0');
        expect(pacmanVersion('1:29.9.2-1')).toBe('29.9.2');
        expect(pacmanVersion('8.5.12-1')).toBe('8.5.12');
        expect(pacmanVersion('2.56.1-1.1')).toBe('2.56.1');
    });

    it('pacman -Si: each package block, its repository and version', () => {
        expect(parsePacmanSi(SI_OUT)).toEqual(new Map([
            ['git', { repository: 'extra', version: '2.56.0-1' }],
            ['docker', { repository: 'extra', version: '1:29.9.2-1' }],
            ['yay', { repository: 'omarchy', version: '13.0.1-1' }],
        ]));
        expect(parsePacmanSi("error: package 'nope' was not found\n")).toEqual(new Map());
    });

    it("pacman -Sp --print-format '%n %v': the transaction's packages", () => {
        expect(parsePacmanTargets('php 8.5.12-1\nicu 78.1-1\n\n')).toEqual([{ name: 'php', version: '8.5.12-1' }, { name: 'icu', version: '78.1-1' }]);
        expect(parsePacmanTargets(':: Synchronizing\nwarning: x\n')).toEqual([]);
    });

    it('the partial-upgrade rule: an installed package the transaction would upgrade, other than the one asked for', () => {
        const installed = parsePacmanQ('git 2.55.0-1\nicu 77.1-1\nreadline 8.3-1\n');
        expect(upgradedByInstall([{ name: 'php', version: '8.5.12-1' }, { name: 'libzip', version: '1.11-1' }], installed, [])).toEqual([]);
        expect(upgradedByInstall([{ name: 'php', version: '8.5.12-1' }, { name: 'icu', version: '78.1-1' }], installed, [])).toEqual(['icu 77.1-1 → 78.1-1']);
        // An update upgrades its own package, and only that.
        expect(upgradedByInstall([{ name: 'git', version: '2.56.0-1' }], installed, ['git'])).toEqual([]);
        expect(upgradedByInstall([{ name: 'git', version: '2.56.0-1' }, { name: 'readline', version: '8.3-2' }], installed, ['git'])).toEqual(['readline 8.3-1 → 8.3-2']);
    });
});

// --- the machine side -----------------------------------------------------------------------------------------------

type Call = { binary: string; args: readonly string[]; env?: Readonly<Record<string, string>> | undefined };

/** An Arch machine: pacman and yay answer, `pkg` is absent until an elevated batch installs it. */
function arch(opts: { tool: string; pkg: string; banner: string; si?: string; sp?: string; q?: string; checkupdatesExit?: number }) {
    const calls: Call[] = [];
    const batches: ElevateBatch[] = [];
    let installed = false;
    const run: CommandRunner = async (binary, args, options) => {
        calls.push({ binary, args, env: options?.env });
        if (binary === 'pacman' && args[0] === '--version') return { stdout: 'Pacman v7.1.0 - libalpm v16.0.1', exitCode: 0 };
        if (binary === 'checkupdates') return { stdout: '', exitCode: opts.checkupdatesExit ?? 2 };
        if (binary === 'pacman' && args[0] === '-Si') return { stdout: opts.si ?? `Repository      : extra\nName            : ${opts.pkg}\nVersion         : 2.56.1-1\n`, exitCode: opts.si === '' ? 1 : 0 };
        if (binary === 'pacman' && args[0] === '-Sp') return { stdout: opts.sp ?? `${opts.pkg} 2.56.1-1\n`, exitCode: 0 };
        if (binary === 'pacman' && args[0] === '-Q') return { stdout: opts.q ?? 'pacman 7.1.0.r9.g54d9411-3\nicu 77.1-1\n', exitCode: 0 };
        if (binary === 'yay' && args[0] === '--version') return { stdout: 'yay v13.0.1', exitCode: 0 };
        if (binary === opts.tool && installed) return { stdout: opts.banner, exitCode: 0 };
        throw Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' });
    };
    const elevate = async (batch: ElevateBatch): Promise<ElevateResult> => {
        batches.push(batch);
        installed = true;
        return { kind: 'ran', exitCode: 0, output: '', failedStep: null };
    };
    const ports: ToolchainOpsPorts = {
        platform: 'linux',
        run,
        env: { get: () => undefined, set: () => {} },
        fs: { exists: () => false, readText: () => null, writeText: () => {}, mkdirp: () => {}, remove: () => {} },
        dataDir: '/home/genie/.genie/genie2-toolchain',
        systemRoot: '',
        packageManager: async () => 'pacman',
        elevate,
        progress: () => {},
    };
    return { calls, batches, ports, run, elevate };
}

describe('which package manager is here, on Arch', () => {
    it('pacman, when it is the one that answers (after apt-get and dnf)', async () => {
        const asked: string[] = [];
        const only: CommandRunner = async (b) => { asked.push(b); if (b === 'pacman') return { stdout: 'Pacman v7.1.0', exitCode: 0 }; throw new Error('ENOENT'); };
        expect(await detectPackageManager('linux', only)).toBe('pacman');
        expect(asked).toEqual(['apt-get', 'dnf', 'pacman']);
    });
});

describe('the sync database Genie reads, without root', () => {
    it('checkupdates refreshes Genie\'s own copy (CHECKUPDATES_DB), then pacman -Si reads it; refreshed once in its window', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: 'git version 2.56.0', si: SI_OUT });
        let now = 1_000_000;
        const sync = pacmanSync({ run: m.run, dbPath: '/home/genie/.genie/genie2-toolchain/pacman-sync', now: () => now });
        expect(await sync.info(['git', 'docker'])).toEqual(parsePacmanSi(SI_OUT));
        await sync.info(['git']);
        const refreshes = m.calls.filter((c) => c.binary === 'checkupdates');
        expect(refreshes).toHaveLength(1);
        expect(refreshes[0]!.env).toEqual({ CHECKUPDATES_DB: '/home/genie/.genie/genie2-toolchain/pacman-sync' });
        expect(m.calls.find((c) => c.args[0] === '-Si')!.args).toEqual(['-Si', '--dbpath', '/home/genie/.genie/genie2-toolchain/pacman-sync', 'git', 'docker']);
        now += 31 * 60_000;
        await sync.info(['git']);
        expect(m.calls.filter((c) => c.binary === 'checkupdates')).toHaveLength(2);
        // Nothing here runs as root.
        expect(m.calls.some((c) => ['sudo', 'pkexec'].includes(c.binary))).toBe(false);
    });

    it('a refresh that fails (exit 1) is no sync database: null, never a guess', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: '', checkupdatesExit: 1 });
        const sync = pacmanSync({ run: m.run, dbPath: '/db', now: () => 0 });
        expect(await sync.info(['git'])).toBeNull();
    });

    it('latest for a pacman tool comes from the sync database, as the tool says its version', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: '', si: SI_OUT });
        const sync = pacmanSync({ run: m.run, dbPath: '/db', now: () => 0 });
        const latest = withPacmanLatest(async () => null, { packageManager: async () => 'pacman', sync });
        expect(await latest('git')).toEqual({ version: '2.56.0', source: 'pacman (extra)' });
        expect(await latest('docker')).toEqual({ version: '29.9.2', source: 'pacman (extra)' });
        // Not a pacman tool: the other sources answer, as before.
        const other = withPacmanLatest(async (t) => (t === 'claude-code' ? { version: '3.0.0', source: 'npm' } : null), { packageManager: async () => 'pacman', sync });
        expect(await other('claude-code')).toEqual({ version: '3.0.0', source: 'npm' });
        // Not on Arch: untouched.
        const apt = withPacmanLatest(async () => null, { packageManager: async () => 'apt', sync });
        expect(await apt('git')).toBeNull();
    });
});

describe('installing with pacman', () => {
    it('checks the transaction, then runs ONE elevated batch naming the package, and judges by the re-probe', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: 'git version 2.56.1' });
        const r = await installTool('git', true, m.ports);
        expect(r).toEqual({ kind: 'installed', version: '2.56.1' });
        expect(m.batches).toEqual([{
            title: 'Install git',
            items: ['git'],
            steps: [{ command: 'pacman', args: ['-Sy'] }, { command: 'pacman', args: ['-S', '--needed', '--noconfirm', 'git'] }],
        }]);
        expect(m.calls.find((c) => c.args[0] === '-Sp')!.args).toEqual(['-Sp', '--print-format', '%n %v', '--needed', '--dbpath', '/home/genie/.genie/genie2-toolchain/pacman-sync', 'git']);
        // No step ran outside the elevation as root, and pacman -S itself never ran unelevated.
        expect(m.calls.some((c) => ['sudo', 'pkexec'].includes(c.binary) || (c.binary === 'pacman' && c.args[0] === '-S'))).toBe(false);
    });

    it('REFUSES an install that would upgrade an installed package (a partial upgrade), by name, and asks for nothing', async () => {
        const m = arch({ tool: 'php', pkg: 'php', banner: 'PHP 8.5.12 (cli)', sp: 'php 8.5.12-1\nphp-cgi 8.5.12-1\nicu 78.1-1\n', si: 'Repository      : extra\nName            : php\nVersion         : 8.5.12-1\n\nRepository      : extra\nName            : php-cgi\nVersion         : 8.5.12-1\n' });
        const r = await installTool('php', true, m.ports);
        expect(r).toEqual({ kind: 'refused', reason: 'installing php with pacman would also upgrade icu 77.1-1 → 78.1-1, a partial upgrade Arch does not support; update the whole system first (omarchy-update, or pacman -Syu), then install php' });
        expect(m.batches).toEqual([]);
    });

    it('PHP: php and php-cgi, each checked in the official repositories and in the transaction, under ONE prompt', async () => {
        const si = 'Repository      : extra\nName            : php\nVersion         : 8.5.12-1\n\nRepository      : extra\nName            : php-cgi\nVersion         : 8.5.12-1\n';
        const m = arch({ tool: 'php', pkg: 'php', banner: 'PHP 8.5.12 (cli)', si, sp: 'php 8.5.12-1\nphp-cgi 8.5.12-1\n' });
        expect(await installTool('php', true, m.ports)).toEqual({ kind: 'installed', version: '8.5.12' });
        expect(m.calls.find((c) => c.args[0] === '-Si')!.args.slice(-2)).toEqual(['php', 'php-cgi']);
        expect(m.calls.find((c) => c.args[0] === '-Sp')!.args.slice(-2)).toEqual(['php', 'php-cgi']);
        expect(m.batches).toEqual([{ title: 'Install php', items: ['php', 'php-cgi'], steps: [{ command: 'pacman', args: ['-Sy'] }, { command: 'pacman', args: ['-S', '--needed', '--noconfirm', 'php', 'php-cgi'] }] }]);
    });

    it('PHP: php-cgi missing from the repositories refuses the whole install, by name', async () => {
        const m = arch({ tool: 'php', pkg: 'php', banner: '', si: 'Repository      : extra\nName            : php\nVersion         : 8.5.12-1\n' });
        expect(await installTool('php', true, m.ports)).toEqual({ kind: 'refused', reason: "php-cgi is not in Arch's official repositories here (core, extra, multilib); Genie does not install from the AUR, so yay is not used" });
        expect(m.batches).toEqual([]);
    });

    it('a package the official repositories do not have is refused by name, never handed to yay', async () => {
        const m = arch({ tool: 'composer', pkg: 'composer', banner: '', si: '' });
        const r = await installTool('composer', true, m.ports);
        expect(r).toEqual({ kind: 'refused', reason: "composer is not in Arch's official repositories here (core, extra, multilib); Genie does not install from the AUR, so yay is not used" });
        expect(m.batches).toEqual([]);
        expect(m.calls.some((c) => c.binary === 'yay' && c.args[0] !== '--version')).toBe(false);
    });

    it('a package only another repository has (not core, extra, multilib) is refused the same way', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: '', si: 'Repository      : omarchy\nName            : git\nVersion         : 9.9.9-1\n' });
        expect(await installTool('git', true, m.ports)).toMatchObject({ kind: 'refused', reason: expect.stringContaining("git is not in Arch's official repositories") });
        expect(m.batches).toEqual([]);
    });

    it('no sync database could be read: refused with why; nothing is elevated', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: '', checkupdatesExit: 1 });
        expect(await installTool('git', true, m.ports)).toEqual({ kind: 'refused', reason: "Genie could not read Arch's package databases (checkupdates failed), so it cannot check that installing git upgrades nothing else; nothing was installed" });
        expect(m.batches).toEqual([]);
    });

    it('an update with no way to ask is refused, never a hang', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: 'git version 2.55.0' });
        expect(await runUpdate('git', { platform: 'linux', packageManager: 'pacman', pacman: pacmanSync({ run: m.run, dbPath: '/db', now: () => 0 }) }, m.run, null)).toEqual({ kind: 'refused', reason: 'updating git needs the administrator password, and no Genie window is connected to ask for it; nothing was updated' });
    });

    it('a host with no way to ask for the password refuses before anything runs', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: '' });
        const { elevate: _drop, ...ports } = m.ports;
        void _drop;
        expect(await installTool('git', true, ports)).toEqual({ kind: 'refused', reason: 'installing git needs the administrator password, and no Genie window is connected to ask for it; nothing was installed' });
    });

    it('the prompt refused (no client, or the password wrong three times): refused with its words', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: '' });
        const r = await installTool('git', true, { ...m.ports, elevate: async () => ({ kind: 'refused', reason: 'the password was wrong three times' }) });
        expect(r).toEqual({ kind: 'refused', reason: 'the password was wrong three times' });
    });

    it('a step that failed says which, with pacman\'s own words', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: '' });
        const r = await installTool('git', true, { ...m.ports, elevate: async () => ({ kind: 'ran', exitCode: 1, output: 'error: failed to synchronize all databases', failedStep: 0 }) });
        expect(r).toMatchObject({ kind: 'not-installed', reason: expect.stringContaining('“error: failed to synchronize all databases”') });
    });
});

describe('updating with pacman', () => {
    it('git: the same check (only git may move), ONE elevated batch, judged by what git answers after', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: 'git version 2.56.1', q: 'git 2.55.0-1\n' });
        let version = '2.55.0';
        const run: CommandRunner = async (b, a, o) => (b === 'git' ? { stdout: `git version ${version}`, exitCode: 0 } : m.run(b, a, o));
        const batches: ElevateBatch[] = [];
        const elevate = async (batch: ElevateBatch): Promise<ElevateResult> => { batches.push(batch); version = '2.56.1'; return { kind: 'ran', exitCode: 0, output: '', failedStep: null }; };
        const sync = pacmanSync({ run, dbPath: '/db', now: () => 0 });
        const r = await runUpdate('git', { platform: 'linux', packageManager: 'pacman', pacman: sync }, run, null, undefined, elevate);
        expect(r).toEqual({ kind: 'repaired', from: '2.55.0', to: '2.56.1' });
        expect(batches).toEqual([{ title: 'Update git', items: ['git'], steps: [{ command: 'pacman', args: ['-Sy'] }, { command: 'pacman', args: ['-S', '--needed', '--noconfirm', 'git'] }] }]);
    });

    it('git: an update that would upgrade another installed package is refused by name', async () => {
        const m = arch({ tool: 'git', pkg: 'git', banner: 'git version 2.55.0', q: 'git 2.55.0-1\nperl 5.40-1\n', sp: 'git 2.56.1-1\nperl 5.42-1\n' });
        const elevate = async (): Promise<ElevateResult> => { throw new Error('must not elevate'); };
        const r = await runUpdate('git', { platform: 'linux', packageManager: 'pacman', pacman: pacmanSync({ run: m.run, dbPath: '/db', now: () => 0 }) }, m.run, null, undefined, elevate);
        expect(r).toEqual({ kind: 'refused', reason: 'updating git with pacman would also upgrade perl 5.40-1 → 5.42-1, a partial upgrade Arch does not support; update the whole system first (omarchy-update, or pacman -Syu), then update git' });
    });
});
