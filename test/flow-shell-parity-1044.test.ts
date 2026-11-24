import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectedGitBash, fancyTermPort, type HostBackend } from '../src/main/fancy-term-port.js';
import { supervisedCommand } from '../src/main/flow-runner.js';
import { ProcessBook } from '../src/main/process-book.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';

/**
 * A FLOW'S COMMAND RUNS AS A KEPT PROCESS DOES (Tynn #1044; reported from beta.65 on Windows). A flow's `genie/terminal_run`
 * of `bash -c "uname"` printed Linux: a bare `bash` was looked up on PATH, where System32 comes before Git, and so started
 * System32\bash.exe, WSL's launcher. A flow and a kept process in the same workspace must start the SAME program with the SAME
 * environment, and on Windows a bare `bash` is Git Bash (the one Terminals open), never WSL's launcher and never a bash.exe
 * planted in the workspace folder. Elsewhere `bash` is left to the OS's own search, as before.
 */

const SYSTEM32_BASH = 'C:\\Windows\\System32\\bash.exe';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

function recordingBackend() {
    const created: Array<{ id: string; shell?: string; args?: string[]; cwd?: string; env?: Record<string, string> }> = [];
    const exits: Array<(id: string, payload: { exitCode: number }) => void> = [];
    const backend: HostBackend = {
        create: (opts) => {
            created.push(opts as never);
            return { id: opts.id, pid: 7000 + created.length, shell: opts.shell ?? '', existing: false, scrollback: '' };
        },
        write: () => true,
        resize: () => true,
        kill: () => true,
        getScrollback: () => '',
        on: ((event: string, listener: never) => { if (event === 'exit') exits.push(listener); return backend; }) as HostBackend['on'],
    };
    return { backend, created, exit: (id: string, exitCode: number) => { for (const l of exits) l(id, { exitCode }); } };
}

/** What a started program is given, without what is minted per pty. */
function launched(c: { shell?: string; args?: string[]; env?: Record<string, string> }) {
    const { GENIE_TERMINAL_ID: _id, ...env } = c.env ?? {};
    return { shell: c.shell, args: c.args, env };
}

describe('a flow’s terminal_run and a kept process start the same program with the same environment (Tynn #1044)', () => {
    let home: string;
    beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'genie2-flow-shell-')); });
    afterEach(async () => { await rm(home, { recursive: true, force: true }); });

    async function both(platform: NodeJS.Platform, ws: { id: string; path: string }, port: { gitBash?: () => string | null; isFile: (p: string) => boolean; env: NodeJS.ProcessEnv }) {
        const f = recordingBackend();
        const pty = fancyTermPort(f.backend, {
            defaultShell: () => ({ command: 'synthetic-shell', args: [] }),
            platform,
            lookup: { platform, env: port.env, isFile: port.isFile },
            ...(port.gitBash ? { gitBash: port.gitBash } : {}),
        });
        const supervisor = new ProcessSupervisor(pty, { now: () => 0, schedule: () => () => {} });
        const envFor = (id: string) => (id === ws.id ? { DB_HOST: '127.0.0.1', DB_PORT: '4104' } : {});
        const book = await ProcessBook.open(home, { supervisor, envFor, asleep: () => false });
        await book.create({ workspaceId: ws.id, workspacePath: ws.path, name: 'probe', command: 'bash -c uname', restart: 'never' });
        const run = supervisedCommand({ supervisor, workspacePath: (id) => (id === ws.id ? ws.path : null), envFor }, { processId: 'flow-run:probe', name: 'flow: probe' });
        const ran = run(ws.id, 'bash -c uname', undefined);
        expect(f.created).toHaveLength(2);
        f.exit(f.created[1]!.id, 0);
        await ran;
        return { kept: launched(f.created[0]!), flow: launched(f.created[1]!) };
    }

    it('Windows: both start Git Bash — not WSL’s System32\\bash.exe, not a bash.exe in the workspace — with the workspace’s service env', async () => {
        const ws = { id: 'ws-win', path: resolve(tmpdir(), 'genie2-flow-shell-ws') };
        const planted = win32.join(ws.path, 'bash.exe');
        const { kept, flow } = await both('win32', ws, {
            env: { PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\Git\\cmd', SystemRoot: 'C:\\Windows' },
            isFile: (p) => p === SYSTEM32_BASH || p === planted,
            gitBash: () => GIT_BASH,
        });
        expect(flow).toEqual(kept);
        expect(flow.shell).toBe(GIT_BASH);
        expect(flow.args).toEqual(['-c', 'uname']);
        expect(flow.env).toMatchObject({ DB_HOST: '127.0.0.1', DB_PORT: '4104' });
    });

    it('Windows with no Git Bash: both fall back to the same PATH lookup, which never looks in the workspace folder', async () => {
        const ws = { id: 'ws-win', path: resolve(tmpdir(), 'genie2-flow-shell-ws') };
        const planted = win32.join(ws.path, 'bash.exe');
        const { kept, flow } = await both('win32', ws, {
            // A relative PATH entry is the working folder by another name: never searched.
            env: { PATH: 'bin;C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
            isFile: (p) => p === SYSTEM32_BASH || p === planted || p === 'bin\\bash.exe',
            gitBash: () => null,
        });
        expect(flow).toEqual(kept);
        expect(flow.shell).toBe(SYSTEM32_BASH);
    });

    it('Linux and macOS: unchanged — `bash` goes to the OS’s own search, and the Git Bash finder is never asked', async () => {
        for (const platform of ['linux', 'darwin'] as const) {
            const ws = { id: 'ws-nix', path: resolve(tmpdir(), 'genie2-flow-shell-nix') };
            let asked = 0;
            const { kept, flow } = await both(platform, ws, { env: { PATH: '/usr/bin:/bin' }, isFile: () => true, gitBash: () => { asked += 1; return GIT_BASH; } });
            expect(flow).toEqual(kept);
            expect(flow.shell).toBe('bash');
            expect(flow.args).toEqual(['-c', 'uname']);
            expect(asked).toBe(0);
        }
    });
});

describe('which Git Bash a bare `bash` starts on Windows (Tynn #1044)', () => {
    const PATH = 'C:\\Windows\\System32;C:\\tools\\git\\cmd';
    const lookup = (files: readonly string[]) => ({ platform: 'win32' as const, env: { PATH, SystemRoot: 'C:\\Windows' }, isFile: (p: string) => files.includes(p) });

    it('the one Terminals detect, first', () => {
        expect(detectedGitBash({ installed: () => GIT_BASH, lookup: lookup([SYSTEM32_BASH, 'C:\\tools\\git\\cmd\\git.exe', 'C:\\tools\\git\\bin\\bash.exe']) })).toBe(GIT_BASH);
    });

    it('else the bash.exe beside the git on PATH (Git installed outside Program Files: C:\\tools\\git, scoop…)', () => {
        expect(detectedGitBash({ installed: () => null, lookup: lookup([SYSTEM32_BASH, 'C:\\tools\\git\\cmd\\git.exe', 'C:\\tools\\git\\bin\\bash.exe']) })).toBe('C:\\tools\\git\\bin\\bash.exe');
    });

    it('else none: no git, or a git with no bash.exe beside it', () => {
        expect(detectedGitBash({ installed: () => null, lookup: lookup([SYSTEM32_BASH]) })).toBeNull();
        expect(detectedGitBash({ installed: () => null, lookup: lookup([SYSTEM32_BASH, 'C:\\tools\\git\\cmd\\git.exe']) })).toBeNull();
    });
});
