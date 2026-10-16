import { describe, expect, it } from 'vitest';
import { shellLaunch } from '../src/core/shell-launch.js';
import { fancyTermPort, type HostBackend } from '../src/main/fancy-term-port.js';
import { moreGenieTools, type TerminalsPort } from '../src/main/mcp-tools-more.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { TerminalHost, type PtyPort } from '../src/main/terminal-host.js';

/**
 * AN AGENT'S TERMINAL COMMAND RUNS LIKE A COMMAND, AND ITS OUTPUT OUTLIVES IT (moic, via the owner, 2026-10-16).
 * `manageTerminals create {command}` split the line into argv and ran the first word directly — no shell — so
 * `cd app && php artisan migrate` handed `&&` to the program as an argument; and the terminal left the host's list
 * the moment the process ended, so `read` refused its id and the output was gone before the agent could see it.
 *
 * So: a command given to `create` runs through the platform's shell (`cmd.exe /d /s /c` on Windows, the login shell
 * with `-lc` elsewhere); a terminal that ends keeps its last output and exit code for `read` (and `list` stays the
 * live terminals, as the host's count and close rely on).
 */

describe('shellLaunch', () => {
    it('Windows: cmd.exe /d /s /c with the line as one argument', () => {
        expect(shellLaunch('win32', () => ({ command: 'pwsh.exe', args: [] }), 'cd app && php artisan migrate')).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c', 'cd app && php artisan migrate'] });
    });
    it('elsewhere: the login shell, -lc, the line as one argument', () => {
        expect(shellLaunch('linux', () => ({ command: '/usr/bin/zsh', args: ['-l'] }), 'cd app && php artisan migrate')).toEqual({ command: '/usr/bin/zsh', args: ['-lc', 'cd app && php artisan migrate'] });
    });
});

function fakeBackend() {
    const created: Array<{ shell?: string; args?: string[] }> = [];
    const backend = {
        create: (opts: { id: string; shell?: string; args?: string[] }) => { created.push(opts); return { id: opts.id, pid: 7000 + created.length, shell: opts.shell ?? '/bin/sh', existing: false, scrollback: '' }; },
        write: () => true, resize: () => true, kill: () => true, getScrollback: () => undefined,
        on: () => backend,
    } as unknown as HostBackend;
    return { backend, created };
}

describe('the port', () => {
    it('a command asked to run through the shell is launched by it; CONTROL: a plain command is still split as before', () => {
        const f = fakeBackend();
        const port = fancyTermPort(f.backend, { defaultShell: () => ({ command: '/bin/bash', args: ['-l'] }), platform: 'linux' });
        port.open({ cwd: '/w', command: 'cd app && php artisan migrate', shell: true });
        port.open({ cwd: '/w', command: 'php artisan serve --port=4101' });
        expect(f.created.map((c) => [c.shell, c.args])).toEqual([
            ['/bin/bash', ['-lc', 'cd app && php artisan migrate']],
            ['php', ['artisan', 'serve', '--port=4101']],
        ]);
    });
});

function scriptedPty() {
    let data: ((id: string, d: string) => void) | null = null;
    let exit: ((id: string, code: number) => void) | null = null;
    let n = 0;
    const live = new Set<string>();
    const opened: Array<{ command?: string; shell?: boolean }> = [];
    const port: PtyPort = {
        open: (o) => { const id = `pty_${++n}`; live.add(id); opened.push({ ...(o.command ? { command: o.command } : {}), ...(o.shell ? { shell: true } : {}) }); return { id, pid: 100 + n, shell: 'sh', scrollback: '' }; },
        write: () => true, resize: () => true, kill: (id) => live.delete(id),
        // The engine forgets a process's scrollback when it ends — the host must not depend on it afterwards.
        scrollback: (id) => (live.has(id) ? '' : undefined),
        onData: (l) => { data = l; return () => {}; },
        onExit: (l) => { exit = l; return () => {}; },
    };
    return { port, opened, say: (id: string, d: string) => data?.(id, d), end: (id: string, code: number) => { live.delete(id); exit?.(id, code); } };
}

describe('a terminal that ends', () => {
    it('keeps its output and exit code for reading; it leaves the live list (CONTROL: an unknown id has nothing)', () => {
        const pty = scriptedPty();
        const host = new TerminalHost(pty.port);
        const t = host.open({ workspaceId: 'example', cwd: '/w', command: 'php artisan migrate' });
        pty.say(t.id, 'Migrating: 2026_10_16_create_deals\n');
        pty.say(t.id, 'Migrated.\n');
        pty.end(t.id, 0);
        expect(host.list().map((x) => x.id)).not.toContain(t.id);
        expect(host.scrollback(t.id)).toBe('Migrating: 2026_10_16_create_deals\nMigrated.\n');
        expect(host.finished(t.id)).toEqual({ workspaceId: 'example', exitCode: 0 });
        expect(host.finished('pty_none')).toBeNull();
        expect(host.scrollback('pty_none')).toBeUndefined();
    });
});

describe('manageTerminals', () => {
    const caller: Caller = { agentId: 'agent_x', agentName: 'atlas', workspaceId: 'example', workspacePath: '/w' } as Caller;
    const tool = (host: TerminalHost) => {
        const terminals: TerminalsPort = {
            list: () => host.list(), open: (o) => host.open(o), write: (id, d) => host.write(id, d),
            scrollback: (id) => host.scrollback(id), finished: (id) => host.finished(id), scrollbackCap: 1_000_000,
        };
        const regs = moreGenieTools({ knowledge: {} as never, terminals, approve: async () => 'allowed', resolveCaller: () => caller } as never);
        const handler = regs.find((r) => r.definition.name === 'manageTerminals')!.handler;
        return async (args: Record<string, unknown>) => {
            const r = await handler(args as never, { server: 'genie', tool: 'manageTerminals', headers: { terminalid: 't' } } as never);
            try { return JSON.parse(r.text); } catch { return { error: r.text }; }
        };
    };

    it('create {command} runs it through the shell, and read after it ends returns its output and exit code', async () => {
        const pty = scriptedPty();
        const host = new TerminalHost(pty.port);
        const call = tool(host);
        const created = await call({ action: 'create', command: 'cd app && php artisan migrate' });
        expect(pty.opened).toEqual([{ command: 'cd app && php artisan migrate', shell: true }]);
        const id = created.terminal.id as string;
        pty.say(id, 'Migrated.\n');
        pty.end(id, 1);
        const read = await call({ action: 'read', id });
        expect(read).toMatchObject({ ok: true, id, text: 'Migrated.\n', exited: true, exitCode: 1 });
    });

    it("CONTROL: another workspace's finished terminal is not readable", async () => {
        const pty = scriptedPty();
        const host = new TerminalHost(pty.port);
        const theirs = host.open({ workspaceId: 'example-other', cwd: '/o', command: 'true' });
        pty.say(theirs.id, 'secret\n');
        pty.end(theirs.id, 0);
        const read = await tool(host)({ action: 'read', id: theirs.id });
        expect(JSON.stringify(read)).not.toContain('secret');
    });
});
