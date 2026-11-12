import { describe, expect, it } from 'vitest';

/*
 * Tynn #698 story 1: A PROVIDER CLI'S HEALTH, MEASURED. A user's Toolchain read "claude-code 2.1.316" while `claude` in their
 * terminal printed "claude native binary not installed": npm 12 skips Claude Code's postinstall by default, which leaves
 * `bin/claude.exe` a 500-byte shell-script placeholder (code.claude.com/docs/en/troubleshoot-install, "Native binary not found
 * after npm install"). `--version` alone proves nothing about that, and the agent's "is the provider installed" check was
 * `providerBinary(...) !== null`, which is always true.
 *
 * The health check reads the program the agent would run (the file, not a name on PATH), then runs it for real: its version,
 * and the provider's own no-cost status call (`claude auth status`, `codex login status`: exit 0 = signed in). Each fault has a
 * name and words. Decided from strings, bytes and fake answers, so it holds on any runner.
 */
const load = async () => { const path: string = '../src/core/provider-health.js'; return import(path) as Promise<any>; };
const loadRunner = async () => { const path: string = '../src/main/provider-health.js'; return import(path) as Promise<any>; };

/** The placeholder npm ships as bin/claude.exe until postinstall replaces it (read from the 2.1.322 tarball). */
const PLACEHOLDER = 'echo "Error: claude native binary not installed." >&2\necho "" >&2\necho "Either postinstall did not run (--ignore-scripts, some pnpm configs)" >&2\nexit 1\n';
const text = (s: string) => new TextEncoder().encode(s);
/** A PE image's first bytes: MZ, e_lfanew at 0x3C, "PE\0\0", then the machine. */
function pe(machine: number): Uint8Array {
    const b = new Uint8Array(0x200);
    b[0] = 0x4d; b[1] = 0x5a; b[0x3c] = 0x80;
    b.set([0x50, 0x45, 0, 0], 0x80);
    b[0x84] = machine & 0xff; b[0x85] = machine >> 8;
    return b;
}
/** An ELF image's first bytes: the magic, then e_machine at 18. */
function elf(machine: number): Uint8Array {
    const b = new Uint8Array(64);
    b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    b[18] = machine & 0xff; b[19] = machine >> 8;
    return b;
}
const PE_X64 = 0x8664, PE_ARM64 = 0xaa64, ELF_X64 = 0x3e, ELF_ARM64 = 0xb7;

describe('what a program file is', () => {
    it('tells a native image, its architecture, and the npm placeholder apart', async () => {
        const { programKind } = await load();
        expect(programKind(pe(PE_X64))).toEqual({ kind: 'native', arch: 'x64' });
        expect(programKind(pe(PE_ARM64))).toEqual({ kind: 'native', arch: 'arm64' });
        expect(programKind(elf(ELF_X64))).toEqual({ kind: 'native', arch: 'x64' });
        expect(programKind(elf(ELF_ARM64))).toEqual({ kind: 'native', arch: 'arm64' });
        expect(programKind(text(PLACEHOLDER))).toEqual({ kind: 'placeholder' });
        expect(programKind(text('#!/usr/bin/env node\nimport "./x.js";\n'))).toEqual({ kind: 'script' });
    });
});

