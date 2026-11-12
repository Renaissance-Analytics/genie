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

/*
 * Each vendor's documented command, hardened (PR #1881 review). The URLs are the vendors' own: claude.ai/install.sh and
 * claude.ai/install.ps1 (code.claude.com/docs/en/setup, "Native Install"), chatgpt.com/codex/install.sh and install.ps1
 * (github.com/openai/codex, README). The vendor's https domain is trusted; nothing is pinned. Hardened so that a download
 * that fails FAILS THE STEP: POSIX downloads the installer whole to a temporary file, https only and TLS 1.2+, and only then
 * runs it (with `curl … | sh` the shell ran whatever arrived, and a failed download ran an empty script that exited 0).
 * Windows keeps the vendor's `irm … | iex`, with the download made to stop on error and an empty one refused, so
 * powershell.exe exits non-zero instead of running nothing; no double quote, which Node and PowerShell quote differently.
 */
const PS = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const CLAUDE_WIN = [...PS, `$installer = irm https://claude.ai/install.ps1 -ErrorAction Stop; if (-not $installer) { throw 'https://claude.ai/install.ps1 sent nothing' }; $installer | iex`];
const CLAUDE_LINUX = ['bash', '-c', `set -eu; f="$(mktemp)"; trap 'rm -f "$f"' EXIT; curl --proto '=https' --tlsv1.2 -fsSL https://claude.ai/install.sh -o "$f"; bash "$f"`];
const CODEX_WIN = [...PS, `$installer = irm https://chatgpt.com/codex/install.ps1 -ErrorAction Stop; if (-not $installer) { throw 'https://chatgpt.com/codex/install.ps1 sent nothing' }; $installer | iex`];
const CODEX_LINUX = ['sh', '-c', `set -eu; f="$(mktemp)"; trap 'rm -f "$f"' EXIT; curl --proto '=https' --tlsv1.2 -fsSL https://chatgpt.com/codex/install.sh -o "$f"; sh "$f"`];

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

    it('the table holds exactly those commands: no download is piped into a shell, and only the vendor URL differs', async () => {
        const { VENDOR_INSTALLERS } = await toolchain();
        expect(VENDOR_INSTALLERS['claude-code'].linux).toEqual(CLAUDE_LINUX);
        expect(VENDOR_INSTALLERS['claude-code'].win32).toEqual(CLAUDE_WIN);
        expect(VENDOR_INSTALLERS.codex.linux).toEqual(CODEX_LINUX);
        expect(VENDOR_INSTALLERS.codex.win32).toEqual(CODEX_WIN);
        for (const v of Object.values(VENDOR_INSTALLERS) as Array<{ linux: string[]; win32: string[] }>) {
            expect(v.linux.at(-1)).not.toMatch(/\|\s*(ba)?sh\b/);
            expect(v.linux.at(-1)).toContain("--proto '=https' --tlsv1.2");
            expect(v.win32.at(-1)).not.toContain('"');
        }
    });

    // The shell itself runs the command, with `curl` replaced by a stand-in on PATH (no network): a download that fails, or
    // is cut short, fails the step and runs nothing; a whole one runs. Red against `curl … | sh`: the empty pipe exits 0.
    it.skipIf(process.platform === 'win32')('POSIX: a failed or cut-short download fails the step and runs nothing; a whole one runs', async () => {
        const { VENDOR_INSTALLERS } = await toolchain();
        const { chmodSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
        const { spawnSync } = await import('node:child_process');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const bin = mkdtempSync(join(tmpdir(), 'genie-fake-curl-'));
        try {
            writeFileSync(join(bin, 'curl'), [
                '#!/bin/sh',
                'out=""',
                'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done',
                // `curl -f` on a 404 writes nothing and exits 22.
                'if [ "${FAKE_CURL:-}" = fail ]; then exit 22; fi',
                'echo "echo ran-installer" > "$out"',
                // A transfer cut short: part of the file is there, and curl exits 18.
                'if [ "${FAKE_CURL:-}" = partial ]; then exit 18; fi',
                '',
            ].join('\n'));
            chmodSync(join(bin, 'curl'), 0o755);
            const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
            for (const tool of ['claude-code', 'codex']) {
                const [binary, ...args] = VENDOR_INSTALLERS[tool].linux as string[];
                const failed = spawnSync(binary!, args, { env: { ...env, FAKE_CURL: 'fail' }, encoding: 'utf8', input: '' });
                expect([tool, failed.status, failed.stdout]).toEqual([tool, 22, '']);
                const partial = spawnSync(binary!, args, { env: { ...env, FAKE_CURL: 'partial' }, encoding: 'utf8', input: '' });
                expect([tool, partial.status, partial.stdout]).toEqual([tool, 18, '']);
                const whole = spawnSync(binary!, args, { env, encoding: 'utf8', input: '' });
                expect([tool, whole.status, whole.stdout]).toEqual([tool, 0, 'ran-installer\n']);
            }
        } finally {
            rmSync(bin, { recursive: true, force: true });
        }
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
