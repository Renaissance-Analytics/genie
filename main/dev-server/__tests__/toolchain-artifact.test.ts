import { describe, expect, it } from 'vitest';
import type { DownloadInstallCommand } from '../toolchain-adapters';
import { artifactInstallPlan, artifactRunCommand } from '../toolchain-artifact';

/**
 * How a DOWNLOADED installer is run is a pure decision — the argv depends only on
 * the artifact kind and the path — so it is separated from the spawn and asserted
 * directly. An artifact that needs multi-step handling this doesn't cover yet
 * (a zip to extract, a dmg to mount) reports `unsupported` rather than a
 * best-guess command that silently installs nothing.
 */

/** The win32 path separator. (A template literal cannot END in a backslash, so
 *  this is a plain escaped string.) */
const SEP = '\\';

const dl = (over: Partial<DownloadInstallCommand>): DownloadInstallCommand => ({
    via: 'download',
    tool: 'docker',
    label: 'x',
    requiresElevation: true,
    requiresRestart: false,
    url: 'https://example/x',
    artifact: 'exe',
    ...over,
});

describe('artifactRunCommand', () => {
    it('runs an .exe installer with its own args (Docker Desktop / Git for Windows)', () => {
        const cmd = artifactRunCommand(dl({ artifact: 'exe', run: { args: ['install', '--quiet'] } }), 'C:/t/x.exe');
        expect(cmd).toEqual({ run: { command: 'C:/t/x.exe', args: ['install', '--quiet'] } });
    });

    it('runs an .exe with no args when none were given', () => {
        const cmd = artifactRunCommand(dl({ artifact: 'exe' }), 'C:/t/x.exe');
        expect(cmd).toEqual({ run: { command: 'C:/t/x.exe', args: [] } });
    });

    it('installs an .msi via msiexec, quiet and no auto-reboot', () => {
        const cmd = artifactRunCommand(dl({ artifact: 'msi' }), 'C:/t/x.msi');
        expect(cmd).toEqual({ run: { command: 'msiexec', args: ['/i', 'C:/t/x.msi', '/quiet', '/norestart'] } });
    });

    it('installs a macOS .pkg via the installer tool', () => {
        const cmd = artifactRunCommand(dl({ artifact: 'pkg' }), '/tmp/x.pkg');
        expect(cmd).toEqual({ run: { command: 'installer', args: ['-pkg', '/tmp/x.pkg', '-target', '/'] } });
    });

    it('runs a shell install script (the get.docker.com convenience script)', () => {
        const cmd = artifactRunCommand(dl({ artifact: 'script' }), '/tmp/get-docker.sh');
        expect(cmd).toEqual({ run: { command: 'sh', args: ['/tmp/get-docker.sh'] } });
    });

    it('reports the artifacts it does not yet run itself, rather than guessing', () => {
        expect(artifactRunCommand(dl({ artifact: 'zip' }), '/tmp/x.zip')).toEqual({
            unsupported: 'zip',
        });
        expect(artifactRunCommand(dl({ artifact: 'dmg' }), '/tmp/x.dmg')).toEqual({
            unsupported: 'dmg',
        });
        expect(artifactRunCommand(dl({ artifact: 'phar' }), '/tmp/composer.phar')).toEqual({
            unsupported: 'phar',
        });
    });
});

/**
 * ZIP + PHAR — the two artifacts a fresh WINDOWS machine actually needs (#205).
 *
 * winget has no php and no composer, so both take the direct path: php arrives
 * as a zip of loose binaries, composer as a phar that is not executable by
 * itself. Neither is "run the installer" — a zip must be EXTRACTED somewhere and
 * that somewhere put on PATH, and a phar must be PLACED next to a launcher that
 * knows to feed it to php. Until this existed, both returned `unsupported` and a
 * Windows machine simply could not finish setup.
 *
 * Everything here is the DECISION — which directory, which argv, what the shim
 * says. The fs writes and the PATH persistence are the impure layer's.
 */
describe('artifactInstallPlan — zip (php on Windows)', () => {
    // Forward slashes (the convention above, and valid on Windows) so the
    // assertions stay readable; only the SEPARATOR joinFor adds is win32-specific.
    const ctx = { toolsDir: 'C:/g/tools', binDir: 'C:/g/tools/bin', os: 'win32' as const };
    const php = (): DownloadInstallCommand => ({
        via: 'download',
        tool: 'php',
        url: null,
        source: 'php-windows',
        artifact: 'zip',
        label: 'download php',
        requiresElevation: false,
        requiresRestart: false,
    });

    it('extracts into a per-tool directory under Genie, not somewhere global', () => {
        // A Genie-owned directory: no elevation, nothing of the user's is
        // overwritten, and uninstalling is deleting one folder.
        const plan = artifactInstallPlan(php(), 'C:/tmp/php.zip', ctx);
        expect(plan).toMatchObject({
            kind: 'extract',
            zip: 'C:/tmp/php.zip',
            dest: `C:/g/tools${SEP}php`,
            // php.exe sits at the root of the archive, so the extract dir IS
            // what goes on PATH.
            pathAdd: `C:/g/tools${SEP}php`,
        });
    });

    it('uses PowerShell Expand-Archive on Windows', () => {
        const plan = artifactInstallPlan(php(), 'C:/tmp/php.zip', ctx);
        if (plan.kind !== 'extract') throw new Error('expected an extract plan');
        expect(plan.command).toBe('powershell');
        expect(plan.args.join(' ')).toContain('Expand-Archive');
        // -Force so a re-run overwrites a half-extracted attempt instead of
        // failing on "already exists".
        expect(plan.args.join(' ')).toContain('-Force');
    });

    it('uses unzip off Windows', () => {
        const plan = artifactInstallPlan(php(), '/tmp/php.zip', {
            toolsDir: '/g/tools',
            binDir: '/g/tools/bin',
            os: 'linux',
        });
        if (plan.kind !== 'extract') throw new Error('expected an extract plan');
        expect(plan.command).toBe('unzip');
        expect(plan.args).toEqual(['-o', '/tmp/php.zip', '-d', '/g/tools/php']);
    });
});

