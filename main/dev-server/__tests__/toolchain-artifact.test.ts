import { describe, expect, it } from 'vitest';
import type { DownloadInstallCommand } from '../toolchain-adapters';
import { artifactRunCommand } from '../toolchain-artifact';

/**
 * How a DOWNLOADED installer is run is a pure decision — the argv depends only on
 * the artifact kind and the path — so it is separated from the spawn and asserted
 * directly. An artifact that needs multi-step handling this doesn't cover yet
 * (a zip to extract, a dmg to mount) reports `unsupported` rather than a
 * best-guess command that silently installs nothing.
 */

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
