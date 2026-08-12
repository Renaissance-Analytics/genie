import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../container-runtime';
import type { DownloadInstallCommand, InstallCommand, RunInstallCommand } from '../toolchain-adapters';
import { createPerformInstall } from '../toolchain-perform';
import type { PerformDeps } from '../toolchain-perform';

/**
 * `createPerformInstall` is the ROUTER between the executor's decisions and the
 * real world: given a materialised command it either runs an argv (package
 * managers, `npm i -g`) or fetches an artifact and runs it (direct downloads),
 * propagating the elevation flag and resolving a versioned URL first when the
 * adapter left one to resolve. The actual spawn / HTTP / filesystem are its
 * injected seams; what is tested here is the routing, the sequencing, and that a
 * failure at any stage becomes a clean `{ ok: false }` rather than a throw.
 */

const RUN_OK: CommandResult = { code: 0, stdout: '', stderr: '' };
const RUN_FAIL: CommandResult = { code: 1, stdout: '', stderr: 'winget: install failed' };

const WIN = { os: 'win32' as const, arch: 'x64' as const };

const runCmd = (over: Partial<RunInstallCommand> = {}): RunInstallCommand => ({
    via: 'run',
    tool: 'git',
    label: 'winget install Git.Git',
    requiresElevation: false,
    requiresRestart: false,
    command: 'winget',
    args: ['install', '--id', 'Git.Git'],
    ...over,
});

const downloadCmd = (over: Partial<DownloadInstallCommand> = {}): DownloadInstallCommand => ({
    via: 'download',
    tool: 'docker',
    label: 'download Docker Desktop installer',
    requiresElevation: true,
    requiresRestart: true,
    url: 'https://desktop.docker.com/win/main/amd64/Docker Desktop Installer.exe',
    artifact: 'exe',
    ...over,
});

/** Deps that record calls and return configurable outcomes. */
function deps(over: Partial<PerformDeps> = {}) {
    const calls = {
        run: [] as { command: string; args: string[]; elevated: boolean }[],
        resolved: [] as string[],
        downloaded: [] as string[],
        installed: [] as InstallCommand[],
        verified: [] as string[],
    };
    const base: PerformDeps = {
        async run(command, args, opts) {
            calls.run.push({ command, args, elevated: opts.elevated });
            return RUN_OK;
        },
        async resolveDownloadUrl(source) {
            calls.resolved.push(source);
            return `https://resolved.example/${source}`;
        },
        async download(url) {
            calls.downloaded.push(url);
            return { ok: true, path: `/tmp/${url.split('/').pop()}` };
        },
        async installArtifact(command) {
            calls.installed.push(command);
            return RUN_OK;
        },
        async verify(tool) {
            calls.verified.push(tool);
            return '1.2.3';
        },
    };
    return { deps: { ...base, ...over }, calls };
}

describe('createPerformInstall — run path (package managers, npm i -g)', () => {
    it('runs the command argv and reports the verified version', async () => {
        const { deps: d, calls } = deps();
        const perform = createPerformInstall(d, WIN);
        const outcome = await perform(runCmd());
        expect(calls.run).toEqual([{ command: 'winget', args: ['install', '--id', 'Git.Git'], elevated: false }]);
        expect(outcome).toEqual({ ok: true, version: '1.2.3' });
    });

    it('routes an elevated step through the elevated run', async () => {
        const { deps: d, calls } = deps();
        const perform = createPerformInstall(d, WIN);
        await perform(runCmd({ requiresElevation: true }));
        expect(calls.run[0].elevated).toBe(true);
    });

    it('fails cleanly on a non-zero exit, keeping the reason', async () => {
        const { deps: d } = deps({ run: async () => RUN_FAIL });
        const perform = createPerformInstall(d, WIN);
        const outcome = await perform(runCmd());
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toContain('install failed');
    });

    it('succeeds without a version when there is no verifier', async () => {
        const { deps: d } = deps({ verify: undefined });
        const perform = createPerformInstall(d, WIN);
        expect(await perform(runCmd())).toEqual({ ok: true });
    });
});

describe('createPerformInstall — download path (direct)', () => {
    it('downloads a stable-URL artifact and installs it, no resolve step', async () => {
        const { deps: d, calls } = deps();
        const perform = createPerformInstall(d, WIN);
        const outcome = await perform(downloadCmd());
        expect(calls.resolved).toEqual([]);
        expect(calls.downloaded).toEqual([
            'https://desktop.docker.com/win/main/amd64/Docker Desktop Installer.exe',
        ]);
        expect(calls.installed.map((c) => c.tool)).toEqual(['docker']);
        expect(outcome.ok).toBe(true);
    });

    it('resolves a versioned source before downloading when the URL is null', async () => {
        const { deps: d, calls } = deps();
        const perform = createPerformInstall(d, WIN);
        const outcome = await perform(
            downloadCmd({ tool: 'git', url: null, source: 'git-for-windows', artifact: 'exe' }),
        );
        expect(calls.resolved).toEqual(['git-for-windows']);
        expect(calls.downloaded).toEqual(['https://resolved.example/git-for-windows']);
        expect(outcome.ok).toBe(true);
    });

    it('fails when a versioned source cannot be resolved', async () => {
        const { deps: d } = deps({ resolveDownloadUrl: async () => null });
        const perform = createPerformInstall(d, WIN);
        const outcome = await perform(downloadCmd({ url: null, source: 'php-windows', artifact: 'zip' }));
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toMatch(/resolve/i);
    });

    it('fails when the download fails, without attempting an install', async () => {
        const { deps: d, calls } = deps({ download: async () => ({ ok: false, error: 'HTTP 404' }) });
        const perform = createPerformInstall(d, WIN);
        const outcome = await perform(downloadCmd());
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toContain('404');
        expect(calls.installed).toEqual([]);
    });

    it('fails when the installer artifact exits non-zero', async () => {
        const { deps: d } = deps({ installArtifact: async () => RUN_FAIL });
        const perform = createPerformInstall(d, WIN);
        const outcome = await perform(downloadCmd());
        expect(outcome.ok).toBe(false);
    });

    it('reports a version the verifier read after a direct install', async () => {
        const { deps: d } = deps();
        const perform = createPerformInstall(d, WIN);
        const outcome = await perform(downloadCmd({ tool: 'composer', url: 'https://getcomposer.org/composer-stable.phar', artifact: 'phar', needs: 'php' }));
        expect(outcome).toMatchObject({ ok: true, version: '1.2.3' });
    });
});