/**
 * NOT every archive unpacks flat (genie#209).
 *
 * The php-windows zips do — php.exe and php-cgi.exe sit at the root. Node's do
 * NOT: `node-v24.19.0-win-x64.zip` holds exactly one top-level directory and
 * zero root-level entries (verified against the real archive). Putting the
 * extract directory on PATH would therefore add a directory containing nothing
 * executable — node "installs", npm is then missing, and the agent TUIs skip.
 */
describe('artifactInstallPlan — zip with a wrapper directory (node)', () => {
    const ctx = { toolsDir: 'C:/g/tools', binDir: 'C:/g/tools/bin', os: 'win32' as const };
    const node = (): DownloadInstallCommand => ({
        via: 'download',
        tool: 'node',
        url: null,
        source: 'nodejs-dist',
        artifact: 'zip',
        wrapperDir: 'archive-name',
        label: 'download node',
        requiresElevation: false,
        requiresRestart: false,
    });

    it('puts the wrapper directory on PATH, not the extract root', () => {
        const plan = artifactInstallPlan(node(), 'C:/tmp/node-v24.19.0-win-x64.zip', ctx);
        expect(plan).toMatchObject({
            kind: 'extract',
            dest: `C:/g/tools${SEP}node`,
            // node.exe lives one level down, in the directory the archive names
            // after itself.
            pathAdd: `C:/g/tools${SEP}node${SEP}node-v24.19.0-win-x64`,
        });
    });

    it('leaves an archive that does not declare a wrapper flat (php)', () => {
        const { wrapperDir: _drop, ...flat } = node();
        const plan = artifactInstallPlan(
            { ...flat, tool: 'php', source: 'php-windows' },
            'C:/tmp/php-8.4.24-nts-Win32-vs17-x64.zip',
            ctx,
        );
        expect(plan).toMatchObject({ pathAdd: `C:/g/tools${SEP}php` });
    });
});

describe('artifactInstallPlan — phar (composer)', () => {
    const composer = (): DownloadInstallCommand => ({
        via: 'download',
        tool: 'composer',
        url: 'https://getcomposer.org/composer-stable.phar',
        artifact: 'phar',
        needs: 'php',
        label: 'download composer',
        requiresElevation: false,
        requiresRestart: false,
    });

    it('places the phar in the bin dir with a launcher beside it', () => {
        const plan = artifactInstallPlan(composer(), 'C:/tmp/composer.phar', {
            toolsDir: 'C:/g/tools',
            binDir: 'C:/g/tools/bin',
            os: 'win32',
        });
        expect(plan).toMatchObject({
            kind: 'phar',
            to: `C:/g/tools/bin${SEP}composer.phar`,
            shimPath: `C:/g/tools/bin${SEP}composer.bat`,
            pathAdd: 'C:/g/tools/bin',
        });
    });

    it('the Windows shim feeds the phar to php and forwards every argument', () => {
        const plan = artifactInstallPlan(composer(), 'C:/tmp/composer.phar', {
            toolsDir: 'C:/g/tools',
            binDir: 'C:/g/tools/bin',
            os: 'win32',
        });
        if (plan.kind !== 'phar') throw new Error('expected a phar plan');
        // `%~dp0` keeps it relative to the shim, so moving the tools dir does
        // not break it; `%*` forwards args or `composer require x` loses `x`.
        expect(plan.shimBody).toContain('%~dp0composer.phar');
        expect(plan.shimBody).toContain('%*');
    });

    it('the posix shim is an exec-ing sh script', () => {
        const plan = artifactInstallPlan(composer(), '/tmp/composer.phar', {
            toolsDir: '/g/tools',
            binDir: '/g/tools/bin',
            os: 'linux',
        });
        if (plan.kind !== 'phar') throw new Error('expected a phar plan');
        expect(plan.shimPath).toBe('/g/tools/bin/composer');
        expect(plan.shimBody).toContain('#!/bin/sh');
        expect(plan.shimBody).toContain('"$@"');
        expect(plan.executable).toBe(true);
    });
});

describe('artifactInstallPlan — the kinds that were already handled', () => {
    const ctx = { toolsDir: '/g/tools', binDir: '/g/tools/bin', os: 'win32' as const };
    it('still runs an exe installer with its own silent args', () => {
        const plan = artifactInstallPlan(
            {
                via: 'download',
                tool: 'docker',
                url: 'https://x/Docker.exe',
                artifact: 'exe',
                run: { args: ['install', '--quiet'] },
                label: 'docker',
                requiresElevation: true,
                requiresRestart: true,
            },
            'C:/tmp/Docker.exe',
            ctx,
        );
        expect(plan).toMatchObject({
            kind: 'run',
            command: 'C:/tmp/Docker.exe',
            args: ['install', '--quiet'],
        });
    });

    it('still reports a dmg as unsupported rather than guessing', () => {
        const plan = artifactInstallPlan(
            {
                via: 'download',
                tool: 'docker',
                url: 'https://x/Docker.dmg',
                artifact: 'dmg',
                label: 'docker',
                requiresElevation: false,
                requiresRestart: false,
            },
            '/tmp/Docker.dmg',
            { toolsDir: '/g/tools', binDir: '/g/tools/bin', os: 'darwin' },
        );
        expect(plan).toEqual({ kind: 'unsupported', artifact: 'dmg' });
    });
});