describe('judging a provider from what was measured', () => {
    const base = { provider: 'claude', arch: 'x64', checkedAt: 1 };
    const program = (head: Uint8Array, extra: Record<string, unknown> = {}) => ({ path: '/p/claude', exists: true, head, ...extra });
    const ran = (exitCode: number, output: string) => ({ exitCode, output });

    it('is healthy only when the version answers AND the status call says signed in', async () => {
        const { judgeProviderHealth } = await load();
        const h = judgeProviderHealth({ ...base, program: program(elf(ELF_X64)), version: ran(0, '2.1.322 (Claude Code)\n'), status: ran(0, '{"loggedIn": true}') });
        expect(h).toMatchObject({ ok: true, installed: true, signedIn: true, version: '2.1.322', fault: null, words: null, program: '/p/claude' });
    });

    it('names the npm placeholder, and says whether the native package was downloaded at all', async () => {
        const { judgeProviderHealth } = await load();
        const skipped = judgeProviderHealth({ ...base, program: program(text(PLACEHOLDER), { nativePackage: true }), version: null, status: null });
        expect(skipped).toMatchObject({ ok: false, installed: false, fault: 'placeholder', signedIn: null });
        expect(skipped.words).toMatch(/\/p\/claude/);
        expect(skipped.words).toMatch(/npm/);
        expect(skipped.words).toMatch(/setup step|postinstall/);
        const omitted = judgeProviderHealth({ ...base, program: program(text(PLACEHOLDER), { nativePackage: false }), version: null, status: null });
        expect(omitted).toMatchObject({ ok: false, installed: false, fault: 'native-package-missing' });
        expect(omitted.words).toMatch(/not downloaded/);
    });

    it('names a program built for another processor', async () => {
        const { judgeProviderHealth } = await load();
        const h = judgeProviderHealth({ ...base, program: program(pe(PE_ARM64)), version: null, status: null });
        expect(h).toMatchObject({ ok: false, installed: false, fault: 'wrong-arch' });
        expect(h.words).toMatch(/arm64/);
        expect(h.words).toMatch(/x64/);
    });

    it('names a shim that points at nothing, and nothing on PATH', async () => {
        const { judgeProviderHealth } = await load();
        const dangling = judgeProviderHealth({ ...base, program: { path: '/p/lib/claude.exe', via: '/p/bin/claude', exists: false, head: null }, version: null, status: null });
        expect(dangling).toMatchObject({ ok: false, installed: false, fault: 'shim-target-missing' });
        expect(dangling.words).toMatch(/\/p\/bin\/claude/);
        expect(dangling.words).toMatch(/\/p\/lib\/claude\.exe/);
        expect(judgeProviderHealth({ ...base, program: null, version: null, status: null })).toMatchObject({ ok: false, installed: false, fault: 'missing' });
    });

    it('names a program that does not answer its version, in its own words', async () => {
        const { judgeProviderHealth } = await load();
        const h = judgeProviderHealth({ ...base, program: program(elf(ELF_X64)), version: ran(1, 'Error: libstdc++.so.6: cannot open shared object file\n'), status: null });
        expect(h).toMatchObject({ ok: false, installed: false, fault: 'not-runnable' });
        expect(h.words).toMatch(/libstdc\+\+/);
        const gone = judgeProviderHealth({ ...base, program: program(elf(ELF_X64)), version: { exitCode: null, output: '', error: 'ENOENT' }, status: null });
        expect(gone).toMatchObject({ installed: false, fault: 'not-runnable' });
    });

    it('signed out is installed but not ready; a status call that cannot answer claims nothing', async () => {
        const { judgeProviderHealth } = await load();
        const out = judgeProviderHealth({ ...base, program: program(elf(ELF_X64)), version: ran(0, '2.1.322 (Claude Code)'), status: ran(1, '{"loggedIn": false}') });
        expect(out).toMatchObject({ ok: false, installed: true, signedIn: false, fault: 'signed-out', version: '2.1.322' });
        const silent = judgeProviderHealth({ ...base, program: program(elf(ELF_X64)), version: ran(0, '2.1.322 (Claude Code)'), status: { exitCode: null, output: '', error: 'ETIMEDOUT' } });
        expect(silent).toMatchObject({ ok: true, installed: true, signedIn: null, fault: null });
    });
});

/* ------------------------------------------------------------------------------------------------------------------ */

