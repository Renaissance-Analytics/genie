import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../container-runtime';
import type {
    DownloadInstallCommand,
    InstallCommand,
    RunInstallCommand,
    VerifyInstallCommand,
} from '../toolchain-adapters';
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

    it('fails cleanly on a non-zero exit when the tool is still not there', async () => {
        const { deps: d } = deps({ run: async () => RUN_FAIL, verify: async () => undefined });
        const perform = createPerformInstall(d, WIN);
        const outcome = await perform(runCmd());
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toContain('install failed');
    });

    /**
     * genie#209: `winget install` on a package that is already present exits
     * NON-ZERO with "Found an existing package already installed". That is the
     * outcome we wanted — the tool is on the machine — and reporting it as a
     * failure is what skipped claude-code and codex on the owner's fresh box. The
     * exit code is the package manager's opinion; the re-probe is the fact.
     */
    it('treats a non-zero exit as success when the tool verifiably IS there', async () => {
        const alreadyInstalled: CommandResult = {
            code: -1978335135,
            stdout: 'Found an existing package already installed.',
            stderr: '',
        };
        const { deps: d, calls } = deps({ run: async () => alreadyInstalled });
        const perform = createPerformInstall(d, WIN);
        expect(await perform(runCmd({ tool: 'npm' }))).toEqual({ ok: true, version: '1.2.3' });
        expect(calls.verified).toEqual(['npm']);
    });

    it('still fails a non-zero exit with no verifier to appeal to', async () => {
        // Nothing can vouch for the tool, so the exit code stands.
        const { deps: d } = deps({ run: async () => RUN_FAIL, verify: undefined });
        const perform = createPerformInstall(d, WIN);
        expect((await perform(runCmd())).ok).toBe(false);
    });

    it('succeeds without a version when there is no verifier', async () => {
        const { deps: d } = deps({ verify: undefined });
        const perform = createPerformInstall(d, WIN);
        expect(await perform(runCmd())).toEqual({ ok: true });
    });
});

/**
 * The CONFIRM path (genie#209). When an earlier step in the plan already
 * installed the very package this step names — winget's node package IS npm —
 * the executor asks for a confirmation instead of a second install. It is not a
 * free pass: a tool that cannot be found afterwards fails, and says whose install
 * was supposed to have brought it.
 */
describe('createPerformInstall — verify path (a shared package)', () => {
    const verifyCmd = (over: Partial<VerifyInstallCommand> = {}): VerifyInstallCommand => ({
        via: 'verify',
        tool: 'npm',
        coveredBy: 'node',
        label: 'npm (installed with node)',
        requiresElevation: false,
        requiresRestart: false,
        ...over,
    });

    it('confirms the tool without running or downloading anything', async () => {
        const { deps: d, calls } = deps();
        const perform = createPerformInstall(d, WIN);
        expect(await perform(verifyCmd())).toEqual({ ok: true, version: '1.2.3' });
        expect(calls.run).toEqual([]);
        expect(calls.downloaded).toEqual([]);
        expect(calls.verified).toEqual(['npm']);
    });

    it('trusts the covering install when there is no verifier to check with', async () => {
        // Nothing to check against: the covering install reported success and
        // that is all the information there is, so this passes rather than
        // failing a tool on no evidence.
        const { deps: d } = deps({ verify: undefined });
        const perform = createPerformInstall(d, WIN);
        expect(await perform(verifyCmd())).toEqual({ ok: true });
    });

    it('fails, naming the install that should have provided it, when the tool is absent', async () => {
        const { deps: d } = deps({ verify: async () => undefined });
        const perform = createPerformInstall(d, WIN);
        const outcome = await perform(verifyCmd());
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toContain('npm');
        expect(outcome.error).toContain('node');
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
