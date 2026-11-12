import { describe, expect, it } from 'vitest';

/*
 * Tynn #698 story 2: A BROKEN AGENT CLI, REPAIRED BY GENIE ITSELF. Genie installed and updated Claude Code and Codex with
 * `npm install -g`, which on npm 12 leaves Claude Code a placeholder (npm skips its postinstall). Both vendors document their
 * own installer, and Anthropic's fix for a broken npm copy is: install with the native installer, then uninstall the npm
 * package (code.claude.com/docs/en/troubleshoot-install, "Fix an npm 12 install"). Codex documents its standalone installer
 * the same way (github.com/openai/codex, README). So Genie installs, updates and repairs them with the vendors' installers,
 * removes a broken npm copy after the installer succeeded, puts the installer's folder on its PATH, and judges the result by
 * checking the CLI again, never by an exit code. Each step is said while it runs.
 */
const plan = async () => { const path: string = '../src/core/cli-repair.js'; return import(path) as Promise<any>; };
const runner = async () => { const path: string = '../src/main/cli-repair.js'; return import(path) as Promise<any>; };
const toolchain = async () => { const path: string = '../src/core/toolchain.js'; return import(path) as Promise<any>; };

const CLAUDE_WIN = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'];
const CLAUDE_LINUX = ['bash', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'];
const CODEX_WIN = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://chatgpt.com/codex/install.ps1 | iex'];
const CODEX_LINUX = ['sh', '-c', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'];

const health = (over: Record<string, unknown>) => ({ provider: 'claude', ok: false, installed: false, signedIn: null, version: null, program: null, fault: 'missing', words: 'w', checkedAt: 1, ...over });
const NPM_CLAUDE_WIN = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const NPM_CODEX_LINUX = '/usr/lib/node_modules/@openai/codex/bin/codex.js';

describe('the vendors\' installers, from Genie\'s own table', () => {
    it('installs Claude Code and Codex with their installers, never npm', async () => {
        const { planInstall } = await toolchain();
        expect(planInstall({ tool: 'claude-code', platform: 'win32', packageManager: 'winget' })).toMatchObject({ argv: CLAUDE_WIN, manager: 'vendor', elevated: false });
        expect(planInstall({ tool: 'claude-code', platform: 'linux', packageManager: null })).toMatchObject({ argv: CLAUDE_LINUX, manager: 'vendor' });
        expect(planInstall({ tool: 'codex', platform: 'win32', packageManager: null })).toMatchObject({ argv: CODEX_WIN, manager: 'vendor' });
        expect(planInstall({ tool: 'codex', platform: 'linux', packageManager: 'apt' })).toMatchObject({ argv: CODEX_LINUX, manager: 'vendor' });
        expect(planInstall({ tool: 'claude-code', platform: 'linux', packageManager: null }).label).toContain('claude.ai/install.sh');
    });

    it('updates Claude Code with `claude update`, Codex with its installer again; macOS is said to be unsupported', async () => {
        const { planUpdate, HOST_TOOLS } = await toolchain();
        expect(planUpdate({ tool: 'claude-code', platform: 'linux', packageManager: 'apt' })).toEqual({ command: 'claude update', manager: 'vendor' });
        expect(planUpdate({ tool: 'codex', platform: 'win32', packageManager: null })).toMatchObject({ argv: CODEX_WIN, manager: 'vendor' });
        expect(planUpdate({ tool: 'codex', platform: 'darwin', packageManager: 'brew' })).toMatchObject({ refused: expect.stringMatching(/macOS/) });
        expect(JSON.stringify(HOST_TOOLS)).not.toMatch(/npm install -g @(anthropic-ai|openai)/);
    });
});

describe('planning a repair from what the health check found', () => {
    it('a broken npm copy: the vendor installer first, then the npm package removed', async () => {
        const { planCliRepair } = await plan();
        const steps = planCliRepair({ provider: 'claude', platform: 'win32', health: health({ fault: 'placeholder', program: NPM_CLAUDE_WIN }) });
        expect(steps.map((s: any) => [s.binary, s.args])).toEqual([[CLAUDE_WIN[0], CLAUDE_WIN.slice(1)], ['npm', ['uninstall', '-g', '@anthropic-ai/claude-code']]]);
        expect(steps[0].label).toMatch(/Claude Code/);
        expect(steps[1].label).toMatch(/npm/);
        const codex = planCliRepair({ provider: 'codex', platform: 'linux', health: health({ provider: 'codex', fault: 'not-runnable', program: NPM_CODEX_LINUX }) });
        expect(codex.map((s: any) => [s.binary, s.args])).toEqual([[CODEX_LINUX[0], CODEX_LINUX.slice(1)], ['npm', ['uninstall', '-g', '@openai/codex']]]);
    });

    it('nothing installed, or a native copy that cannot run: the installer alone', async () => {
        const { planCliRepair } = await plan();
        expect(planCliRepair({ provider: 'claude', platform: 'linux', health: health({ fault: 'missing' }) }).map((s: any) => s.binary)).toEqual(['bash']);
        expect(planCliRepair({ provider: 'claude', platform: 'win32', health: health({ fault: 'wrong-arch', program: 'C:\\Users\\u\\.local\\bin\\claude.exe' }) }).map((s: any) => s.binary)).toEqual(['powershell.exe']);
    });

    it('a CLI that runs is not repaired; signed out is a login, not a repair', async () => {
        const { planCliRepair } = await plan();
        expect(planCliRepair({ provider: 'claude', platform: 'linux', health: health({ ok: true, installed: true, fault: null }) })).toMatchObject({ refused: expect.stringMatching(/runs/) });
        expect(planCliRepair({ provider: 'codex', platform: 'linux', health: health({ provider: 'codex', installed: true, signedIn: false, fault: 'signed-out' }) })).toMatchObject({ refused: expect.stringMatching(/Log in/) });
        expect(planCliRepair({ provider: 'claude', platform: 'darwin', health: health({ fault: 'missing' }) })).toMatchObject({ refused: expect.stringMatching(/macOS/) });
    });
});

/* ------------------------------------------------------------------------------------------------------------------ */

function fakes(opts: { fail?: string; timeout?: string; after?: Record<string, unknown>; nativeOnDisk?: boolean } = {}) {
    const calls: Array<[string, readonly string[], number | undefined]> = [];
    const steps: Array<string | null> = [];
    const env = new Map<string, string>([['PATH', 'C:\\npm;C:\\Windows'], ['USERPROFILE', 'C:\\Users\\u'], ['LOCALAPPDATA', 'C:\\Users\\u\\AppData\\Local'], ['PATHEXT', '.COM;.EXE;.BAT;.CMD']]);
    let checks = 0;
    const ports = {
        platform: 'win32' as const,
        env: { get: (n: string) => env.get(n), set: (n: string, v: string) => { env.set(n, v); } },
        isFile: (p: string) => opts.nativeOnDisk !== false && p.toLowerCase() === 'c:\\users\\u\\.local\\bin\\claude.exe',
        run: async (binary: string, args: readonly string[], options?: { timeoutMs?: number }) => {
            calls.push([binary, args, options?.timeoutMs]);
            const line = args.join(' ');
            if (opts.timeout && line.includes(opts.timeout)) throw Object.assign(new Error('did not answer'), { code: 'ETIMEDOUT' });
            if (opts.fail && line.includes(opts.fail)) return { exitCode: 1, stdout: 'Downloading...\nInstallation failed: checksum mismatch\n', streams: { stdout: '', stderr: '' } };
            return { exitCode: 0, stdout: '', streams: { stdout: '', stderr: '' } };
        },
        refreshPath: async () => {},
        check: async () => {
            checks += 1;
            return checks === 1 ? health({ fault: 'placeholder', program: NPM_CLAUDE_WIN }) : health({ ok: true, installed: true, signedIn: true, fault: null, words: null, version: '2.1.322', ...(opts.after ?? {}) });
        },
        progress: (step: string | null) => { steps.push(step); },
    };
    return { ports, calls, steps, env };
}

describe('running a repair', () => {
    it('runs each step in order, says each one, puts the installer\'s folder on PATH, and ends with the CLI checked again', async () => {
        const { runCliRepair } = await runner();
        const f = fakes();
        const outcome = await runCliRepair('claude', f.ports);
        expect(outcome).toMatchObject({ kind: 'repaired', version: '2.1.322' });
        expect(outcome.words).toMatch(/Claude Code 2\.1\.322/);
        // The installer as its constants; npm through cmd.exe (npm is a batch file on Windows), after the installer.
        expect(f.calls.map(([b, a]) => [b, a])).toEqual([
            [CLAUDE_WIN[0], CLAUDE_WIN.slice(1)],
            ['cmd.exe', ['/d', '/s', '/c', 'npm', 'uninstall', '-g', '@anthropic-ai/claude-code']],
        ]);
        // Every step has a limit; none waits forever.
        for (const [, , timeoutMs] of f.calls) expect(timeoutMs).toBeGreaterThan(0);
        expect(f.steps[0]).toMatch(/Claude Code/);
        expect(f.steps).toContain('Checking that claude answers');
        expect(f.steps.at(-1)).toBeNull();
        expect(f.env.get('PATH')!.split(';')[0]).toBe('C:\\Users\\u\\.local\\bin');
    });

    it('a step that fails stops the repair there: the npm copy is never removed after a failed install', async () => {
        const { runCliRepair } = await runner();
        const f = fakes({ fail: 'install.ps1' });
        const outcome = await runCliRepair('claude', f.ports);
        expect(outcome).toMatchObject({ kind: 'failed' });
        expect(outcome.reason).toMatch(/checksum mismatch/);
        expect(f.calls).toHaveLength(1);
        expect(f.steps.at(-1)).toBeNull();
    });

    it('a step past its limit is said in minutes, and stops the repair', async () => {
        const { runCliRepair } = await runner();
        const f = fakes({ timeout: 'install.ps1' });
        const outcome = await runCliRepair('claude', f.ports);
        expect(outcome).toMatchObject({ kind: 'failed' });
        expect(outcome.reason).toMatch(/did not finish within \d+ minutes/);
    });

    it('steps that all exit 0 are not a repair until the CLI answers: the check after decides', async () => {
        const { runCliRepair } = await runner();
        const f = fakes({ after: { ok: false, installed: false, fault: 'missing', words: 'Claude Code is not installed: there is no `claude` program on this machine\'s PATH', version: null } });
        const outcome = await runCliRepair('claude', f.ports);
        expect(outcome).toMatchObject({ kind: 'failed' });
        expect(outcome.reason).toMatch(/not installed/);
    });

    it('a repair that ends signed out says so: the CLI is fixed, and Log in is next', async () => {
        const { runCliRepair } = await runner();
        const f = fakes({ after: { ok: false, installed: true, signedIn: false, fault: 'signed-out', words: 'Claude Code is not signed in on this machine' } });
        const outcome = await runCliRepair('claude', f.ports);
        expect(outcome).toMatchObject({ kind: 'repaired', signedIn: false });
        expect(outcome.words).toMatch(/Log in/);
    });
});
