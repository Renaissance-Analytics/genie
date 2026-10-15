import { describe, expect, it } from 'vitest';
import { planInstall, type PackageManager, type Platform } from '../src/core/toolchain.js';
import { detectPackageManager, installTool, type EnvPort, type ToolchainFs, type ToolchainOpsPorts } from '../src/main/toolchain-ops.js';
import type { CommandRunner } from '../src/main/toolchain-prober.js';

/**
 * T1 — INSTALL A MISSING TOOL (§6.6). Through the package manager Genie 1 used on each platform (winget; Homebrew; apt
 * or dnf behind ONE pkexec prompt), only with the person's consent, and judged by the RE-PROBE after it — never by the
 * package manager's exit code. The runner is a fake: every test COUNTS what would have run, and nothing is spawned.
 */

type Call = [string, readonly string[]];

/** A machine where `tool` answers `--version` only after its install command has run. */
function machine(opts: { platform: Platform; tool: string; banner: string; installedBy: (binary: string, args: readonly string[]) => boolean; exitCode?: number; pm?: PackageManager | null; persistedPath?: string }) {
    const calls: Call[] = [];
    const env = new Map<string, string>([['PATH', opts.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin']]);
    let installed = false;
    const run: CommandRunner = async (binary, args) => {
        calls.push([binary, args]);
        if (opts.installedBy(binary, args)) {
            installed = true;
            return { stdout: 'Successfully installed', exitCode: opts.exitCode ?? 0 };
        }
        if (binary === 'powershell.exe') return { stdout: `${opts.persistedPath ?? ''}\n`, exitCode: 0 };
        const probing = args.includes('--version');
        if (probing && installed) return { stdout: opts.banner, exitCode: 0 };
        throw Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' });
    };
    const envPort: EnvPort = { get: (n) => env.get(n), set: (n, v) => { env.set(n, v); } };
    const fs: ToolchainFs = { exists: () => false, readText: () => null, writeText: () => {}, mkdirp: () => {}, remove: () => {} };
    const steps: Array<string | null> = [];
    const ports: ToolchainOpsPorts = {
        platform: opts.platform,
        run,
        env: envPort,
        fs,
        dataDir: '/data/genie2-toolchain',
        systemRoot: 'C:\\Windows',
        packageManager: async () => (opts.pm === undefined ? ({ win32: 'winget', darwin: 'brew', linux: 'apt' } as const)[opts.platform] : opts.pm),
        progress: (s) => steps.push(s),
    };
    return { calls, ports, env, steps, probes: () => calls.filter(([, a]) => a.includes('--version')).length };
}

describe('the install plan — the package manager per platform, from Genie’s own tables', () => {
    it('winget on Windows, brew on macOS, apt and dnf on Linux behind pkexec; each with its exact argv', () => {
        expect(planInstall({ tool: 'php', platform: 'win32', packageManager: 'winget' })).toEqual({
            argv: ['winget', 'install', '--id', 'PHP.PHP.8.4', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'],
            label: 'winget install --id PHP.PHP.8.4 -e --silent --accept-source-agreements --accept-package-agreements',
            manager: 'winget',
            elevated: false,
        });
        expect(planInstall({ tool: 'php', platform: 'darwin', packageManager: 'brew' })).toMatchObject({ argv: ['brew', 'install', 'php'], manager: 'brew', elevated: false });
        // apt: the index refresh rides in the SAME prompt — one pkexec, not two.
        expect(planInstall({ tool: 'php', platform: 'linux', packageManager: 'apt' })).toMatchObject({ argv: ['pkexec', 'sh', '-c', 'apt-get update && apt-get install -y php'], manager: 'apt', elevated: true });
        expect(planInstall({ tool: 'node', platform: 'linux', packageManager: 'dnf' })).toMatchObject({ argv: ['pkexec', 'dnf', 'install', '-y', 'nodejs'], manager: 'dnf', elevated: true });
    });

    it('agent CLIs install with npm (through cmd.exe on Windows); npm, rustc and an unknown tool are refused with the reason', () => {
        expect(planInstall({ tool: 'claude-code', platform: 'linux', packageManager: 'apt' })).toMatchObject({ argv: ['npm', 'install', '-g', '@anthropic-ai/claude-code'], manager: 'npm' });
        expect(planInstall({ tool: 'codex', platform: 'win32', packageManager: 'winget' })).toMatchObject({ argv: ['cmd.exe', '/d', '/s', '/c', 'npm', 'install', '-g', '@openai/codex'], label: 'npm install -g @openai/codex' });
        expect(planInstall({ tool: 'npm', platform: 'win32', packageManager: 'winget' })).toEqual({ refused: 'npm comes with Node; install node and it is there' });
        expect(planInstall({ tool: 'rustc', platform: 'win32', packageManager: 'winget' })).toMatchObject({ refused: expect.stringContaining('rustup') });
        expect(planInstall({ tool: 'frobnicate', platform: 'linux', packageManager: 'apt' })).toEqual({ refused: 'frobnicate is not a tool Genie manages' });
        expect(planInstall({ tool: 'php', platform: 'linux', packageManager: null })).toEqual({ refused: 'no package manager found on this machine to install php with' });
        // Docker Desktop has no apt row on purpose; the VC++ runtime is Windows-only.
        expect(planInstall({ tool: 'docker', platform: 'linux', packageManager: 'apt' })).toEqual({ refused: 'apt cannot install docker on this machine' });
        expect(planInstall({ tool: 'vcredist', platform: 'win32', packageManager: 'winget' })).toMatchObject({ argv: ['winget', 'install', '--id', 'Microsoft.VCRedist.2015+.x64', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'] });
        expect(planInstall({ tool: 'vcredist', platform: 'linux', packageManager: 'apt' })).toMatchObject({ refused: expect.stringContaining('only needed on win32') });
    });
});

describe('which package manager is here — the one that ANSWERS', () => {
    it('Linux: apt-get when it answers, else dnf, else none; Windows asks winget only', async () => {
        const asked: string[] = [];
        const only = (bin: string): CommandRunner => async (b) => { asked.push(b); if (b === bin) return { stdout: `${bin} 1.0`, exitCode: 0 }; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
        expect(await detectPackageManager('linux', only('dnf'))).toBe('dnf');
        expect(asked).toEqual(['apt-get', 'dnf']);
        expect(await detectPackageManager('linux', only('apt-get'))).toBe('apt');
        expect(await detectPackageManager('linux', only('pacman'))).toBeNull();
        asked.length = 0;
        expect(await detectPackageManager('win32', only('winget'))).toBe('winget');
        expect(asked).toEqual(['winget']);
    });
});

describe('installing — consent, the right manager, and the re-probe', () => {
    for (const [platform, pm, manager] of [['win32', 'winget', 'winget'], ['darwin', 'brew', 'brew'], ['linux', 'apt', 'pkexec'], ['linux', 'dnf', 'pkexec']] as const) {
        it(`${platform}/${pm}: probes once, runs ONE install through ${manager}, re-probes, and reports the version it MEASURED`, async () => {
            const m = machine({ platform, tool: 'php', pm, banner: 'PHP 8.4.13 (cli)', installedBy: (b) => b === manager });
            const r = await installTool('php', true, m.ports);
            expect(r).toEqual({ kind: 'installed', version: '8.4.13' });
            const installs = m.calls.filter(([b]) => b === manager);
            expect(installs).toHaveLength(1);
            expect(m.probes()).toBe(2); // before (absent) and after (present) — COUNTED
            // The order: probe, install, (Windows: re-read the persisted PATH), probe.
            const order = m.calls.map(([b]) => b);
            expect(order[0]).toBe('php');
            expect(order[order.length - 1]).toBe('php');
            expect(m.steps.at(-1)).toBeNull(); // the progress line is cleared
        });
    }

    it('WITHOUT consent nothing is asked of the machine — zero calls — and the refusal says so', async () => {
        const m = machine({ platform: 'win32', tool: 'php', banner: 'PHP 8.4.13', installedBy: (b) => b === 'winget' });
        const r = await installTool('php', false, m.ports);
        expect(r).toEqual({ kind: 'refused', reason: 'Genie installs nothing without your go-ahead; php was not installed' });
        expect(m.calls).toEqual([]);
    });

    it('a manager that exits 0 having installed nothing is reported as NOT installed, with its own words — never as success', async () => {
        const m = machine({ platform: 'win32', tool: 'php', banner: 'PHP 8.4.13', installedBy: () => false });
        // winget "succeeds" but nothing answers afterwards.
        const fake: CommandRunner = async (b, a) => (b === 'winget' ? { stdout: 'No package found matching input criteria.', exitCode: 0 } : m.ports.run(b, a));
        const r = await installTool('php', true, { ...m.ports, run: fake });
        expect(r.kind).toBe('not-installed');
        expect(r).toMatchObject({ reason: expect.stringContaining('No package found matching input criteria.') });
    });

    it('a tool already installed is not installed again (control: one probe, no install)', async () => {
        const m = machine({ platform: 'win32', tool: 'node', banner: 'v22.23.2', installedBy: () => false });
        const run: CommandRunner = async (b, a) => { m.calls.push([b, a]); return { stdout: 'v22.23.2', exitCode: 0 }; };
        const r = await installTool('node', true, { ...m.ports, run });
        expect(r).toEqual({ kind: 'already-installed', version: '22.23.2' });
        expect(m.calls).toEqual([['node', ['--version']]]);
    });

    it('Windows: the PATH winget just persisted is picked up before the re-probe, appended — so the new tool is found', async () => {
        const m = machine({ platform: 'win32', tool: 'php', banner: 'PHP 8.4.13', installedBy: (b) => b === 'winget', persistedPath: 'C:\\Windows\\System32;C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links' });
        await installTool('php', true, m.ports);
        expect(m.env.get('PATH')).toBe('C:\\Windows\\System32;C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links');
        expect(m.calls.filter(([b]) => b === 'powershell.exe')).toHaveLength(1);
    });

    it('the VC++ runtime installs through winget and is judged by its DLLs in System32', async () => {
        const present = new Set<string>();
        const m = machine({ platform: 'win32', tool: 'vcredist', banner: '', installedBy: (b, a) => b === 'winget' && a.includes('Microsoft.VCRedist.2015+.x64') });
        const run: CommandRunner = async (b, a) => {
            const r = await m.ports.run(b, a);
            if (b === 'winget') for (const d of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) present.add(`C:\\Windows\\System32\\${d}`);
            return r;
        };
        const r = await installTool('vcredist', true, { ...m.ports, run, fs: { ...m.ports.fs, exists: (p) => present.has(p) } });
        expect(r).toEqual({ kind: 'installed', version: null });
        expect(m.calls.filter(([b]) => b === 'winget')).toHaveLength(1);
    });
});