interface Call { binary: string; args: readonly string[] }
function winPorts(files: Record<string, Uint8Array | string>, answers: Record<string, { exitCode: number; stdout: string } | Error> = {}, env: Record<string, string> = {}) {
    const disk = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), typeof v === 'string' ? text(v) : v]));
    const calls: Call[] = [];
    return {
        calls,
        ports: {
            platform: 'win32' as const, arch: 'x64',
            env: { PATH: 'C:\\npm;C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: 'C:\\Users\\u', ...env },
            isFile: (p: string) => disk.has(p.toLowerCase()),
            readText: (p: string) => new TextDecoder().decode(disk.get(p.toLowerCase()) ?? new Uint8Array()),
            readHead: (p: string) => disk.get(p.toLowerCase()) ?? null,
            realpath: (p: string) => p,
            chosen: () => null,
            now: () => 5,
            run: async (binary: string, args: readonly string[]) => {
                calls.push({ binary, args });
                const key = Object.keys(answers).find((k) => args.join(' ').endsWith(k));
                const a = key === undefined ? undefined : answers[key];
                if (a instanceof Error) throw a;
                const r = a ?? { exitCode: 0, stdout: '' };
                return { ...r, streams: { stdout: r.stdout, stderr: '' } };
            },
        },
    };
}
const CLAUDE_EXE = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const CLAUDE_CMD_TEXT = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';

