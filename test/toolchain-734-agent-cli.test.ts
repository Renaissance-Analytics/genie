import { describe, expect, it } from 'vitest';

/*
 * Tynn #734: CLAUDE CODE'S UPDATE MUST UPDATE THE CLAUDE THE AGENTS RUN. The owner's Toolchain read `claude-code 2.1.261
 * Not signed in` and Update answered "the update command exited 0 but claude-code still reports 2.1.261", while a Claude agent
 * refused to start for want of 2.1.295. The row's version and Update both went through `cmd.exe … claude` (core/toolchain.ts
 * platformArgv: findBatchFile looks for claude.cmd/.bat ONLY), i.e. the npm copy, wherever it sits on PATH; the agent runs
 * what main/provider-health.ts locateProviderProgram resolves (an .exe or npm shim, PATH order). Two copies on one machine
 * = a row about one claude and an Update on the same wrong one. So: the row reads the version of the program the agent runs,
 * Update runs THAT program's updater (an npm copy is replaced by the native install), and the version is read again from the
 * same resolution. Decided with fakes.
 */
const coreCli = async () => { const path: string = '../src/core/cli-repair.js'; return import(path) as Promise<any>; };
const mainCli = async () => { const path: string = '../src/main/cli-repair.js'; return import(path) as Promise<any>; };
const core = async () => { const path: string = '../src/core/toolchain.js'; return import(path) as Promise<any>; };
const tooOld = async () => { const path: string = '../src/core/claude-cli-version.js'; return import(path) as Promise<any>; };
const healthMain = async () => { const path: string = '../src/main/provider-health.js'; return import(path) as Promise<any>; };

const health = (over: Record<string, unknown>) => ({ provider: 'claude', ok: true, installed: true, signedIn: true, version: '2.1.316', program: NATIVE, fault: null, words: null, checkedAt: 1, ...over });
const NATIVE = 'C:\\Users\\u\\.local\\bin\\claude.exe';
const NPM_COPY = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

describe('the row reads the version of the claude the agents run', () => {
    it('installed comes from the health check of that program, and the badge is judged on it', async () => {
        const { withProviderHealth } = await core();
        // The cmd.exe probe hit the npm claude.cmd (2.1.261); the program the agent runs is 2.1.316.
        const stale = [{ tool: 'claude-code', installed: '2.1.261', latest: '2.1.316', tone: 'update-available', source: 'npm registry' }];
        const [row] = withProviderHealth(stale, [health({ version: '2.1.316' })]);
        expect(row).toMatchObject({ tool: 'claude-code', installed: '2.1.316', tone: 'up-to-date' });
        // Control: a health with no version leaves the probe's answer alone.
        expect(withProviderHealth(stale, [health({ version: null })])[0]).toMatchObject({ installed: '2.1.261', tone: 'update-available' });
    });
});

describe('Update plans from the program the agent runs', () => {
    it('a native claude updates itself: ITS path, `update` — not a bare `claude` through cmd.exe', async () => {
        const { planCliUpdate } = await coreCli();
        const steps = planCliUpdate({ provider: 'claude', platform: 'win32', health: health({ program: NATIVE }) });
        expect(steps).toHaveLength(1);
        expect(steps[0]).toMatchObject({ binary: NATIVE, args: ['update'] });
    });

    it('an npm copy is replaced by the native install, then the npm package is removed (as a repair does)', async () => {
        const { planCliUpdate } = await coreCli();
        const steps = planCliUpdate({ provider: 'claude', platform: 'win32', health: health({ program: NPM_COPY }) });
        expect(steps.map((s: { binary: string }) => s.binary)).toEqual(['powershell.exe', 'npm']);
        expect(steps[1]).toMatchObject({ args: ['uninstall', '-g', '@anthropic-ai/claude-code'] });
    });

    it('Codex updates by its installer; a CLI that cannot run is a Repair, not an Update', async () => {
        const { planCliUpdate } = await coreCli();
        expect(planCliUpdate({ provider: 'codex', platform: 'linux', health: health({ provider: 'codex', program: '/home/u/.local/bin/codex' }) })[0]).toMatchObject({ binary: 'sh' });
        expect(planCliUpdate({ provider: 'claude', platform: 'win32', health: health({ installed: false, fault: 'placeholder' }) })).toMatchObject({ refused: expect.stringContaining('Repair') });
    });
});