describe('checking a provider on this machine', () => {
    it('Windows, npm 12: reads the placeholder behind claude.cmd and never runs it', async () => {
        const { checkProviderHealth } = await loadRunner();
        const { ports, calls } = winPorts({ 'C:\\npm\\claude.cmd': CLAUDE_CMD_TEXT, [CLAUDE_EXE]: PLACEHOLDER, 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\package.json': '{}' });
        const h = await checkProviderHealth('claude', ports);
        expect(h).toMatchObject({ fault: 'placeholder', installed: false, program: CLAUDE_EXE });
        expect(calls).toEqual([]);
    });

    it('Windows: the placeholder with no native package beside it is the --omit=optional case', async () => {
        const { checkProviderHealth } = await loadRunner();
        const { ports } = winPorts({ 'C:\\npm\\claude.cmd': CLAUDE_CMD_TEXT, [CLAUDE_EXE]: PLACEHOLDER });
        expect(await checkProviderHealth('claude', ports)).toMatchObject({ fault: 'native-package-missing' });
    });

    it('Windows: a working native claude runs its version and its status call, directly', async () => {
        const { checkProviderHealth } = await loadRunner();
        const { ports, calls } = winPorts({ 'C:\\npm\\claude.cmd': CLAUDE_CMD_TEXT, [CLAUDE_EXE]: pe(PE_X64) }, { '--version': { exitCode: 0, stdout: '2.1.322 (Claude Code)\r\n' }, 'auth status': { exitCode: 0, stdout: '{}' } });
        expect(await checkProviderHealth('claude', ports)).toMatchObject({ ok: true, version: '2.1.322', signedIn: true, checkedAt: 5 });
        expect(calls).toEqual([{ binary: CLAUDE_EXE, args: ['--version'] }, { binary: CLAUDE_EXE, args: ['auth', 'status'] }]);
    });

    it('Windows: a codex.cmd whose script is gone points at nothing', async () => {
        const { checkProviderHealth } = await loadRunner();
        const shim = '@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
        const { ports, calls } = winPorts({ 'C:\\npm\\codex.cmd': shim });
        const h = await checkProviderHealth('codex', ports);
        expect(h).toMatchObject({ fault: 'shim-target-missing', installed: false });
        expect(h.words).toMatch(/codex\.cmd/);
        expect(calls).toEqual([]);
    });

    it('Windows: codex through its npm shim runs `codex login status` for the sign-in', async () => {
        const { checkProviderHealth } = await loadRunner();
        const shim = '@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
        const { ports, calls } = winPorts({ 'C:\\npm\\codex.cmd': shim, 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js': '#!/usr/bin/env node\n' }, { '--version': { exitCode: 0, stdout: 'codex-cli 0.167.1\n' }, 'login status': { exitCode: 1, stdout: 'Not logged in\n' } });
        expect(await checkProviderHealth('codex', ports)).toMatchObject({ fault: 'signed-out', installed: true, version: '0.167.1' });
        // Through cmd.exe and the shim, as a person's `codex` runs: npm's shim is a batch file.
        expect(calls.map((c) => [c.binary, c.args.slice(-3).join(' ')])).toEqual([['cmd.exe', 'call C:\\npm\\codex.cmd --version'], ['cmd.exe', 'C:\\npm\\codex.cmd login status']]);
    });

    it('nothing on PATH is missing, and nothing is run', async () => {
        const { checkProviderHealth } = await loadRunner();
        const { ports, calls } = winPorts({});
        expect(await checkProviderHealth('claude', ports)).toMatchObject({ fault: 'missing', installed: false });
        expect(calls).toEqual([]);
    });

    it('an explicit GENIE2_<PROVIDER>_BINARY is the person\'s answer: Genie checks it exists and runs nothing', async () => {
        const { checkProviderHealth } = await loadRunner();
        const { ports, calls } = winPorts({ 'C:\\stubs\\stub-claude.mjs': '#!/usr/bin/env node\n' }, {}, { GENIE2_CLAUDE_BINARY: 'C:\\stubs\\stub-claude.mjs' });
        expect(await checkProviderHealth('claude', ports)).toMatchObject({ ok: true, installed: true, fault: null, program: 'C:\\stubs\\stub-claude.mjs' });
        expect(calls).toEqual([]);
    });

    it('Linux: follows the PATH link to the file, reads its processor', async () => {
        const { checkProviderHealth } = await loadRunner();
        const real = '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
        const disk = new Map<string, Uint8Array>([['/usr/bin/claude', elf(ELF_ARM64)], [real, elf(ELF_ARM64)]]);
        const calls: Call[] = [];
        const ports = {
            platform: 'linux' as const, arch: 'x64', env: { PATH: '/home/u/.local/bin:/usr/bin' },
            isFile: (p: string) => disk.has(p), readText: () => '', readHead: (p: string) => disk.get(p) ?? null,
            realpath: (p: string) => (p === '/usr/bin/claude' ? real : p), chosen: () => null, now: () => 1,
            run: async (binary: string, args: readonly string[]) => { calls.push({ binary, args }); return { exitCode: 0, stdout: '', streams: { stdout: '', stderr: '' } }; },
        };
        expect(await checkProviderHealth('claude', ports)).toMatchObject({ fault: 'wrong-arch', program: real });
        expect(calls).toEqual([]);
    });
});

describe('the book every "is it installed / signed in" question reads', () => {
    it('claims nothing before a check, then answers from the last one', async () => {
        const { ProviderHealthBook } = await loadRunner();
        const results: Record<string, unknown> = {
            claude: { provider: 'claude', ok: false, installed: false, signedIn: null, fault: 'placeholder', words: 'x', version: null, program: 'p', checkedAt: 1 },
            codex: { provider: 'codex', ok: false, installed: true, signedIn: false, fault: 'signed-out', words: 'y', version: '0.1', program: 'q', checkedAt: 1 },
        };
        const book = new ProviderHealthBook(async (p: string) => results[p]);
        expect(book.installed('claude')).toBe(true);
        expect(book.signedIn('claude')).toBe(true);
        expect(book.latest('claude')).toBeNull();
        await book.refreshAll(['claude', 'codex']);
        expect(book.installed('claude')).toBe(false);
        expect(book.installed('codex')).toBe(true);
        expect(book.signedIn('codex')).toBe(false);
        expect(book.latest('claude')).toMatchObject({ fault: 'placeholder' });
    });

    it('a check that throws is recorded as not measured, never as healthy or broken', async () => {
        const { ProviderHealthBook } = await loadRunner();
        const book = new ProviderHealthBook(async () => { throw new Error('boom'); });
        await book.refreshAll(['claude']);
        expect(book.latest('claude')).toBeNull();
        expect(book.installed('claude')).toBe(true);
    });
});