describe('Update measures the same program after', () => {
    const ports = (versions: Array<string | null>, ran: Array<[string, readonly string[]]>, exit = 0) => {
        let n = 0;
        return {
            platform: 'win32' as const,
            env: { get: () => undefined, set: () => undefined },
            isFile: () => false,
            run: async (binary: string, args: readonly string[]) => { ran.push([binary, args]); return { exitCode: exit, stdout: '' }; },
            refreshPath: async () => undefined,
            check: async () => health({ program: NATIVE, version: versions[Math.min(n++, versions.length - 1)] }),
            progress: () => undefined,
        };
    };

    it('runs the native program\'s own update, then re-reads its version: repaired 2.1.261 -> 2.1.316', async () => {
        const { runCliUpdate } = await mainCli();
        const ran: Array<[string, readonly string[]]> = [];
        const outcome = await runCliUpdate('claude', ports(['2.1.261', '2.1.316'], ran));
        expect(ran).toEqual([[NATIVE, ['update']]]);
        expect(outcome).toMatchObject({ kind: 'repaired', from: '2.1.261', to: '2.1.316' });
    });

    it('an update that changed nothing is said so, with the version the SAME program reports', async () => {
        const { runCliUpdate } = await mainCli();
        const outcome = await runCliUpdate('claude', ports(['2.1.261', '2.1.261'], []));
        expect(outcome).toMatchObject({ kind: 'unchanged', installed: '2.1.261' });
    });

    it('a step that fails is the outcome, with the exit said', async () => {
        const { runCliUpdate } = await mainCli();
        const outcome = await runCliUpdate('claude', ports(['2.1.261'], [], 1));
        expect(outcome).toMatchObject({ kind: 'unchanged', installed: '2.1.261', reason: expect.stringContaining('exited 1') });
    });
});

describe('the sign-in read runs the agent\'s own program', () => {
    it('`auth status` is run by the native exe first on PATH, never through a bare `claude`', async () => {
        const { checkProviderHealth } = await healthMain();
        const exe = new Uint8Array(0x200); exe[0] = 0x4d; exe[1] = 0x5a; exe[0x3c] = 0x80; exe.set([0x50, 0x45, 0, 0], 0x80); exe[0x84] = 0x64; exe[0x85] = 0x86;
        const calls: Array<[string, readonly string[]]> = [];
        const h = await checkProviderHealth('claude', {
            platform: 'win32', arch: 'x64',
            env: { PATH: 'C:\\Users\\u\\.local\\bin;C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: 'C:\\Users\\u' },
            isFile: (p: string) => p.toLowerCase() === NATIVE.toLowerCase() || p.toLowerCase() === 'c:\\npm\\claude.cmd',
            readText: () => '', readHead: () => exe, realpath: (p: string) => p, chosen: () => null, now: () => 1,
            run: async (binary: string, args: readonly string[]) => { calls.push([binary, args]); const out = args.includes('--version') ? '2.1.316 (Claude Code)' : '{}'; return { exitCode: 0, stdout: out, streams: { stdout: out, stderr: '' } }; },
        });
        expect(calls).toEqual([[NATIVE, ['--version']], [NATIVE, ['auth', 'status']]]);
        expect(h).toMatchObject({ installed: true, signedIn: true, version: '2.1.316', program: NATIVE });
    });
});

describe('the "too old" message offers Genie\'s own Update', () => {
    it('points at Toolchain > Update, and no longer at a command to run by hand', async () => {
        const { CLAUDE_CLI_TOO_OLD } = await tooOld();
        expect(CLAUDE_CLI_TOO_OLD).toContain('Update Claude Code to 2.1.295 or later');
        expect(CLAUDE_CLI_TOO_OLD).toMatch(/Settings.*Toolchain.*Update/);
        expect(CLAUDE_CLI_TOO_OLD).not.toContain('claude update');
    });
});
